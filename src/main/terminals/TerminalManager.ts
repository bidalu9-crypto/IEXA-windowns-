import * as crypto from 'crypto';
import { ChildProcess, spawn } from 'child_process';
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
  stopping?: boolean;
  dataSubscription?: { dispose(): void };
  exitSubscription?: { dispose(): void };
  exitWaiters: Array<() => void>;
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
const MAX_ENDED_SESSION_HISTORY = 20;

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
    const pty = spawnPty(command.file, command.args, {
      name: 'xterm-256color', cols, rows, cwd, env,
      useConpty: process.platform === 'win32',
    });
    const record: TerminalSessionRecord = {
      id: crypto.randomUUID(), shell, cwd, pty, createdAt: Date.now(), chunks: [], outputBytes: 0, nextSeq: 1, cols, rows,
      exitWaiters: [],
    };
    this.sessions.set(record.id, record);
    record.dataSubscription = pty.onData((value) => this.append(record, value));
    record.exitSubscription = pty.onExit(({ exitCode }) => this.finalize(record, exitCode));
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
    if (record.endedAt !== undefined || record.stopping) throw new Error('终端会话已结束。');
    const value = String(input || '');
    if (!value || value.length > 100_000) throw new Error('终端输入不能为空且不能超过 100000 个字符。');
    record.pty.write(appendNewline ? `${value.replace(/\r?\n$/, '')}\r` : value);
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.get(id);
    if (record.endedAt !== undefined || record.stopping) return;
    record.cols = Math.max(20, Math.min(500, Math.floor(cols)));
    record.rows = Math.max(5, Math.min(300, Math.floor(rows)));
    record.pty.resize(record.cols, record.rows);
  }

  async terminate(id: string): Promise<void> {
    const record = this.get(id);
    await this.terminateRecord(record);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((record) => this.terminateRecord(record)));
    this.sessions.clear();
  }

  shutdownSync(): void {
    for (const record of this.sessions.values()) {
      if (record.endedAt === undefined) {
        record.stopping = true;
        killPtyWithoutConsoleEnumeration(record.pty);
      }
      record.dataSubscription?.dispose();
      record.exitSubscription?.dispose();
      record.exitWaiters.splice(0).forEach((resolve) => resolve());
    }
    this.sessions.clear();
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
      endedAt: record.endedAt, exitCode: record.exitCode, running: record.endedAt === undefined && !record.stopping, cols: record.cols, rows: record.rows,
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
    const stale = [...this.sessions.values()].filter((record) => record.endedAt !== undefined).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    while (stale.length > MAX_ENDED_SESSION_HISTORY) {
      const record = stale.shift()!;
      record.dataSubscription?.dispose();
      record.exitSubscription?.dispose();
      this.sessions.delete(record.id);
    }
  }

  private async terminateRecord(record: TerminalSessionRecord): Promise<void> {
    if (record.endedAt !== undefined) return;
    if (record.stopping) {
      await new Promise<void>((resolve) => record.exitWaiters.push(resolve));
      return;
    }
    record.stopping = true;
    const exited = new Promise<void>((resolve) => record.exitWaiters.push(resolve));
        killPtyWithoutConsoleEnumeration(record.pty);
    const exitedNormally = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    // node-pty owns the ConPTY teardown path. Starting taskkill at the same
    // time races its console-list helper and produces AttachConsole failures.
    // Use tree termination only when node-pty did not exit in the grace period.
    if (!exitedNormally && record.endedAt === undefined && process.platform === 'win32') {
      await killWindowsTree(record.pty.pid).catch(() => {});
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    }
    if (record.endedAt === undefined) this.finalize(record, -1);
  }

  private finalize(record: TerminalSessionRecord, exitCode: number | null): void {
    if (record.endedAt !== undefined) return;
    record.endedAt = Date.now();
    record.exitCode = exitCode;
    record.stopping = false;
    this.append(record, `\n[终端会话已结束，退出码：${exitCode ?? -1}]\n`);
    record.dataSubscription?.dispose();
    record.exitSubscription?.dispose();
    record.dataSubscription = undefined;
    record.exitSubscription = undefined;
    record.exitWaiters.splice(0).forEach((resolve) => resolve());
  }
}

/**
 * node-pty's public Windows kill() forks conpty_console_list_agent.js before
 * killing the pseudo-console. That extra process races shell teardown on
 * current Node/Windows builds. Use the already-created native agent and close
 * its sockets directly; this is the same native teardown without enumeration.
 */
function killPtyWithoutConsoleEnumeration(pty: IPty): void {
  const terminal = pty as IPty & { _agent?: {
    _useConpty?: boolean;
    _useConptyDll?: boolean;
    _ptyNative?: { kill(pty: unknown, useConptyDll?: boolean): void };
    _pty?: unknown;
    _inSocket?: { readable?: boolean; destroy(): void };
    _outSocket?: { readable?: boolean; destroy(): void };
    _conoutSocketWorker?: { dispose(): void };
  } };
  const agent = terminal._agent;
  if (!agent || !agent._useConpty || !agent._ptyNative || agent._pty === undefined) {
    try { pty.kill(); } catch {}
    return;
  }
  try { if (agent._inSocket) agent._inSocket.readable = false; } catch {}
  try { if (agent._outSocket) agent._outSocket.readable = false; } catch {}
  try { agent._ptyNative.kill(agent._pty, agent._useConptyDll); } catch {}
  try { agent._conoutSocketWorker?.dispose(); } catch {}
  try { agent._inSocket?.destroy(); } catch {}
  try { agent._outSocket?.destroy(); } catch {}
}

function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => { try { child?.kill(); } catch {}; finish(); }, 2000);
    try {
      child = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      child.once('error', finish);
      child.once('close', finish);
    } catch { finish(); }
  });
}
