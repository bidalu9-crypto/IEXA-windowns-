import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';

export type TerminalShell = 'cmd' | 'powershell' | 'bash' | 'wsl';

interface TerminalChunk {
  seq: number;
  text: string;
}

interface TerminalSessionRecord {
  id: string;
  shell: TerminalShell;
  cwd: string;
  child: ChildProcess;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
  chunks: TerminalChunk[];
  outputBytes: number;
  nextSeq: number;
}

export interface TerminalSessionInfo {
  id: string;
  shell: TerminalShell;
  cwd: string;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
  running: boolean;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SESSIONS = 12;

/**
 * Persistent shell processes for the desktop terminal workbench. The process
 * owns its cwd and environment, so state such as `cd`, variables and activated
 * virtual environments remains available across commands in one session.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSessionRecord>();

  create(cwd: string, requestedShell?: string): TerminalSessionInfo {
    this.trimSessions();
    const shell = this.resolveShell(requestedShell);
    const command = this.commandFor(shell);
    const child = spawn(command.file, command.args, {
      cwd,
      env: { ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: 'pipe',
    });
    const record: TerminalSessionRecord = {
      id: crypto.randomUUID(), shell, cwd, child, createdAt: Date.now(), chunks: [], outputBytes: 0, nextSeq: 1,
    };
    this.sessions.set(record.id, record);
    child.stdout?.on('data', (value: Buffer) => this.append(record, value));
    child.stderr?.on('data', (value: Buffer) => this.append(record, value));
    child.on('error', (error) => this.append(record, `\n[终端启动失败：${error.message}]\n`));
    child.on('close', (code) => {
      record.endedAt = Date.now();
      record.exitCode = code;
      this.append(record, `\n[终端会话已结束，退出码：${code ?? -1}]\n`);
    });
    return this.info(record);
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((record) => this.info(record)).sort((a, b) => b.createdAt - a.createdAt);
  }

  output(id: string, after = 0): { chunks: TerminalChunk[]; lastSeq: number; running: boolean } {
    const record = this.get(id);
    const sequence = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
    return {
      chunks: record.chunks.filter((chunk) => chunk.seq > sequence),
      lastSeq: record.nextSeq - 1,
      running: !record.endedAt,
    };
  }

  write(id: string, input: string, appendNewline = false): void {
    const record = this.get(id);
    if (record.endedAt || !record.child.stdin?.writable) throw new Error('终端会话已结束。');
    const value = String(input || '');
    if (!value || value.length > 100_000) throw new Error('终端输入不能为空且不能超过 100000 个字符。');
    record.child.stdin.write(appendNewline ? `${value.replace(/\r?\n$/, '')}\r\n` : value);
  }

  terminate(id: string): void {
    const record = this.get(id);
    if (record.endedAt || !record.child.pid) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(record.child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      record.child.kill('SIGTERM');
    }
  }

  private get(id: string): TerminalSessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new Error('未找到终端会话。');
    return record;
  }

  private append(record: TerminalSessionRecord, value: Buffer | string): void {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    const size = Buffer.byteLength(text);
    record.chunks.push({ seq: record.nextSeq++, text });
    record.outputBytes += size;
    while (record.outputBytes > MAX_OUTPUT_BYTES && record.chunks.length > 1) {
      const removed = record.chunks.shift()!;
      record.outputBytes -= Buffer.byteLength(removed.text);
    }
  }

  private info(record: TerminalSessionRecord): TerminalSessionInfo {
    return {
      id: record.id, shell: record.shell, cwd: record.cwd, createdAt: record.createdAt,
      endedAt: record.endedAt, exitCode: record.exitCode, running: !record.endedAt,
    };
  }

  private resolveShell(value?: string): TerminalShell {
    const requested = String(value || '').toLowerCase();
    if (requested === 'cmd' || requested === 'powershell' || requested === 'bash' || requested === 'wsl') return requested;
    return process.platform === 'win32' ? 'powershell' : 'bash';
  }

  private commandFor(shell: TerminalShell): { file: string; args: string[] } {
    if (shell === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/q'] };
    if (shell === 'powershell') return { file: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'] };
    if (shell === 'wsl') return process.platform === 'win32'
      ? { file: 'wsl.exe', args: ['--shell-type', 'login'] }
      : { file: 'bash', args: ['--noprofile', '--norc', '-i'] };
    const gitBash = process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : '';
    return { file: process.platform === 'win32' && gitBash ? gitBash : 'bash', args: ['--noprofile', '--norc', '-i'] };
  }

  private trimSessions(): void {
    const stale = [...this.sessions.values()].filter((record) => record.endedAt).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    while (this.sessions.size >= MAX_SESSIONS && stale.length) this.sessions.delete(stale.shift()!.id);
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('终端会话数量已达上限，请先停止一个会话。');
  }
}
