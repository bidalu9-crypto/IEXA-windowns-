import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { EventEmitter } from 'events';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { FileWorkspace, IDEError } from './FileWorkspace';
import { terminateProcessTree } from '../tools/shell/ProcessManager';

export interface PreviewLog { level: string; message: string; time: number; }
export interface PreviewState { workspaceId: string; status: 'stopped' | 'starting' | 'running' | 'error'; url: string; logs: PreviewLog[]; error?: string; script?: string; entryPath?: string; }
interface PreviewRecord { state: PreviewState; server?: http.Server; child?: ChildProcess; streams: Set<http.ServerResponse>; generation: number; start?: Promise<PreviewState>; }
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.mp4': 'video/mp4' };
const RELOAD = `<script data-iexa-ide-reload>(function(){var s=new EventSource('/__iexa_ide_events');s.onmessage=function(){location.reload()};window.addEventListener('beforeunload',function(){s.close()})})()</script>`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); }); });
}
function probe(url: string): Promise<boolean> {
  return new Promise(resolve => { const request = http.get(url, response => { response.resume(); resolve((response.statusCode || 500) < 500); }); request.setTimeout(700, () => request.destroy()); request.once('error', () => resolve(false)); });
}
/** Owns static servers and development processes independently for every authorized root. */
export class PreviewServerManager extends EventEmitter {
  private readonly records = new Map<string, PreviewRecord>();
  constructor(private readonly files: FileWorkspace) {
    super();
    files.on('change', this.onFileChange);
  }
  private readonly onFileChange = (event: { workspaceId: string }) => {
    const record = this.records.get(event.workspaceId);
    if (record?.server) for (const stream of record.streams) stream.write('data: reload\n\n');
  };
  inspect(id: string): { type: string; scripts: Array<{ name: string; command: string }>; index?: string; packageManager: string } {
    this.files.project(id);
    let pkg: any = {};
    try { const file = this.files.resolve(id, 'package.json'); if (fs.statSync(file).size < 512 * 1024) pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { /* static project */ }
    const scripts = Object.entries(pkg.scripts || {}).filter(([name, value]) => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,100}$/.test(name)).map(([name, command]) => ({ name, command: String(command).slice(0, 4000) }));
    let index: string | undefined;
    for (const candidate of ['index.html', 'public/index.html']) { try { if (fs.statSync(this.files.resolve(id, candidate)).isFile()) { index = candidate; break; } } catch {} }
    const vite = Boolean(pkg.dependencies?.vite || pkg.devDependencies?.vite || scripts.some(script => /(?:^|\s|\/)vite(?:\s|$)/.test(script.command)));
    return { type: vite ? 'vite' : scripts.length ? 'npm' : index ? 'static' : 'unknown', scripts, index, packageManager: 'npm' };
  }
  status(id: string): PreviewState { this.files.project(id, false); return this.snapshot(this.record(id)); }
  private record(id: string): PreviewRecord {
    let record = this.records.get(id);
    if (!record) { record = { state: { workspaceId: id, status: 'stopped', url: '', logs: [] }, streams: new Set(), generation: 0 }; this.records.set(id, record); }
    return record;
  }
  private snapshot(record: PreviewRecord): PreviewState { return { ...record.state, logs: record.state.logs.map(log => ({ ...log })) }; }
  private publish(record: PreviewRecord): void { this.emit('change', { type: 'server', ...this.snapshot(record) }); }
  private log(record: PreviewRecord, level: string, message: string): void {
    record.state.logs.push({ level, message: message.replace(/\x1b\[[0-9;]*m/g, '').slice(-8000), time: Date.now() });
    if (record.state.logs.length > 300) record.state.logs.splice(0, record.state.logs.length - 300);
    this.publish(record);
  }
  async start(id: string, script?: string, confirmed = false, entryPath?: string): Promise<PreviewState> {
    this.files.project(id); const record = this.record(id);
    let entry: string | undefined;
    if (entryPath !== undefined) {
      if (typeof entryPath !== 'string' || !/\.html?$/i.test(entryPath)) throw new IDEError('IDE_PREVIEW', '请选择 HTML 网页文件。');
      entry = this.files.read(id, entryPath).path;
    }
    if (record.state.status === 'running') {
      if (entry && record.server) {
        record.state.url = new URL('/' + entry.split('/').map(encodeURIComponent).join('/'), record.state.url).href;
        record.state.entryPath = entry;
        this.publish(record);
      }
      return this.snapshot(record);
    }
    if (record.start) {
      const pending = await record.start;
      return entry && pending.status === 'running' ? this.start(id, script, confirmed, entry) : pending;
    }
    const info = entry ? { type: 'static', index: entry, scripts: [] as Array<{ name: string; command: string }> } : this.inspect(id);
    if (info.type === 'unknown') throw new IDEError('IDE_PREVIEW', '项目中没有 index.html 或可运行的 package.json scripts。');
    const selected = script || (info.scripts.find(item => item.name === 'dev') || info.scripts.find(item => item.name === 'start') || info.scripts[0])?.name;
    if (info.type !== 'static' && (!selected || !info.scripts.some(item => item.name === selected))) throw new IDEError('IDE_SCRIPT', '请选择 package.json 中已存在的脚本。');
    if (info.type !== 'static' && confirmed !== true) throw new IDEError('IDE_CONFIRM', '请确认界面展示的项目脚本后再运行。');
    record.state = { workspaceId: id, status: 'starting', url: '', logs: [], ...(info.type !== 'static' ? { script: selected } : { entryPath: info.index }) };
    record.generation++; const generation = record.generation; this.publish(record);
    record.start = (async () => {
      try {
        if (info.type === 'static') await this.startStatic(id, record, generation, info.index || 'index.html', !!entry);
        else await this.startScript(id, record, generation, selected!, info.type === 'vite');
      } catch (error) {
        if (record.generation === generation) {
          await this.clean(record); record.state.status = 'error'; record.state.error = (error as Error).message; this.log(record, 'error', (error as Error).message);
        }
      } finally { record.start = undefined; }
      return this.snapshot(record);
    })();
    return record.start;
  }
  private async startStatic(id: string, record: PreviewRecord, generation: number, index: string, explicitEntry = false): Promise<void> {
    const server = http.createServer((req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
      const address = server.address() as net.AddressInfo | null;
      if (!address || !['127.0.0.1', 'localhost'].some(host => req.headers.host === `${host}:${address.port}`) || (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${address.port}`)) { res.writeHead(403); res.end('Origin denied'); return; }
      if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405); res.end(); return; }
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        if (url.pathname === '/__iexa_ide_events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' }); res.write(': connected\n\n'); record.streams.add(res); req.on('close', () => record.streams.delete(res)); return;
        }
        let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || index;
        if (relative.split(/[\\/]/).some(part => ['.git', '.ssh', 'node_modules'].includes(part) || /^\.env(?:\.|$)/i.test(part))) { res.writeHead(403); res.end('Private file'); return; }
        let file = this.files.resolve(id, relative);
        if (fs.statSync(file).isDirectory()) { relative = `${relative}/index.html`; file = this.files.resolve(id, relative); }
        if (path.relative(this.files.project(id).root, file).split(/[\\/]/).some(part => ['.git', '.ssh', 'node_modules'].includes(part) || /^\.env(?:\.|$)/i.test(part))) { res.writeHead(403); res.end('Private file'); return; }
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        const extension = path.extname(file).toLowerCase(); res.setHeader('Content-Type', MIME[extension] || 'application/octet-stream');
        if (req.method === 'HEAD') { res.end(); return; }
        if (['.html', '.htm'].includes(extension)) {
          const content = this.files.read(id, relative).content; res.end(/<head[^>]*>/i.test(content) ? content.replace(/<head[^>]*>/i, match => `${match}${RELOAD}`) : `${RELOAD}${content}`);
        } else { const stream = fs.createReadStream(file); stream.once('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); }
      } catch { if (!res.headersSent) res.writeHead(404); res.end('File not found'); }
    });
    record.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    if (record.generation !== generation) { await this.clean(record); return; }
    const port = (server.address() as net.AddressInfo).port; record.state.url = `http://127.0.0.1:${port}/` + (explicitEntry ? index.split('/').map(encodeURIComponent).join('/') : ''); record.state.status = 'running';
    this.log(record, 'info', `静态预览运行于 ${record.state.url}`);
  }
  private nodeAndNpm(): { node: string; npm: string } {
    const paths = (process.env.PATH || process.env.Path || '').split(path.delimiter).map(item => item.replace(/^"|"$/g, ''));
    const nodeCandidates = [...(!process.versions.electron ? [process.execPath] : []), ...paths.map(dir => path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')), 'C:\\Program Files\\nodejs\\node.exe'];
    const node = nodeCandidates.find(file => fs.existsSync(file));
    const npmCandidates = [process.env.npm_execpath || '', ...(node ? [path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js'), path.join(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js')] : []), ...paths.map(dir => path.join(dir, 'node_modules/npm/bin/npm-cli.js'))];
    const npm = npmCandidates.find(file => file.endsWith('npm-cli.js') && fs.existsSync(file));
    if (!node || !npm) throw new IDEError('IDE_NODE', '请安装 Node.js 与 npm 后运行此项目。');
    return { node, npm };
  }
  private async startScript(id: string, record: PreviewRecord, generation: number, script: string, vite: boolean): Promise<void> {
    const root = this.files.project(id).root; const { node, npm } = this.nodeAndNpm(); const port = await freePort();
    if (record.generation !== generation) return;
    let args = [npm, 'run', script, '--', ...(vite ? ['--host', '127.0.0.1', '--port', String(port), '--strictPort'] : [])];
    // npm's generated Windows shim contains an unquoted `SET dp0=%~dp0`.
    // A plain Vite script can use its installed Node entry without skipping
    // lifecycle hooks. Avoid the broken shim only for this exact case;
    // composed scripts and pre/post hooks continue through npm unchanged.
    if (process.platform === 'win32' && /[&^()%!]/.test(root) && vite) {
      const packageFile = this.files.resolve(id, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
      if (pkg.scripts?.[script]?.trim() === 'vite' && !pkg.scripts?.[`pre${script}`] && !pkg.scripts?.[`post${script}`]) {
        const installed = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
        if (fs.existsSync(installed) && fs.statSync(installed).isFile()) {
          args = [fs.realpathSync.native(installed), '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
          this.log(record, 'info', '通过已安装的 Vite Node 入口启动，以兼容项目路径中的 Windows 命令符号。');
        }
      }
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', FORCE_COLOR: '0', IEXA_WORKSPACE: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(node, args, { cwd: root, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    record.child = child;
    let spawnError = ''; let exited = false;
    const urls = new Set<string>([`http://127.0.0.1:${port}/`]);
    const output = (level: string, chunk: Buffer) => {
      const message = chunk.toString('utf8'); this.log(record, level, message);
      for (const match of message.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s\x1b]*)?/g)) {
        try { const candidate = new URL(match[0]); candidate.hostname = '127.0.0.1'; if (candidate.protocol === 'http:') urls.add(candidate.href); } catch {}
      }
    };
    child.stdout?.on('data', chunk => output('stdout', chunk)); child.stderr?.on('data', chunk => output('stderr', chunk));
    child.once('error', error => { spawnError = error.message; });
    child.once('exit', (code) => {
      exited = true;
      if (record.generation === generation && record.state.status === 'running') {
        record.state.status = 'error'; record.state.error = `开发服务已退出（${code}）`; this.log(record, 'error', record.state.error);
        void terminateProcessTree(child, 2000);
      }
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && record.generation === generation) {
      if (spawnError) throw new IDEError('IDE_PROCESS', spawnError);
      if (exited) throw new IDEError('IDE_PROCESS', `开发脚本已退出，请查看运行日志。`);
      for (const url of urls) {
        if (await probe(url) && !exited && record.generation === generation) { record.state.url = url; record.state.status = 'running'; this.publish(record); return; }
      }
      await new Promise(resolve => setTimeout(resolve, 160));
    }
    if (record.generation === generation) throw new IDEError('IDE_TIMEOUT', '30 秒内未检测到开发服务，请查看脚本和日志。');
  }
  private async clean(record: PreviewRecord): Promise<void> {
    for (const stream of record.streams) stream.end(); record.streams.clear();
    if (record.server) {
      const server = record.server; record.server = undefined;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (record.child) { const child = record.child; record.child = undefined; await terminateProcessTree(child, 2000); child.stdout?.destroy(); child.stderr?.destroy(); }
  }
  async stop(id: string): Promise<PreviewState> {
    this.files.project(id, false); const record = this.record(id); const pending = record.start; record.generation++; await this.clean(record); await pending; record.state.status = 'stopped'; record.state.url = ''; delete record.state.error; this.publish(record); return this.snapshot(record);
  }
  async restart(id: string, script?: string, confirmed = false, entryPath?: string): Promise<PreviewState> {
    const previous = this.record(id).state; await this.stop(id); return this.start(id, script || previous.script, confirmed, entryPath ?? previous.entryPath);
  }
  async shutdown(): Promise<void> { this.files.off('change', this.onFileChange); await Promise.all([...this.records.keys()].map(id => this.stop(id).catch(() => {}))); }
  shutdownSync(): void {
    for (const record of this.records.values()) {
      if (record.child?.pid) {
        if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(record.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 2500 });
        else { try { process.kill(-record.child.pid, 'SIGKILL'); } catch {} }
      }
    }
  }
}
