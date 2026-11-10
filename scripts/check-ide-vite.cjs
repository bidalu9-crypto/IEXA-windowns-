/* An explicitly prepared Vite fixture, real IDE IPC and native Chromium HMR. */
'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.iexa-artifacts/ide-workbench-20261108');
const source = path.join(output, 'vite-fixture');
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-ide-vite-')));
const project = path.join(scratch, process.env.IEXA_IDE_VITE_SPECIAL_PATH === '1' ? 'vite project 测试 &' : 'vite project 测试');
fs.mkdirSync(project); for (const name of ['index.html', 'package.json', 'main.js', 'style.css']) fs.copyFileSync(path.join(source, name), path.join(project, name));
fs.symlinkSync(path.join(source, 'node_modules'), path.join(project, 'node_modules'), 'junction');
process.env.IEXA_WORKSPACE = path.join(scratch, 'app-data'); fs.mkdirSync(process.env.IEXA_WORKSPACE);
app.setPath('userData', path.join(scratch, 'profile'));
let win, server, host;
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { console.log('PASS ' + name); checks.push({ name, passed: true }); };
async function wait(fn, label, timeout = 25000) { const end = Date.now() + timeout; do { try { if (await fn()) return; } catch {} await delay(70); } while (Date.now() < end); throw Error('Timeout: ' + label); }
app.whenReady().then(async () => {
  const backend = require('../dist/main/server'); server = await backend.startServer(0, false);
  const origin = 'http://127.0.0.1:' + server.address().port;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  ipcMain.on('iexa:get-initial-appearance', event => { event.returnValue = {}; }); ipcMain.on('iexa:get-window-state', event => { event.returnValue = {}; });
  ipcMain.handle('iexa:window-command', () => ({})); ipcMain.handle('iexa:desktop-live-state', () => ({ open: false }));
  win = new BrowserWindow({ show: false, width: 1440, height: 900, skipTaskbar: true, webPreferences: { preload: path.join(root, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  host = require('../resources/ide-host.cjs').installIDEHost({ ipcMain, dialog, WebContentsView, session, getWindow: () => win, appOrigin: origin, workspaceFile: name => path.join(process.env.IEXA_WORKSPACE, name) });
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  await win.loadURL(origin + '/#login=' + backend.getServerCredentials(server).loginCode);
  await wait(() => evaluate("typeof currentSessionId === 'string' && !!currentSessionId"), 'app ready');
  await evaluate("switchWorkbenchView('ide');document.getElementById('ideOpenFolder').click();true");
  await wait(() => evaluate('!!IexaIDE.snapshot().workspaceId'), 'folder chosen');
  await wait(() => evaluate("!!document.querySelector('#ideScript option[value=dev]')"), 'project inspection ready');
  await evaluate("IexaIDE.toggleExpand();document.getElementById('ideRun').click();true");
  await wait(() => evaluate("!!document.querySelector('dialog[open] .btn-primary')"), 'script confirmation');
  assert.match(await evaluate("document.querySelector('dialog[open]').textContent"), /dev: vite/);
  assert.equal(await evaluate('IexaIDE.snapshot().server.status'), 'stopped');
  await evaluate("document.querySelector('dialog[open] .btn-primary').click();true");
  await wait(() => evaluate("IexaIDE.snapshot().server.status === 'running'"), 'Vite running');
  let native;
  await wait(() => (native = win.contentView.children.find(view => view.webContents && view.webContents.getURL().startsWith('http://127.0.0.1:'))), 'native preview attached');
  const page = code => native.webContents.executeJavaScript(code);
  await wait(() => page("document.getElementById('value')?.textContent === 'VITE_INITIAL'"), 'Vite rendered');
  record('real Vite project starts through confirmed script in a path with Chinese and spaces');
  await page("window.__hmrMarker='preserved'");
  const css = await evaluate("iexaDesktop.ide.read({workspaceId:IexaIDE.snapshot().workspaceId,path:'style.css'})");
  await evaluate(`iexaDesktop.ide.write({workspaceId:IexaIDE.snapshot().workspaceId,path:'style.css',revision:${JSON.stringify(css.revision)},content:${JSON.stringify(css.content + '\nbody{background:rgb(28,20,45)}\n')}})`);
  await wait(() => page("getComputedStyle(document.body).backgroundColor === 'rgb(28, 20, 45)'"), 'Vite CSS HMR');
  assert.equal(await page('window.__hmrMarker'), 'preserved');
  const js = await evaluate("iexaDesktop.ide.read({workspaceId:IexaIDE.snapshot().workspaceId,path:'main.js'})");
  await evaluate(`iexaDesktop.ide.write({workspaceId:IexaIDE.snapshot().workspaceId,path:'main.js',revision:${JSON.stringify(js.revision)},content:${JSON.stringify(js.content.replace('VITE_INITIAL', 'VITE_HMR_UPDATED'))}})`);
  await wait(() => page("document.getElementById('value')?.textContent === 'VITE_HMR_UPDATED'"), 'Vite JS HMR');
  assert.equal(await page('window.__hmrMarker'), 'preserved');
  record('CSS and JavaScript update through actual Vite WebSocket HMR without a document reload');
  await page("console.error('VITE_REAL_ERROR_PROBE')");
  await wait(() => evaluate("document.getElementById('ideLogs').textContent.includes('VITE_REAL_ERROR_PROBE')"), 'Vite error log');
  record('native Vite webpage errors reach the IDE and current Agent diagnostics');
  const address = await evaluate('IexaIDE.snapshot().server.url');
  await evaluate("document.getElementById('ideStop').click();true");
  await wait(() => evaluate("IexaIDE.snapshot().server.status === 'stopped'"), 'Vite stopped');
  await assert.rejects(fetch(address)); record('stopping Vite closes its actual listener');
  fs.writeFileSync(path.join(output, 'vite-checks.json'), JSON.stringify({ checks, completed: true, vite: '7.3.1' }, null, 2));
}).catch(async error => { console.error(error.stack || error); if (win && !win.isDestroyed()) console.error(await win.webContents.executeJavaScript("JSON.stringify({snapshot:IexaIDE.snapshot(),status:document.getElementById('ideStatus').textContent,dialogs:[...document.querySelectorAll('dialog')].map(d=>({text:d.textContent,open:d.open}))})")); process.exitCode = 1; fs.writeFileSync(path.join(output, 'vite-checks.json'), JSON.stringify({ checks, error: error.stack || String(error), completed: false }, null, 2)); }).finally(async () => {
  await host?.shutdown(); if (win && !win.isDestroyed()) win.destroy(); await host?.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  // Unlink the test junction first; never recurse through the fixture's modules.
  try { fs.unlinkSync(path.join(project, 'node_modules')); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  app.exit(process.exitCode || 0);
});
