"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalManager = exports.DEFAULT_MAX_ACTIVE_TERMINALS = void 0;
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const node_pty_1 = require("node-pty");
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ENDED_SESSION_HISTORY = 20;
exports.DEFAULT_MAX_ACTIVE_TERMINALS = 8;
const MAX_OUTPUT_CHUNKS = 4096;
/**
 * Persistent shell processes for the desktop terminal workbench. The process
 * owns its cwd and environment, so state such as `cd`, variables and activated
 * virtual environments remains available across commands in one session.
 */
class TerminalManager {
    maxActive;
    sessions = new Map();
    constructor(maxActive = exports.DEFAULT_MAX_ACTIVE_TERMINALS) {
        this.maxActive = maxActive;
        if (!Number.isSafeInteger(maxActive) || maxActive < 1)
            throw new RangeError('maxActive must be a positive integer');
    }
    create(cwd, requestedShell) {
        this.trimSessions();
        if ([...this.sessions.values()].filter((record) => record.endedAt === undefined).length >= this.maxActive) {
            throw new Error(`Active terminal limit reached (${this.maxActive})`);
        }
        const shell = this.resolveShell(requestedShell);
        const command = this.commandFor(shell);
        const cols = 120;
        const rows = 32;
        const env = Object.fromEntries(Object.entries({ ...process.env, IEXA_WORKSPACE: cwd, PYTHONIOENCODING: 'utf-8' }).filter((entry) => typeof entry[1] === 'string'));
        const pty = (0, node_pty_1.spawn)(command.file, command.args, {
            name: 'xterm-256color', cols, rows, cwd, env,
            useConpty: process.platform === 'win32',
        });
        const record = {
            id: crypto.randomUUID(), shell, cwd, pty, createdAt: Date.now(), chunks: [], outputBytes: 0, nextSeq: 1, cols, rows,
            exitWaiters: [],
        };
        this.sessions.set(record.id, record);
        record.dataSubscription = pty.onData((value) => this.append(record, value));
        record.exitSubscription = pty.onExit(({ exitCode }) => this.finalize(record, exitCode));
        return this.info(record);
    }
    list() {
        return [...this.sessions.values()].map((record) => this.info(record)).sort((a, b) => b.createdAt - a.createdAt);
    }
    output(id, after = 0) {
        const record = this.get(id);
        const sequence = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
        return {
            chunks: record.chunks.filter((chunk) => chunk.seq > sequence),
            lastSeq: record.nextSeq - 1,
            running: record.endedAt === undefined && !record.stopping,
        };
    }
    write(id, input, appendNewline = false) {
        const record = this.get(id);
        if (record.endedAt !== undefined || record.stopping)
            throw new Error('终端会话已结束。');
        const value = String(input || '');
        if (!value || value.length > 100_000)
            throw new Error('终端输入不能为空且不能超过 100000 个字符。');
        record.pty.write(appendNewline ? `${value.replace(/\r?\n$/, '')}\r` : value);
    }
    resize(id, cols, rows) {
        const record = this.get(id);
        if (record.endedAt !== undefined || record.stopping)
            return;
        record.cols = Math.max(20, Math.min(500, Math.floor(cols)));
        record.rows = Math.max(5, Math.min(300, Math.floor(rows)));
        record.pty.resize(record.cols, record.rows);
    }
    async terminate(id) {
        const record = this.get(id);
        await this.terminateRecord(record);
    }
    async shutdown() {
        await Promise.all([...this.sessions.values()].map((record) => this.terminateRecord(record)));
        this.sessions.clear();
    }
    shutdownSync() {
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
    get(id) {
        const record = this.sessions.get(id);
        if (!record)
            throw new Error('未找到终端会话。');
        return record;
    }
    append(record, value) {
        let text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
        if (!text)
            return;
        if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
            const bytes = Buffer.from(text);
            let start = bytes.length - MAX_OUTPUT_BYTES;
            while (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
                start++;
            text = bytes.subarray(start).toString('utf8');
        }
        const size = Buffer.byteLength(text);
        record.chunks.push({ seq: record.nextSeq++, text });
        record.outputBytes += size;
        while ((record.outputBytes > MAX_OUTPUT_BYTES || record.chunks.length > MAX_OUTPUT_CHUNKS) && record.chunks.length > 1) {
            const removed = record.chunks.shift();
            record.outputBytes -= Buffer.byteLength(removed.text);
        }
    }
    info(record) {
        return {
            id: record.id, shell: record.shell, cwd: record.cwd, createdAt: record.createdAt,
            endedAt: record.endedAt, exitCode: record.exitCode, running: record.endedAt === undefined && !record.stopping, cols: record.cols, rows: record.rows,
        };
    }
    resolveShell(value) {
        const requested = String(value || '').toLowerCase();
        if (requested === 'cmd' || requested === 'powershell' || requested === 'bash' || requested === 'wsl')
            return requested;
        return process.platform === 'win32' ? 'powershell' : 'bash';
    }
    commandFor(shell) {
        if (shell === 'cmd')
            return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/q'] };
        // ConPTY already provides an interactive stdin. Passing `-Command -`
        // makes Windows PowerShell expect redirected standard input and print its
        // usage text instead of opening a usable prompt. Start it interactively;
        // subsequent commands are written through IPty.write().
        if (shell === 'powershell')
            return { file: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit'] };
        if (shell === 'wsl')
            return process.platform === 'win32'
                ? { file: 'wsl.exe', args: ['--shell-type', 'login'] }
                : { file: 'bash', args: ['--noprofile', '--norc', '-i'] };
        const gitBash = process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : '';
        return { file: process.platform === 'win32' && gitBash ? gitBash : 'bash', args: ['--noprofile', '--norc', '-i'] };
    }
    trimSessions() {
        const stale = [...this.sessions.values()].filter((record) => record.endedAt !== undefined).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
        while (stale.length > MAX_ENDED_SESSION_HISTORY) {
            const record = stale.shift();
            record.dataSubscription?.dispose();
            record.exitSubscription?.dispose();
            this.sessions.delete(record.id);
        }
    }
    async terminateRecord(record) {
        if (record.endedAt !== undefined)
            return;
        if (record.stopping) {
            await new Promise((resolve) => record.exitWaiters.push(resolve));
            return;
        }
        record.stopping = true;
        const exited = new Promise((resolve) => record.exitWaiters.push(resolve));
        killPtyWithoutConsoleEnumeration(record.pty);
        const exitedNormally = await waitForExit(exited, 1000);
        // node-pty owns the ConPTY teardown path. Starting taskkill at the same
        // time races its console-list helper and produces AttachConsole failures.
        // Use tree termination only when node-pty did not exit in the grace period.
        if (!exitedNormally && record.endedAt === undefined && process.platform === 'win32') {
            await killWindowsTree(record.pty.pid).catch(() => { });
            await waitForExit(exited, 1000);
        }
        if (record.endedAt === undefined)
            this.finalize(record, -1);
    }
    finalize(record, exitCode) {
        if (record.endedAt !== undefined)
            return;
        record.endedAt = Date.now();
        record.exitCode = exitCode;
        record.stopping = false;
        this.append(record, `\n[终端会话已结束，退出码：${exitCode ?? -1}]\n`);
        record.dataSubscription?.dispose();
        record.exitSubscription?.dispose();
        record.dataSubscription = undefined;
        record.exitSubscription = undefined;
        record.exitWaiters.splice(0).forEach((resolve) => resolve());
        this.trimSessions();
    }
}
exports.TerminalManager = TerminalManager;
/**
 * node-pty's public Windows kill() forks conpty_console_list_agent.js before
 * killing the pseudo-console. That extra process races shell teardown on
 * current Node/Windows builds. Use the already-created native agent and close
 * its sockets directly; this is the same native teardown without enumeration.
 */
function killPtyWithoutConsoleEnumeration(pty) {
    const terminal = pty;
    const agent = terminal._agent;
    if (!agent || !agent._useConpty || !agent._ptyNative || agent._pty === undefined) {
        try {
            pty.kill();
        }
        catch { }
        return;
    }
    try {
        if (agent._inSocket)
            agent._inSocket.readable = false;
    }
    catch { }
    try {
        if (agent._outSocket)
            agent._outSocket.readable = false;
    }
    catch { }
    try {
        agent._ptyNative.kill(agent._pty, agent._useConptyDll);
    }
    catch { }
    try {
        agent._conoutSocketWorker?.dispose();
    }
    catch { }
    try {
        agent._inSocket?.destroy();
    }
    catch { }
    try {
        agent._outSocket?.destroy();
    }
    catch { }
}
function killWindowsTree(pid) {
    return new Promise((resolve) => {
        let settled = false;
        let child;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => { try {
            child?.kill();
        }
        catch { } ; finish(); }, 2000);
        try {
            child = (0, child_process_1.spawn)('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            child.once('error', finish);
            child.once('close', finish);
        }
        catch {
            finish();
        }
    });
}
/** Clear grace-period timers even when the PTY exits synchronously. */
async function waitForExit(exited, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            exited.then(() => true),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=TerminalManager.js.map