import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pathToFileURL, fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { FileWorkspace, IDEError } from './FileWorkspace';

export type PythonLanguageStatus = 'idle' | 'starting' | 'ready' | 'unavailable' | 'error' | 'cooldown';
export interface PythonLanguageRequest {
  workspaceId: string;
  method: 'open' | 'change' | 'close' | 'completion' | 'hover' | 'definition' | 'references' | 'release';
  path?: string; text?: string; version?: number;
  position?: { line: number; character: number };
  context?: { triggerKind?: number; triggerCharacter?: string };
  includeDeclaration?: boolean;
}
export interface PythonLanguageResult {
  status: PythonLanguageStatus; workspaceId?: string; result?: unknown; version?: number; reason?: string;
  pid?: number; cooldownUntil?: number;
}
interface Options {
  /** Main-process controlled unpacked resource directory. Never renderer supplied. */
  resourcePath?: string;
  /** null deliberately disables execution. Electron's executable is accepted only when explicitly supplied. */
  nodePath?: string | null;
  electronRunAsNode?: boolean;
  env?: NodeJS.ProcessEnv;
  idleMs?: number; requestTimeoutMs?: number; startupTimeoutMs?: number;
  /** Main-process/test hook; renderer cannot change resource budgets. */
  sampleRss?: (pid: number) => Promise<number | undefined>;
  rssIntervalMs?: number; rssLimitBytes?: number; cooldownMs?: number;
}
interface Document {
  path: string; uri: string; text: string; version: number; sentVersion: number;
  pending?: { text: string; version: number }; timer?: ReturnType<typeof setTimeout>;
}
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }
const MAX_TEXT = 500 * 1024;
const MAX_STDOUT = 32 * 1024 * 1024;
const MAX_DOCUMENTS = 16;
const EXCLUDE = ['**/node_modules', '**/.git', '**/.venv', '**/venv', '**/.iexa-artifacts', '**/dist', '**/build', '**/release', '**/resources/codeoss'];
const ANALYSIS = Object.freeze({
  diagnosticMode: 'openFilesOnly', indexing: false, include: [], exclude: ['**', ...EXCLUDE], autoSearchPaths: false,
  autoImportCompletions: false, useLibraryCodeForTypes: false, typeCheckingMode: 'basic',
  logLevel: 'Error', diagnosticSeverityOverrides: { reportMissingImports: 'none' },
});

/** One lazily created Python stdio server for the selected project. Opening ordinary
 * files, starting the app, and querying status never launch a language process. */
export class PythonLanguageService extends EventEmitter {
  private child?: ChildProcess;
  private workspaceId?: string;
  private root?: string;
  private status: PythonLanguageStatus = 'idle';
  private reason?: string;
  private cooldownUntil = 0;
  private disposed = false;
  private generation = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private documents = new Map<string, Document>();
  private incoming = Buffer.alloc(0);
  private startup?: Promise<boolean>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private rssTimer?: ReturnType<typeof setInterval>;
  private rssBusy = false;
  private highRssSamples = 0;
  private stderr = '';
  private verifiedResource?: string;
  private switching: Promise<void> = Promise.resolve();
  private stopping: Promise<void> = Promise.resolve();
  private workspaceTokens = new Map<string, number>();
  constructor(private readonly files: FileWorkspace, private readonly options: Options = {}) { super(); }

  getStatus(workspaceId?: string): PythonLanguageResult {
    if (workspaceId) this.files.project(workspaceId);
    if (workspaceId && this.workspaceId && workspaceId !== this.workspaceId) return { status: 'idle', workspaceId };
    const cooling = this.cooldownUntil > Date.now();
    return {
      status: cooling ? 'cooldown' : (this.status === 'cooldown' ? 'idle' : this.status),
      workspaceId: this.workspaceId || workspaceId, ...(this.reason ? { reason: this.reason } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}), ...(cooling ? { cooldownUntil: this.cooldownUntil } : {}),
    };
  }

  async request(input: PythonLanguageRequest): Promise<PythonLanguageResult> {
    if (!input || typeof input.workspaceId !== 'string') throw new IDEError('IDE_LANGUAGE_REQUEST', '语言请求缺少项目。');
    const project = this.files.project(input.workspaceId);
    if (this.disposed) return { status: 'unavailable', workspaceId: input.workspaceId, reason: 'Python 语言服务已关闭。' };
    if (input.method === 'release') {
      this.workspaceTokens.set(input.workspaceId, (this.workspaceTokens.get(input.workspaceId) || 0) + 1);
      const release = this.switching.then(async () => {
        if (this.workspaceId === input.workspaceId) await this.stop('idle', '已释放此项目的 Python 语言服务。');
      });
      this.switching = release.catch(() => {}); await release;
      return { status: 'idle', workspaceId: input.workspaceId };
    }
    if (!['open', 'change', 'close', 'completion', 'hover', 'definition', 'references'].includes(input.method)) throw new IDEError('IDE_LANGUAGE_METHOD', '未知的语言操作。');
    // A renamed or externally deleted file still owns a language document.
    // Closing it must release that slot even though its old path is gone.
    const file = this.files.resolve(input.workspaceId, input.path || '', input.method === 'close');
    if (!/\.(?:py|pyi|pyw)$/i.test(file)) return { status: 'unavailable', workspaceId: input.workspaceId, reason: '当前语言服务用于 Python 文件（.py / .pyi / .pyw）。' };
    const relative = path.relative(project.root, file).replace(/\\/g, '/');
    if (input.method === 'close') {
      if (this.workspaceId === input.workspaceId) this.close(relative);
      return this.getStatus(input.workspaceId);
    }
    if (!fs.statSync(file).isFile()) throw new IDEError('IDE_LANGUAGE_FILE', '请选择 Python 文件。');
    if (['completion', 'hover', 'definition', 'references'].includes(input.method)) {
      if (!input.position || !Number.isSafeInteger(input.position.line) || input.position.line < 0 || !Number.isSafeInteger(input.position.character) || input.position.character < 0) throw new IDEError('IDE_LANGUAGE_POSITION', '语言请求的位置无效。');
    }
    if (input.text !== undefined) this.validateText(input.text, input.version);
    if (input.method === 'open' || input.method === 'change') this.validateText(input.text, input.version);
    const workspaceToken = this.workspaceTokens.get(input.workspaceId) || 0;
    // Serialize project transitions only; requests within one project remain asynchronous.
    const switchTo = this.switching.then(async () => {
      if (this.disposed || (this.workspaceTokens.get(input.workspaceId) || 0) !== workspaceToken) return;
      if (this.workspaceId !== input.workspaceId) {
        await this.stop('idle'); this.workspaceId = input.workspaceId; this.root = project.root;
      }
    });
    this.switching = switchTo.catch(() => {}); await switchTo;
    if (this.disposed || (this.workspaceTokens.get(input.workspaceId) || 0) !== workspaceToken) return { status: 'idle', workspaceId: input.workspaceId, reason: '此项目的语言会话已释放。' };
    const epoch = this.generation;
    if (this.cooldownUntil > Date.now()) return this.getStatus(input.workspaceId);
    if (!(await this.ensureStarted())) return this.getStatus(input.workspaceId);
    if (this.workspaceId !== input.workspaceId || this.generation !== epoch) return { status: 'idle', workspaceId: input.workspaceId, reason: '项目已切换，请重试。' };
    this.files.resolve(input.workspaceId, relative);
    this.touch();
    let doc = this.documents.get(relative);
    if (input.text !== undefined) {
      if (!doc) {
        if (this.documents.size >= MAX_DOCUMENTS) return { ...this.getStatus(), reason: 'Python 语言服务最多同时分析 16 个已打开文件。' };
        doc = { path: relative, uri: pathToFileURL(file).toString(), text: input.text, version: input.version!, sentVersion: input.version! };
        this.documents.set(relative, doc);
        this.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: 'python', version: doc.version, text: doc.text } });
      } else if (input.version! > doc.version) {
        doc.text = input.text; doc.version = input.version!; doc.pending = { text: input.text, version: input.version! };
        if (doc.timer) clearTimeout(doc.timer);
        doc.timer = setTimeout(() => this.flush(doc!), 50); doc.timer.unref();
      } else if (input.version === doc.version && input.text !== doc.text) {
        throw new IDEError('IDE_LANGUAGE_VERSION', '同一编辑版本对应了不同文本。');
      }
    }
    if (!doc) return { ...this.getStatus(), reason: '请先同步此 Python 文件的当前文本。' };
    if (input.version !== undefined && input.version < doc.version) return { ...this.getStatus(), version: doc.version, reason: '已忽略旧编辑版本。' };
    if (input.method === 'open' || input.method === 'change') return { ...this.getStatus(), version: doc.version };
    this.flush(doc);
    const version = doc.version;
    try {
      const params: Record<string, unknown> = { textDocument: { uri: doc.uri }, position: input.position };
      if (input.method === 'completion') params.context = { triggerKind: [1, 2, 3].includes(input.context?.triggerKind || 0) ? input.context!.triggerKind : 1, ...(typeof input.context?.triggerCharacter === 'string' && input.context.triggerCharacter.length === 1 ? { triggerCharacter: input.context.triggerCharacter } : {}) };
      if (input.method === 'references') params.context = { includeDeclaration: input.includeDeclaration !== false };
      let result = await this.rpc('textDocument/' + input.method, params);
      if (this.generation !== epoch || this.workspaceId !== input.workspaceId || doc.version !== version) return { status: 'idle', workspaceId: input.workspaceId, version, reason: '编辑内容已变化，已丢弃旧语言结果。' };
      if (input.method === 'definition' || input.method === 'references') result = this.locations(result, input.workspaceId);
      return { ...this.getStatus(), result, version };
    } catch (error) { return { ...this.getStatus(), version, reason: (error as Error).message }; }
  }

  private validateText(text: unknown, version: unknown): void {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TEXT || text.includes('\0')) throw new IDEError('IDE_LANGUAGE_SIZE', 'Python 语言分析的文本上限为 500 KiB。');
    if (!Number.isSafeInteger(version) || (version as number) < 1) throw new IDEError('IDE_LANGUAGE_VERSION', '语言请求缺少有效的编辑版本。');
  }
  private flush(doc: Document): void {
    if (doc.timer) clearTimeout(doc.timer); doc.timer = undefined;
    if (!doc.pending || !this.child || this.status !== 'ready') return;
    const pending = doc.pending; doc.pending = undefined; doc.sentVersion = pending.version;
    this.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: pending.version }, contentChanges: [{ text: pending.text }] });
  }
  private close(relative: string): void {
    const doc = this.documents.get(relative); if (!doc) return;
    if (doc.timer) clearTimeout(doc.timer);
    this.notify('textDocument/didClose', { textDocument: { uri: doc.uri } }); this.documents.delete(relative);
    this.emit('change', { type: 'language', kind: 'diagnostics', workspaceId: this.workspaceId, path: relative, version: doc.version, diagnostics: [] });
    this.touch();
  }
  private changeStatus(status: PythonLanguageStatus, reason?: string): void {
    this.status = status; this.reason = reason;
    this.emit('change', { type: 'language', kind: 'status', ...this.getStatus() });
  }
  private async ensureStarted(): Promise<boolean> {
    if (this.status === 'ready' && this.child) return true;
    if (this.startup) return this.startup;
    if (this.cooldownUntil > Date.now() || this.disposed) return false;
    const epoch = this.generation;
    const startup = this.start(epoch);
    this.startup = startup;
    try { return await startup; } finally { if (this.startup === startup) this.startup = undefined; }
  }
  private async start(epoch: number): Promise<boolean> {
    await this.stopping;
    if (this.generation !== epoch || this.disposed) return false;
    this.changeStatus('starting', '正在启动按需 Python 语言服务…');
    try {
      const resource = this.resource(); const node = this.node();
      if (!node) { this.changeStatus('unavailable', '未找到 Node.js；安装 Node.js 22 或更新版本后可使用 Python 补全与诊断。'); return false; }
      if (this.generation !== epoch || this.disposed) return false;
      const env = { ...process.env, ...this.options.env };
      delete env.NODE_OPTIONS; delete env.NODE_PATH;
      if (this.options.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
      // No cancellationReceive CLI: upstream then runs foreground analysis without a background worker.
      const child = spawn(node, ['--max-old-space-size=192', path.join(resource, 'dist/server.js'), '--stdio'], {
        cwd: this.root, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child; this.incoming = Buffer.alloc(0); this.stderr = ''; this.highRssSamples = 0;
      child.stdout!.on('data', data => { if (this.child === child) this.consume(Buffer.from(data)); });
      child.stderr!.on('data', data => { if (this.child === child) this.stderr = (this.stderr + String(data)).slice(-8192); });
      child.stdin!.on('error', () => {});
      child.on('error', error => { if (this.child === child) void this.fail(`Python 语言服务启动失败：${error.message}`); });
      child.on('exit', code => { if (this.child === child) void this.fail(`Python 语言服务已退出（${code ?? 'signal'}）；稍后可手动重试。`); });
      this.startRssMonitor(child);
      const rootUri = pathToFileURL(this.root!).toString();
      await this.rpc('initialize', {
        processId: process.pid, rootUri, rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root!) }],
        clientInfo: { name: 'IEXA Monaco Python', version: '1' }, locale: 'zh-cn',
        initializationOptions: { diagnosticMode: 'openFilesOnly', disablePullDiagnostics: true },
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: false } },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            publishDiagnostics: { versionSupport: true, relatedInformation: false },
          },
        },
      }, this.options.startupTimeoutMs ?? 8000);
      if (this.child !== child || this.generation !== epoch) return false;
      this.notify('initialized', {});
      this.notify('workspace/didChangeConfiguration', { settings: this.settings() });
      this.changeStatus('ready'); this.touch(); return true;
    } catch (error) {
      if (this.generation === epoch) await this.fail((error as Error).message);
      return false;
    }
  }
  private settings(): object { return { python: { analysis: ANALYSIS }, pyright: { disableOrganizeImports: true } }; }
  private resource(): string {
    const dir = this.options.resourcePath || path.resolve(__dirname, '../../../resources/language-services/pyright').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (this.verifiedResource === dir) return dir;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'vendor-manifest.json'), 'utf8'));
    if (manifest.version !== '1.1.402' || manifest.license !== 'MIT' || manifest.entry !== 'dist/server.js') throw new Error('Python 语言服务资源版本不匹配。');
    for (const name of ['dist/server.js', 'dist/server.js.LICENSE.txt', 'LICENSE.txt']) {
      const record = manifest.files.find((item: any) => item.path === name);
      if (!record || crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex') !== record.sha256) throw new Error('Python 语言服务资源校验失败：' + name);
    }
    this.verifiedResource = dir; return dir;
  }
  private node(): string | undefined {
    if (this.options.nodePath === null) return undefined;
    if (this.options.nodePath) return path.isAbsolute(this.options.nodePath) && fs.existsSync(this.options.nodePath) ? this.options.nodePath : undefined;
    if (!process.versions.electron && path.basename(process.execPath).toLowerCase() === 'node.exe') return process.execPath;
    if (!process.versions.electron && path.basename(process.execPath) === 'node') return process.execPath;
    const env = { ...process.env, ...this.options.env };
    const search = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    for (const item of search.split(path.delimiter)) {
      if (!item || !path.isAbsolute(item)) continue;
      const node = path.join(item, process.platform === 'win32' ? 'node.exe' : 'node');
      try { if (fs.statSync(node).isFile()) return node; } catch { /* next PATH entry */ }
    }
    return undefined;
  }
  private notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
  private send(message: object): void {
    if (!this.child?.stdin?.writable) return;
    const bytes = Buffer.from(JSON.stringify(message), 'utf8');
    if (this.child.stdin.writableLength + bytes.length > 2 * 1024 * 1024) { void this.fail('Python 语言服务响应过慢，已释放积压请求。'); return; }
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]));
  }
  private rpc(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 3500): Promise<any> {
    if (this.pending.size >= 8) return Promise.reject(new Error('Python 语言请求繁忙，请稍后重试。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.notify('$/cancelRequest', { id });
        reject(new Error('Python 语言服务响应超时，编辑仍可继续。'));
      }, timeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer }); this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  private consume(chunk: Buffer): void {
    if (chunk.length + this.incoming.length > MAX_STDOUT) { void this.fail('Python 语言服务输出超过 32 MiB，已停止服务。'); return; }
    this.incoming = Buffer.concat([this.incoming, chunk]);
    try {
      while (this.incoming.length) {
        const boundary = this.incoming.indexOf('\r\n\r\n');
        if (boundary < 0) { if (this.incoming.length > 8192) throw new Error('语言服务消息头过长。'); return; }
        const header = this.incoming.subarray(0, boundary).toString('ascii');
        const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
        if (!match || boundary > 8192) throw new Error('语言服务消息头无效。');
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length > MAX_STDOUT || length < 2) throw new Error('语言服务消息大小超限。');
        if (this.incoming.length < boundary + 4 + length) return;
        const bytes = this.incoming.subarray(boundary + 4, boundary + 4 + length);
        this.incoming = this.incoming.subarray(boundary + 4 + length);
        this.message(JSON.parse(bytes.toString('utf8')));
      }
    } catch (error) { void this.fail('Python 语言服务协议错误：' + (error as Error).message); }
  }
  private message(message: any): void {
    if (!message || typeof message !== 'object') throw new Error('无效 JSON-RPC 消息。');
    // Server request IDs and client request IDs are independent namespaces.
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        let result: unknown = null;
        if (message.method === 'workspace/configuration') result = (message.params?.items || []).slice(0, 32).map((item: any) => item.section === 'python' ? { analysis: ANALYSIS } : item.section === 'python.analysis' ? ANALYSIS : item.section === 'pyright' ? { disableOrganizeImports: true } : null);
        else if (message.method === 'workspace/workspaceFolders') result = this.root ? [{ uri: pathToFileURL(this.root).toString(), name: path.basename(this.root) }] : [];
        else if (!['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create'].includes(message.method)) {
          this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method unavailable' } }); return;
        }
        this.send({ jsonrpc: '2.0', id: message.id, result });
      } else if (message.method === 'textDocument/publishDiagnostics') this.diagnostics(message.params);
      return;
    }
    const pending = this.pending.get(message.id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error.message || '语言请求失败。').slice(0, 1000)));
    else pending.resolve(message.result);
  }
  private diagnostics(params: any): void {
    let source: string;
    try { source = fileURLToPath(String(params?.uri)); } catch { return; }
    const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const doc = [...this.documents.values()].find(value => key(fileURLToPath(value.uri)) === key(source));
    // Pyright sends source versions. Never relabel unversioned or stale results.
    if (!doc || !Number.isSafeInteger(params.version) || params.version !== doc.version || params.version !== doc.sentVersion || doc.pending || !Array.isArray(params.diagnostics)) return;
    this.emit('change', { type: 'language', kind: 'diagnostics', workspaceId: this.workspaceId, path: doc.path, version: params.version, diagnostics: params.diagnostics.slice(0, 2000) });
  }
  private locations(result: any, workspaceId: string): any {
    const values = Array.isArray(result) ? result : result ? [result] : [];
    return values.slice(0, 1000).flatMap((item: any) => {
      try {
        const uri = item.uri || item.targetUri; if (typeof uri !== 'string' || !uri.startsWith('file:')) return [];
        const file = fileURLToPath(uri); const relative = path.relative(this.files.project(workspaceId).root, file);
        const safe = this.files.resolve(workspaceId, relative); if (path.resolve(file).toLowerCase() !== safe.toLowerCase()) return [];
        return [{ ...item, path: relative.replace(/\\/g, '/') }];
      } catch { return []; }
    });
  }
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop('idle', 'Python 语言服务闲置 60 秒，已自动释放。'); }, this.options.idleMs ?? 60000); this.idleTimer.unref();
  }
  private startRssMonitor(child: ChildProcess): void {
    this.rssTimer = setInterval(async () => {
      if (this.rssBusy || this.child !== child || !child.pid) return;
      this.rssBusy = true;
      try {
        const rss = await (this.options.sampleRss || sampleRss)(child.pid);
        if (this.child !== child) return;
        this.highRssSamples = rss !== undefined && rss > (this.options.rssLimitBytes ?? 320 * 1024 * 1024) ? this.highRssSamples + 1 : 0;
        if (this.highRssSamples >= 3) await this.fail('Python 语言服务持续占用超过 320 MiB，已停止；60 秒后可手动重试。');
      } finally { this.rssBusy = false; }
    }, this.options.rssIntervalMs ?? 5000); this.rssTimer.unref();
  }
  private async fail(reason: string): Promise<void> {
    this.cooldownUntil = Date.now() + (this.options.cooldownMs ?? 60000);
    await this.stop('cooldown', reason);
  }
  private async stop(status: PythonLanguageStatus, reason?: string): Promise<void> {
    this.generation++; const child = this.child; this.child = undefined; this.startup = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined;
    if (this.rssTimer) clearInterval(this.rssTimer); this.rssTimer = undefined;
    for (const doc of this.documents.values()) if (doc.timer) clearTimeout(doc.timer);
    this.documents.clear(); this.incoming = Buffer.alloc(0);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason || 'Python 语言服务已释放。')); }
    this.pending.clear();
    this.changeStatus(status, reason);
    const stopping = this.stopping.then(async () => { if (child) await terminateTree(child); });
    this.stopping = stopping.catch(() => {}); await stopping;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stop('idle'); this.removeAllListeners(); }
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 2500); timer.unref();
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve(); }); killer.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
}
async function sampleRss(pid: number): Promise<number | undefined> {
  if (process.platform === 'linux') { try { return Number(/^VmRSS:\s+(\d+)/m.exec(await fs.promises.readFile(`/proc/${pid}/status`, 'utf8'))?.[1]) * 1024 || undefined; } catch { return undefined; } }
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const child = spawn(win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tasklist.exe') : '/bin/ps', win ? ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'] : ['-o', 'rss=', '-p', String(pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let text = ''; const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 2000); timer.unref();
    child.stdout!.on('data', bytes => { text = (text + String(bytes)).slice(0, 2048); });
    child.once('error', () => { clearTimeout(timer); resolve(undefined); });
    child.once('exit', code => {
      clearTimeout(timer);
      const fields = [...text.matchAll(/"([^"]*)"(?:,|\s*$)/g)].map(match => match[1]);
      const value = win ? (Number(fields[1]) === pid ? Number((fields[4] || '').replace(/\D/g, '')) : NaN) : Number(text.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value * 1024 : undefined);
    });
  });
}
