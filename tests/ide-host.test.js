'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { make, remove } = require('./helpers/temp-dir');
const { installIDEHost } = require('../resources/ide-host.cjs');

function fixture(t) {
  const root = make('iexa-ide-host-'); const handlers = new Map(); const views = []; const partitions = [];
  const frame = { url: 'http://127.0.0.1:19999/' }; const contents = { mainFrame: frame, send() {}, getZoomFactor: () => 1, dirty: false, closeAllowed: false,
    async executeJavaScript(code) {
      if (code.includes('hasUnsavedChanges')) return this.dirty;
      if (code.includes('saveAll')) { if (this.saveError) throw new Error(this.saveError); this.dirty = false; return true; }
      if (code.includes('allowClose')) this.closeAllowed = true;
    },
  };
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }), contentView: { addChildView() {}, removeChildView() {} } });
  class FakeContents extends EventEmitter {
    constructor() { super(); this.url = ''; this.destroyed = false; this.loads = []; this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { this.loads.push(url); this.url = url; if (views[0]?.deferLoad) await views[0].deferLoad; }
    reload() { this.reloads = (this.reloads || 0) + 1; }
    close() { this.destroyed = true; }
  }
  class FakeView {
    constructor(options) { this.options = options; this.webContents = new FakeContents(); views.push(this); }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(value) { this.visible = value; }
  }
  const app = Object.assign(new EventEmitter(), { quitCount: 0, quit() { this.quitCount++; } });
  const messageBoxes = [], choices = [];
  const host = installIDEHost({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }), showMessageBox: async (_win, options) => { messageBoxes.push(options); return { response: choices.shift() ?? 2 }; } },
    session: { fromPartition(name) { const partition = { name, setPermissionRequestHandler(fn) { this.permission = fn; }, setPermissionCheckHandler(fn) { this.check = fn; }, webRequest: { onBeforeRequest(fn) { partition.request = fn; } } }; partitions.push(partition); return partition; } },
    WebContentsView: FakeView, app, getWindow: () => win, workspaceFile: name => path.join(root, name), appOrigin: 'http://127.0.0.1:19999',
  });
  const invoke = (name, input, event = { sender: contents, senderFrame: frame }) => handlers.get(`iexa:ide:${name}`)(event, input);
  t.after(async () => { await host.dispose(); remove(root); });
  return { root, host, invoke, frame, contents, win, views, partitions, app, FakeContents, messageBoxes, choices };
}
test('selected HTML start IPC and later attach navigate the native view to the actual entry', async t => {
  const f = fixture(t);
  for(const name of ['pelican-ride.html','second.htm']) fs.writeFileSync(path.join(f.root,name),'<h1>'+name+'</h1>');
  const project = await f.invoke('choose-folder'), input = {workspaceId:project.id};
  const first = await f.invoke('start',{...input,entryPath:'pelican-ride.html'});
  assert.equal(first.status,'running');
  await f.invoke('preview',{...input,action:'attach'}); assert.equal(f.views[0].webContents.getURL(),first.url);
  const second = await f.invoke('start',{...input,entryPath:'second.htm'});
  await f.invoke('preview',{...input,action:'attach'}); assert.equal(f.views[0].webContents.getURL(),second.url);
  assert.equal(f.views.length,1); assert.match(second.url,/second.htm$/);
  const restarted = await f.invoke('restart',{...input,entryPath:'pelican-ride.html'});
  assert.match(restarted.url,/pelican-ride.html$/);
});

test('IDE IPC rejects other senders, subframes and preview documents even on the app origin', async t => {
  const f = fixture(t); const project = await f.invoke('choose-folder'); assert.ok(project.id);
  assert.equal((await f.invoke('projects')).projects.length, 1);
  assert.equal((await f.invoke('projects', {}, { sender: {}, senderFrame: f.frame })).__ideError.code, 'IDE_SENDER');
  assert.equal((await f.invoke('projects', {}, { sender: f.contents, senderFrame: { url: f.frame.url } })).__ideError.code, 'IDE_SENDER');
  for (const url of ['http://127.0.0.1:19999/api/fs/raw', 'http://127.0.0.1:19888/', 'https://example.com/']) {
    f.frame.url = url; assert.equal((await f.invoke('projects')).__ideError.code, 'IDE_SENDER');
  }
});

test('run-plan IPC only returns an authorized project plan and rejects other renderers or files', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'hello.js'), "console.log('not-executed')");
  const project = await f.invoke('choose-folder'); const input = { workspaceId: project.id, kind: 'file', path: 'hello.js' };
  const plan = await f.invoke('run-plan', input); assert.equal(plan.kind, 'file'); assert.equal(plan.cwd, project.root); assert.equal(plan.language, 'javascript');
  assert.equal(plan.exitMarker, 'IEXA_IDE_EXIT_CODE'); assert.match(plan.command, /IEXA_IDE_EXIT_CODE=/); assert.equal(f.host.servers.status(project.id).status, 'stopped');
  assert.equal((await f.invoke('run-plan', input, { sender: {}, senderFrame: f.frame })).__ideError.code, 'IDE_SENDER');
  assert.equal((await f.invoke('run-plan', { ...input, workspaceId: 'invalid' })).__ideError.code, 'IDE_WORKSPACE');
  assert.ok((await f.invoke('run-plan', { ...input, path: '../outside.js' })).__ideError);
  assert.equal((await f.invoke('run-plan', { ...input, kind: 'unknown' })).__ideError.code, 'IDE_RUN_KIND');
  assert.deepEqual(fs.readdirSync(f.root).filter(name => !name.startsWith('.iexa-')), ['hello.js']);
});

test('IDE follows the backend selected project without accepting a renderer root or resetting its Agent snapshot', async t => {
  const f = fixture(t), projectRoot = path.join(f.root, 'current-project'), other = path.join(f.root, 'other-project');
  fs.mkdirSync(projectRoot); fs.mkdirSync(other); fs.writeFileSync(path.join(projectRoot, 'main.py'), 'value = 1\n');
  assert.equal(await f.invoke('current-project'), null);
  fs.writeFileSync(path.join(f.root, '.iexa-project.json'), JSON.stringify({ root: projectRoot }));
  const project = await f.invoke('current-project', { root: other });
  assert.equal(project.root, fs.realpathSync.native(projectRoot));
  const { setIDEContext, getIDEContextForRoot } = require('../dist/main/ide/IDEContext');
  setIDEContext(project.root, { activeFile: 'main.py', content: 'UNSAVED_AGENT_BUFFER', dirty: true });
  assert.equal((await f.invoke('current-project')).id, project.id);
  assert.match(getIDEContextForRoot(project.root), /UNSAVED_AGENT_BUFFER/);
  assert.equal(f.host.files.projects().some(item => item.root === other), false);
  fs.writeFileSync(path.join(f.root, '.iexa-project.json'), JSON.stringify({ root: null }));
  assert.equal(await f.invoke('current-project'), null);
});
test('preview has isolated permissions, denies app/file requests and preserves same-service websocket HMR', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html><body>Preview</body></html>');
  const project = await f.invoke('choose-folder'); const input = { workspaceId: project.id };
  const state = await f.invoke('start', input); assert.equal(state.status, 'running');
  await f.invoke('preview', { ...input, action: 'attach', bounds: { x: 800, y: 100, width: 300, height: 500 } });
  const prefs = f.views[0].options.webPreferences; assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.preload, undefined);
  const partition = f.partitions[0]; assert.equal(partition.name.startsWith('persist:'), false); assert.equal(partition.check(), false);
  let permission; partition.permission(null, 'media', value => { permission = value; }); assert.equal(permission, false);
  const cancelled = url => { let value; partition.request({ url }, result => { value = result.cancel; }); return value; };
  assert.equal(cancelled('http://127.0.0.1:19999/api/project'), true); assert.equal(cancelled('file:///C:/Windows/win.ini'), true);
  assert.equal(cancelled(state.url), false); assert.equal(cancelled(state.url.replace('http:', 'ws:')), false);
  f.views[0].webContents.emit('console-message', { level: 'error', message: 'MAIN_PROCESS_ERROR_EVIDENCE', lineNumber: 3, sourceId: state.url });
  assert.match(require('../dist/main/ide/IDEContext').getIDEContextForRoot(f.root), /MAIN_PROCESS_ERROR_EVIDENCE/);
  let prevented = false; f.views[0].webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'http://127.0.0.1:19999/'); assert.equal(prevented, true);
  assert.equal((await f.invoke('preview', { ...input, action: 'navigate', url: 'http://127.0.0.1:19999/' })).__ideError.code, 'IDE_NAVIGATION');
  f.win.emit('closed'); assert.equal(f.views[0].webContents.destroyed, true);
});

test('preview omits only Electron runtime security warnings and retains project console diagnostics', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html>preview</html>');
  const { id } = await f.invoke('choose-folder'); const input = { workspaceId: id }; const state = await f.invoke('start', input);
  await f.invoke('preview', { ...input, action: 'attach' });
  const events = []; f.contents.send = (_channel, event) => events.push(event);
  const contents = f.views[0].webContents, runtime = 'node:electron/js2c/renderer_init';
  const warning = 'Electron Security Warning (Insecure Content-Security-Policy)';
  contents.emit('console-message', { level: 'warning', message: warning, sourceId: runtime });
  contents.emit('console-message', {}, 2, '%c' + warning, 1, runtime);
  contents.emit('console-message', { level: 'warning', message: '%c' + warning, sourceId: 'node:electron/js2c/sandbox_bundle' });
  assert.equal(events.length, 0, 'both supported Electron event shapes omit the built-in notice');
  const retained = [
    { level: 'error', message: warning, sourceId: runtime },
    { level: 'warning', message: warning, sourceId: state.url + 'app.js' },
    { level: 'warning', message: 'PROJECT_WARNING_EVIDENCE', sourceId: runtime },
    { level: 'info', message: warning, sourceId: runtime },
    { level: 'warning', message: warning, sourceId: runtime + '_other' },
    { level: 'warning', message: warning },
  ];
  retained.forEach(details => contents.emit('console-message', details));
  assert.deepEqual(events.map(event => [event.message, event.source, event.level]), retained.map(details => [details.message, details.sourceId, details.level === 'info' ? 'console' : details.level]));
  assert.match(require('../dist/main/ide/IDEContext').getIDEContextForRoot(f.root), /PROJECT_WARNING_EVIDENCE/);
});
test('repeated application quit waits for asynchronous process cleanup', async t => {
  const f = fixture(t); let release; const pending = new Promise(resolve => { release = resolve; }); f.host.servers.shutdown = () => pending;
  let prevented = 0; const event = { preventDefault() { prevented++; } };
  f.app.emit('before-quit', event); f.app.emit('before-quit', event);
  assert.equal(prevented, 2); assert.equal(f.app.quitCount, 0); release();
  // Quit now also flushes the persistent review ledger. Wait for the actual
  // cleanup promise rather than assuming a single event-loop turn finishes IO.
  await f.host.requestQuit(); assert.equal(f.app.quitCount, 1);
  f.app.emit('before-quit', event); assert.equal(prevented, 2);
});

test('a late native attach never reveals a preview hidden while navigation was loading', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html>preview</html>');
  const { id } = await f.invoke('choose-folder'); const input = { workspaceId: id }; await f.invoke('start', input);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const original = f.FakeContents.prototype.loadURL;
  f.FakeContents.prototype.loadURL = async function (url) { this.loads.push(url); this.url = url; await pending; };
  const attach = f.invoke('preview', { ...input, action: 'attach' });
  await new Promise(resolve => setImmediate(resolve));
  await f.invoke('preview', { ...input, action: 'hide' }); release();
  assert.equal((await attach).visible, false); assert.equal(f.views[0].visible, false);
  f.FakeContents.prototype.loadURL = original;
  await f.invoke('preview', { ...input, action: 'reload' });
  assert.equal(f.views[0].webContents.reloads, 1); assert.equal(f.views[0].visible, false);
});

test('service restart reloads a retained native preview even when the URL is reused and logs do not navigate', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html>preview</html>');
  const { id } = await f.invoke('choose-folder'); const input = { workspaceId: id }; const state = await f.invoke('start', input);
  await f.invoke('preview', { ...input, action: 'attach' }); const contents = f.views[0].webContents;
  assert.equal(contents.loads.length, 1);
  f.host.servers.emit('change', { ...state, status: 'starting', url: '' });
  f.host.servers.emit('change', { ...state, status: 'running' });
  f.host.servers.emit('change', { ...state, status: 'running', logs: [{ message: 'no new navigation', level: 'info', time: 1 }] });
  assert.equal(contents.loads.length, 2); assert.equal(contents.loads[1], state.url); assert.equal(f.views[0].visible, false);
  await f.invoke('preview', { ...input, action: 'attach' }); assert.equal(f.views[0].visible, true); assert.equal(contents.loads.length, 2);
});

test('shutdown closes native surfaces immediately and all callers await the same process cleanup', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html>preview</html>');
  const { id } = await f.invoke('choose-folder'); const input = { workspaceId: id }; await f.invoke('start', input); await f.invoke('preview', { ...input, action: 'attach' });
  const stop = f.host.servers.shutdown.bind(f.host.servers); let release;
  const pending = new Promise(resolve => { release = resolve; }); f.host.servers.shutdown = async () => { await pending; await stop(); };
  const first = f.host.shutdown(); const second = f.host.shutdown(); assert.equal(first, second);
  assert.equal(f.views[0].visible, false); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.views[0].webContents.destroyed, true);
  assert.equal((await f.invoke('projects')).__ideError.code, 'IDE_CLOSED');
  release(); await first;
});

test('shutdown waits for native WebContents destruction before it completes', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html>close</html>');
  const { id } = await f.invoke('choose-folder'); const input = { workspaceId: id }; await f.invoke('start', input); await f.invoke('preview', { ...input, action: 'attach' });
  const contents = f.views[0].webContents; let closing = false;
  contents.close = () => { closing = true; }; const pending = f.host.shutdown(); let settled = false; pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closing, true); assert.equal(settled, false);
  contents.destroyed = true; contents.emit('destroyed'); await pending; assert.equal(settled, true);
});

test('cancelling quit preserves dirty buffers, authorized IPC, preview server and native surface', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html>keep alive</html>');
  const { id } = await f.invoke('choose-folder'); const input = { workspaceId: id }; const state = await f.invoke('start', input); await f.invoke('preview', { ...input, action: 'attach' });
  f.contents.dirty = true; f.choices.push(2);
  assert.equal(await f.host.requestQuit(), false);
  assert.equal(f.contents.closeAllowed, false); assert.equal(f.host.canQuit(), false); assert.equal(f.app.quitCount, 0);
  assert.equal((await f.invoke('projects')).projects.length, 1); assert.equal((await f.invoke('status', input)).status, 'running');
  assert.equal(f.views[0].visible, true); assert.equal(f.views[0].webContents.destroyed, false);
  const response = await fetch(state.url); assert.equal(response.status, 200);
});

test('save-and-quit saves before allowing unload and failure keeps services running', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'index.html'), '<html>save</html>');
  const { id } = await f.invoke('choose-folder'); const input = { workspaceId: id }; await f.invoke('start', input);
  f.contents.dirty = true; f.contents.saveError = 'IDE_CONFLICT'; f.choices.push(0);
  assert.equal(await f.host.requestQuit(), false); assert.equal(f.contents.closeAllowed, false);
  assert.equal(f.host.servers.status(id).status, 'running'); assert.equal(f.app.quitCount, 0);
  assert.match(f.messageBoxes[1].message, /保存未完成/);
  delete f.contents.saveError; f.choices.push(0);
  assert.equal(await f.host.requestQuit(), true); assert.equal(f.contents.dirty, false); assert.equal(f.contents.closeAllowed, true);
  assert.equal(f.host.canQuit(), true); assert.equal(f.host.servers.status(id).status, 'stopped'); assert.equal(f.app.quitCount, 1);
});

test('discard-and-quit permits unload only after explicit choice and does not invoke save', async t => {
  const f = fixture(t); f.contents.dirty = true; f.contents.saveError = 'save must not run'; f.choices.push(1);
  assert.equal(await f.host.requestQuit(), true); assert.equal(f.contents.dirty, true); assert.equal(f.contents.closeAllowed, true); assert.equal(f.app.quitCount, 1);
});

test('the production before-quit handler keeps backend/tray alive until IDE quit is approved', async t => {
  const f = fixture(t); const vm = require('node:vm'); const source = fs.readFileSync(path.join(__dirname, '../electron-entry.js'), 'utf8');
  const begin = source.indexOf("app.on('before-quit', (event) => {"); const end = source.indexOf('\n});', begin) + 4;
  let handler, closed = 0, trayDestroyed = 0, prevented = 0;
  const sandbox = { app: { on(_name, callback) { handler = callback; } }, ideHost: f.host, server: { close() { closed++; } }, tray: { destroy() { trayDestroyed++; } }, isQuitting: false, console: { log() {}, error() {} }, require: () => ({ closeDesktopHelpers() {} }) };
  vm.runInNewContext(source.slice(begin, end), sandbox);
  const event = { preventDefault() { prevented++; } }; f.contents.dirty = true; f.choices.push(2);
  handler(event); await f.host.requestQuit();
  assert.equal(prevented, 1); assert.equal(closed, 0); assert.equal(trayDestroyed, 0); assert.equal(sandbox.isQuitting, false);
  f.choices.push(1); handler(event); await f.host.requestQuit(); handler(event);
  assert.equal(closed, 1); assert.equal(trayDestroyed, 1); assert.equal(sandbox.isQuitting, true);
});
