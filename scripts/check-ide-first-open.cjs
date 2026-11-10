/* First-use acceptance at the user's normal 530px sidebar width. No model API. */
'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const appRoot = path.resolve(process.env.IEXA_IDE_TEST_APP_ROOT || repo);
const baseline = process.argv.includes('--baseline');
const output = process.env.IEXA_IDE_ARTIFACT_DIR || path.join(repo, '.iexa-artifacts/ide-first-open-fix-20261108', baseline ? 'baseline-runtime' : process.env.IEXA_IDE_TEST_APP_ROOT ? 'packaged-runtime' : 'fixed-runtime');
fs.mkdirSync(output, { recursive: true });
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-ide-first-open-')));
const project = path.join(scratch, 'workspace');
const second = path.join(scratch, 'other-project');
const data = path.join(scratch, 'data');
for (const item of [project, second, data]) fs.mkdirSync(item);
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{background:#211c31;color:#eee;font:24px system-ui;padding:24px}</style><h1>First project preview</h1><p id="value">Saved from the sidebar.</p>');
fs.writeFileSync(path.join(project, 'main.js'), 'const firstOpen = true;\n');
fs.writeFileSync(path.join(second, 'other.txt'), 'another project\n');
process.env.IEXA_WORKSPACE = data;
app.setPath('userData', path.join(scratch, 'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
let win, host, server, backend, chosen = project;
const report = { baseline, appRoot, scope: 'Real renderer, production preload and IDE host; original narrow sidebar, no expansion or model request', checks: [], diagnostics: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
const snapshot = () => evaluate('IexaIDE.snapshot()');
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const record = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); save(); };
async function wait(fn, label, timeout = 16000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await pause(60); }
  throw Error('Timeout: ' + label + (last ? ': ' + last.message : ''));
}
async function rect(selector) { return evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`); }
async function click(selector) {
  const r = await rect(selector); assert.ok(r.width > 0 && r.height > 0, 'visible click target: ' + selector);
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const hit = await evaluate(`document.elementFromPoint(${x},${y})?.closest(${JSON.stringify(selector)})!==null`);
  assert.equal(hit, true, 'click target is reachable: ' + selector);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x, y, clickCount: 1 });
  await pause(120);
}
async function capture(name) {
  await pause(150);
  fs.writeFileSync(path.join(output, name + '-renderer.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  const source = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1384, height: 900 } })).find(source => source.id === win.getMediaSourceId());
  if (source && !source.thumbnail.isEmpty()) fs.writeFileSync(path.join(output, name + '-window.png'), source.thumbnail.toPNG());
}
async function chooseProject(target) {
  chosen = target; await click('#ideOpenFolder');
  await wait(async () => (await snapshot()).project?.root === target, 'chosen project');
}
app.whenReady().then(async () => {
  backend = require(path.join(appRoot, 'dist/main/server'));
  server = await backend.startServer(0, false);
  const origin = `http://127.0.0.1:${server.address().port}`;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  ipcMain.on('iexa:get-initial-appearance', event => { event.returnValue = {}; });
  ipcMain.on('iexa:get-window-state', event => { event.returnValue = {}; });
  ipcMain.handle('iexa:window-command', () => ({}));
  ipcMain.handle('iexa:desktop-live-state', () => ({ open: false }));
  win = new BrowserWindow({ width: 1384, height: 860, useContentSize: true, show: false, skipTaskbar: true, webPreferences: { preload: path.join(appRoot, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.setMenuBarVisibility(false); win.showInactive();
  win.webContents.on('console-message', event => { if (event?.level === 'error') report.diagnostics.push({ message: event.message, sourceId: event.sourceId }); });
  host = require(path.join(appRoot, 'resources/ide-host.cjs')).installIDEHost({ ipcMain, dialog, WebContentsView, session, getWindow: () => win, appOrigin: origin, workspaceFile: name => path.join(data, name) });
  await win.loadURL(origin + '/#login=' + backend.getServerCredentials(server).loginCode);
  await wait(() => evaluate("typeof currentSessionId==='string' && !!currentSessionId && typeof IexaIDE!=='undefined'"), 'existing chat');
  const originalSession = await evaluate('currentSessionId');
  await evaluate("document.getElementById('filesPanel').style.width='530px';document.getElementById('filesPanel').style.maxWidth='530px';document.getElementById('chatInput').value='继续对话，同时查看右侧文件修改';document.getElementById('chatInput').dispatchEvent(new Event('input',{bubbles:true}));true");
  await click('[data-workbench-view="ide"]');
  await evaluate('IexaIDE.ready()');
  await chooseProject(project);
  await wait(() => evaluate("document.querySelectorAll('#ideTree [data-path]').length===2"), 'real files loaded');
  assert.equal((await snapshot()).expanded, false);
  assert.equal(await evaluate("document.getElementById('ideMonaco')===null"), true);
  const initialTree = await rect('#ideTree');
  chosen = project; await click('#ideOpenFolder');
  if (baseline) {
    const error = await wait(async () => (await snapshot()).error || false, 'original null saveViewState error');
    assert.match(error, /Cannot read properties of null \(reading 'saveViewState'\)/);
    assert.equal(initialTree.width, 0, 'baseline has no visible file explorer at the normal sidebar width');
    record('Original delivered renderer reproduces the exact screenshot error before any file or Monaco opens', { error, treeWidth: initialTree.width, snapshot: await snapshot() });
    await capture('reproduced-user-failure'); report.status = 'reproduced'; return;
  }
  await wait(async () => !(await snapshot()).error, 'reopen succeeds');
  assert.ok(initialTree.width > 350);
  assert.ok((await rect('#ideViewFiles')).width > 30);
  assert.equal(await evaluate('currentSessionId'), originalSession);
  record('A first project shows its real files in the unexpanded 530px sidebar; reopening before Monaco exists succeeds');
  await chooseProject(second); await chooseProject(project);
  assert.equal((await snapshot()).error, '');
  assert.equal(await evaluate("document.getElementById('ideMonaco')===null"), true);
  await capture('narrow-first-project-files');
  record('Switching between two projects before opening a file stays usable with visible Files navigation');
  await win.webContents.reload();
  await wait(() => evaluate("typeof currentSessionId==='string' && !!currentSessionId && typeof IexaIDE!=='undefined'"), 'reload');
  await evaluate("(async()=>{await IexaIDE.ready();document.getElementById('filesPanel').style.width='530px';document.getElementById('filesPanel').style.maxWidth='530px';switchWorkbenchView('ide')})()");
  await wait(async () => (await snapshot()).project?.root === project, 'restored empty project');
  chosen = project; await click('#ideOpenFolder');
  assert.equal((await snapshot()).error, '');
  assert.equal(await evaluate("document.getElementById('ideMonaco')===null"), true);
  record('Restarting with an authorized project and zero open files can reopen it without null editor access');
  await click('#ideTree [data-path="main.js"]');
  await wait(() => evaluate("!!document.querySelector('#ideMonaco .view-line')"), 'real Monaco first render');
  const content = 'const firstOpen = "edited from the narrow sidebar";\n';
  await evaluate(`monaco.editor.getModels().find(model=>model.uri.path.endsWith('/main.js')).setValue(${JSON.stringify(content)});true`);
  await click('#ideMoreMenu'); await click('#ideSave');
  await wait(() => fs.readFileSync(path.join(project, 'main.js'), 'utf8') === content, 'saved disk content');
  assert.equal((await snapshot()).expanded, false);
  await capture('narrow-code-saved');
  record('A real visible file click creates Monaco lazily and Save writes exact edited bytes without expanding IDE');
  await click('#ideViewFiles'); await click('#ideTree [data-path="index.html"]');
  await wait(async () => (await snapshot()).activeFile === 'index.html', 'HTML opened');
  await click('#ideRunMenu'); await click('#ideRun');
  await wait(async () => (await snapshot()).server?.status === 'running', 'static server running');
  await click('#ideViewPreview');
  const native = await wait(async () => {
    const view = win.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL().startsWith('http://127.0.0.1:'));
    return view?.getVisible() && await view.webContents.executeJavaScript("document.querySelector('h1')?.textContent==='First project preview'") ? view : false;
  }, 'actual unexpanded native preview');
  const before = native.getBounds(), viewport = await rect('#idePreviewViewport');
  assert.ok(before.width > 350 && before.height > 200);
  assert.ok(Math.abs(before.width - viewport.width) <= 1);
  assert.ok((await rect('#chatInput')).width > 120);
  await capture('narrow-native-preview');
  record('The ordinary unexpanded sidebar displays the real webpage and keeps the original chat composer visible', { nativeBounds: before, viewport });
  await click('#ideViewCode'); await wait(() => !native.getVisible(), 'returning to code hides native page');
  assert.equal((await snapshot()).activeFile, 'index.html');
  assert.equal((await snapshot()).error, '');
  assert.deepEqual(report.diagnostics, []);
  record('Files, code and preview can switch back without obscuring chat or losing buffers; no renderer error');
  report.status = 'passed';
}).catch(async error => {
  report.status = 'failed'; report.error = error.stack || String(error); console.error(report.error); process.exitCode = 1;
  try { report.snapshot = await snapshot(); await capture('failure'); } catch {}
}).finally(async () => {
  save();
  await host?.shutdown(); if (win && !win.isDestroyed()) win.destroy(); await host?.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  console.log('FIRST_OPEN_RESULT ' + JSON.stringify({ status: report.status, checks: report.checks.length, output }));
  app.exit(process.exitCode || 0);
});
