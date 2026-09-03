import * as crypto from 'crypto';
import { IPty, spawn as spawnPty } from 'node-pty';

export type TerminalShell = 'cmd' | 'powershell' | 'bash' | 'wsl';

interface TerminalChunk {
  seq: number;
  text: string;
}

interface TerminalSessionRecord {
  id: string;
  shell: TerminalShell;
  cwd: string;
  pty: IPty;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
  chunks: TerminalChunk[];
  outputBytes: number;
  nextSeq: number;
  cols: number;
  rows: number;
}

export interface TerminalSessionInfo {
  id: string;
  shell: TerminalShell;
  cwd: string;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
  running: boolean;
  cols: number;
  rows: number;
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
    const cols = 120; const rows = 32;
    const env = Object.fromEntries(Object.entries({ ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const pty = spawnPty(command.file, command.args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: process.platform === 'win32' });
    const record: TerminalSessionRecord = {
      id: crypto.randomUUID(), shell, cwd, pty, createdAt: Date.now(), chunks: [], outputBytes: 0, nextSeq: 1, cols, rows,
    };
    this.sessions.set(record.id, record);
    pty.onData((value) => this.append(record, value));
    pty.onExit(({ exitCode }) => {
      record.endedAt = Date.now();
      record.exitCode = exitCode;
      this.append(record, `\n[终端会话已结束，退出码：${exitCode ?? -1}]\n`);
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
    if (record.endedAt) throw new Error('终端会话已结束。');
    const value = String(input || '');
    if (!value || value.length > 100_000) throw new Error('终端输入不能为空且不能超过 100000 个字符。');
    record.pty.write(appendNewline ? `${value.replace(/\r?\n$/, '')}\r` : value);
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.get(id);
    if (record.endedAt) return;
    record.cols = Math.max(20, Math.min(500, Math.floor(cols)));
    record.rows = Math.max(5, Math.min(300, Math.floor(rows)));
    record.pty.resize(record.cols, record.rows);
  }

  terminate(id: string): void {
    const record = this.get(id);
    if (record.endedAt) return;
    record.pty.kill();
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
      endedAt: record.endedAt, exitCode: record.exitCode, running: !record.endedAt, cols: record.cols, rows: record.rows,
    };
  }

  private resolveShell(value?: string): TerminalShell {
    const requested = String(value || '').toLowerCase();
    if (requested === 'cmd' || requested === 'powershell' || requested === 'bash' || requested === 'wsl') return requested;
    return process.platform === 'win32' ? 'powershell' : 'bash';
  }

  private commandFor(shell: TerminalShell): { file: string; args: string[] } {
    if (shell === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/q'] };
    // ConPTY already provides an interactive stdin. Passing `-Command -`
    // makes Windows PowerShell expect redirected standard input and print its
    // usage text instead of opening a usable prompt. Start it interactively;
    // subsequent commands are written through IPty.write().
    if (shell === 'powershell') return { file: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit'] };
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
