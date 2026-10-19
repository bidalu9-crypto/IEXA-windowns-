import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { TerminalManager, TerminalSessionInfo, TerminalShell } from '../terminals/TerminalManager';
import type { ToolExecutionResult } from '../providers/types';

const MAX_MARKER_OUTPUT_CHARS = 120_000;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 900;

/**
 * ConPTY/xterm streams carry cursor moves, erase sequences and OSC titles.
 * Agents need the text, not the terminal's painting instructions.
 */
export function stripTerminalControl(value: string): string {
  return String(value || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export interface ParsedSessionOutput {
  found: boolean;
  /** Text between the begin marker and the end marker, before echo removal. */
  lines: string[];
  exitCode: number | null;
}

/**
 * Locate the marker pair. Both markers are printed by the shell *and* echoed
 * back by the tty, so neither may be matched with a plain includes(): the echo
 * line starts with the prompt or with `Write-Output`, while the real output
 * line starts with the token itself.
 */
export function parseSessionOutput(raw: string, beginToken: string, endToken: string): ParsedSessionOutput {
  const text = stripTerminalControl(raw).replace(/\r\n/g, '\n').replace(/\r(?!\n)/g, '\n');
  const lines = text.split('\n');
  let endIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trimStart().startsWith(endToken)) { endIndex = index; break; }
  }
  if (endIndex < 0) return { found: false, lines: [], exitCode: null };
  let beginIndex = -1;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    if (lines[index].trimStart().startsWith(beginToken)) { beginIndex = index; break; }
  }
  if (beginIndex < 0) return { found: false, lines: [], exitCode: null };
  const tail = lines[endIndex].trim().slice(endToken.length).trim();
  return {
    found: true,
    lines: lines.slice(beginIndex + 1, endIndex),
    exitCode: /^-?\d+$/.test(tail) ? Number(tail) : null,
  };
}

/**
 * The tty echoes every submitted line ahead of its output, with the prompt
 * glued to the first one (`PS E:\x>` or `E:\x>`). Drop exactly those lines;
 * anything that merely resembles the command later in the output is kept.
 */
export function stripCommandEcho(lines: string[], command: string): string[] {
  const submitted = command.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''));
  if (!submitted.length || !submitted[0]) return lines;
  const first = submitted[0];
  let index = -1;
  for (let candidate = 0; candidate < Math.min(3, lines.length); candidate += 1) {
    if (lines[candidate].replace(/\s+$/, '').endsWith(first)) { index = candidate; break; }
  }
  if (index < 0) return lines;
  let cursor = index + 1;
  for (let part = 1; part < submitted.length; part += 1) {
    if (cursor >= lines.length) break;
    const expected = submitted[part];
    if (!expected || lines[cursor].replace(/\s+$/, '') === expected) cursor += 1;
    else break;
  }
  return lines.slice(cursor);
}

function hasEndMarker(raw: string, endToken: string): boolean {
  return stripTerminalControl(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some(line => line.trimStart().startsWith(endToken));
}

function markerCommands(shell: TerminalShell): { begin: (token: string) => string; end: (token: string) => string } {
  if (shell === 'cmd') {
    return {
      begin: token => `echo __IEXA_BEGIN_${token}__`,
      end: token => `echo __IEXA_END_${token}__%ERRORLEVEL%`,
    };
  }
  if (shell === 'powershell') {
    return {
      begin: token => `Write-Output "__IEXA_BEGIN_${token}__"`,
      end: token => `Write-Output "__IEXA_END_${token}__$LASTEXITCODE"`,
    };
  }
  return {
    begin: token => `echo '__IEXA_BEGIN_${token}__'`,
    end: token => `echo "__IEXA_END_${token}__$?"`,
  };
}

interface OwnedSession {
  info: TerminalSessionInfo;
  cursor: number;
  owner: string;
}

/** Task-center projection; never carries the tty buffer. */
export interface ShellSessionSummary {
  id: string;
  shell: TerminalShell;
  cwd: string;
  running: boolean;
  createdAt: number;
  endedAt?: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Persistent shells for the agent. `shell_execute` starts a new process per
 * call, so every multi-step task has to re-establish cwd, virtualenv and
 * variables. A session keeps one tty alive; commands are framed by marker
 * lines so completion and exit codes are observable without parsing prompts.
 */
export class ShellSessionTools {
  private readonly manager: TerminalManager;
  private readonly sessions = new Map<string, OwnedSession>();

  constructor(private readonly workspaceDir: string, manager?: TerminalManager) {
    this.manager = manager || new TerminalManager(4);
  }

  private owned(id: string, owner: string, allowEnded = false): OwnedSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`未找到终端会话 ${id || '(空)'}。先调用 shell_session action=open。`);
    if (session.owner !== owner) throw new Error('该终端会话属于另一个对话，不能跨会话操作。');
    if (!allowEnded && session.info.endedAt !== undefined) throw new Error('该终端会话已结束。请重新 open。');
    return session;
  }

  private async writeLine(id: string, line: string): Promise<void> {
    // TerminalManager rejects empty writes; a single space is still an Enter
    // for the shell and is what closes a pending PowerShell block.
    this.manager.write(id, line.length ? line : ' ', true);
  }

  private async runCommand(session: OwnedSession, command: string, timeoutSec: number): Promise<ToolExecutionResult> {
    const token = randomUUID().replace(/-/g, '').slice(0, 10);
    const beginToken = `__IEXA_BEGIN_${token}__`;
    const endToken = `__IEXA_END_${token}__`;
    const markers = markerCommands(session.info.shell);
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(1, timeoutSec), MAX_TIMEOUT_SEC) * 1000;

    await this.writeLine(session.info.id, markers.begin(token));
    for (const line of command.replace(/\r\n/g, '\n').split('\n')) await this.writeLine(session.info.id, line);
    // A blank line closes any multi-line block still open in PowerShell.
    await this.writeLine(session.info.id, '');
    await this.writeLine(session.info.id, markers.end(token));

    let buffer = '';
    let lastSeq = session.cursor;
    let done = false;
    while (Date.now() - started < timeoutMs) {
      const slice = this.manager.output(session.info.id, lastSeq);
      lastSeq = slice.lastSeq;
      if (slice.chunks.length) {
        buffer += slice.chunks.map(chunk => chunk.text).join('');
        if (buffer.length > MAX_MARKER_OUTPUT_CHARS * 2) buffer = buffer.slice(-MAX_MARKER_OUTPUT_CHARS * 2);
      }
      if (hasEndMarker(buffer, endToken)) { done = true; break; }
      if (!slice.running) break;
      await sleep(60);
    }
    session.cursor = lastSeq;

    const raw = buffer;
    const parsed = parseSessionOutput(raw, beginToken, endToken);
    const cleaned = stripCommandEcho(parsed.lines, command);
    // The submitted end command is echoed just before its own output; the
    // marker line itself is already outside the slice.
    while (cleaned.length && cleaned[cleaned.length - 1].includes(endToken)) cleaned.pop();
    const body = parsed.found ? cleaned.join('\n').replace(/^\n+/, '').trimEnd() : '';
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (!parsed.found && !done) {
      const partial = stripTerminalControl(raw).replace(/\r\n/g, '\n').replace(/\r(?!\n)/g, '\n').trim();
      return {
        output: `命令在 ${timeoutSec}s 内未返回完成标记（可能仍在运行或进入了交互程序）。\n会话 ${session.info.id} 保持打开，可稍后用 action=read 取后续输出，或 action=close 结束。\n\n已收到的输出：\n${partial.slice(-4000) || '(无)'}`,
        success: false,
        metadata: { sessionId: session.info.id, timedOut: true, elapsedSec: Number(elapsed) },
      };
    }

    const text = body || '(无输出)';
    const capped = text.length > MAX_MARKER_OUTPUT_CHARS
      ? `${text.slice(0, 60_000)}\n\n[... 输出共 ${text.length} 字符，中间 ${text.length - 90_000} 字符省略 ...]\n\n${text.slice(-30_000)}`
      : text;
    return {
      output: `${capped}\n\n[${session.info.shell} · ${session.info.id.slice(0, 8)} · exit ${parsed.exitCode ?? '未知'} · ${elapsed}s]`,
      success: parsed.exitCode === null || parsed.exitCode === 0,
      metadata: { sessionId: session.info.id, exitCode: parsed.exitCode, elapsedSec: Number(elapsed) },
    };
  }

  async execute(action: string, args: Record<string, unknown>, owner: string, signal?: AbortSignal, defaultCwd?: string): Promise<ToolExecutionResult> {
    try {
      switch (action) {
        case 'open': {
          const requested = String(args.shell || 'auto').toLowerCase();
          const shell = ['cmd', 'powershell', 'bash', 'wsl'].includes(requested) ? requested : undefined;
          const rawCwd = String(args.cwd || '').trim();
          const base = defaultCwd || this.workspaceDir;
          const cwd = rawCwd ? path.resolve(base, rawCwd) : base;
          if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { output: `目录不存在：${cwd}`, success: false };
          const running = [...this.sessions.values()].filter(item => item.info.running).length;
          if (running >= 4) return { output: '终端会话上限为 4 个。先 close 不用的会话。', success: false };
          const info = this.manager.create(cwd, shell);
          this.sessions.set(info.id, { info, cursor: 0, owner });
          return {
            output: `已打开持久终端。\nid: ${info.id}\nshell: ${info.shell}\ncwd: ${info.cwd}\n\n这个会话里的 cd、环境变量和激活的虚拟环境会在后续 send 中保留。`,
            success: true,
            metadata: { sessionId: info.id, shell: info.shell, cwd: info.cwd },
          };
        }
        case 'send': {
          const id = String(args.session_id || '').trim();
          const command = String(args.command || '');
          if (!command.trim()) return { output: 'command 不能为空。', success: false };
          if (command.length > 90_000) return { output: 'command 过长（上限 90000 字符）；请写入脚本文件再执行。', success: false };
          const session = this.owned(id, owner);
          if (signal?.aborted) return { output: '已取消，命令可能仍在会话中运行；用 action=read 取输出。', success: false, cancelled: true };
          return await this.runCommand(session, command, Number(args.timeout) || DEFAULT_TIMEOUT_SEC);
        }
        case 'read': {
          const session = this.owned(String(args.session_id || '').trim(), owner, true);
          const slice = this.manager.output(session.info.id, session.cursor);
          session.cursor = slice.lastSeq;
          const text = stripTerminalControl(slice.chunks.map(chunk => chunk.text).join(''))
            .replace(/\r\n/g, '\n').replace(/\r(?!\n)/g, '\n').trim();
          return {
            output: text || '(没有新的输出)',
            success: true,
            metadata: { sessionId: session.info.id, running: slice.running },
          };
        }
        case 'close': {
          const session = this.owned(String(args.session_id || '').trim(), owner, true);
          if (session.info.endedAt === undefined) await this.manager.terminate(session.info.id);
          this.sessions.delete(session.info.id);
          return { output: `已结束终端会话 ${session.info.id}。`, success: true };
        }
        case 'list': {
          const rows = [...this.sessions.values()].filter(item => item.owner === owner).map(item =>
            `- ${item.info.id} · ${item.info.shell} · ${item.info.cwd} · ${item.info.running ? '运行中' : '已结束'}`);
          return { output: rows.length ? rows.join('\n') : '(当前对话没有打开的终端会话)', success: true };
        }
        default:
          return { output: `未知 action: ${action}。可用 open / send / read / close / list。`, success: false };
      }
    } catch (error) {
      return { output: `shell_session 失败：${(error as Error).message}`, success: false };
    }
  }

  /**
   * Read-only projection for the task center. The owner check keeps one
   * conversation (or a paired phone) from enumerating another's tty.
   */
  summaries(owner: string): ShellSessionSummary[] {
    return [...this.sessions.values()]
      .filter(item => item.owner === owner)
      .sort((a, b) => b.info.createdAt - a.info.createdAt)
      .map(item => ({
        id: item.info.id,
        shell: item.info.shell,
        cwd: item.info.cwd,
        running: item.info.running,
        createdAt: item.info.createdAt,
        endedAt: item.info.endedAt,
      }));
  }

  /** Close from the UI; reuses the same execute path, so owner checks apply. */
  close(id: string, owner: string): Promise<ToolExecutionResult> {
    return this.execute('close', { session_id: id }, owner);
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
    await this.manager.shutdown();
  }

  shutdownSync(): void {
    this.sessions.clear();
    this.manager.shutdownSync();
  }
}
