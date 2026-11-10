/* Real Electron integration: full app renderer, production preload/IDE host,
   actual disk files and an isolated native WebContentsView. No model API calls. */
'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, desktopCapturer } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-ide-electron-')));
const output = process.env.IEXA_IDE_ARTIFACT_DIR || path.join(root, '.iexa-artifacts/ide-workbench-20261108/runtime');
fs.mkdirSync(output, { recursive: true });
process.env.IEXA_WORKSPACE = path.join(scratch, 'app-data');
fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const checks = [];
const diagnostics = [];
const runtimeNotices = [];
app.on('web-contents-created', (_event, contents) => contents.on('console-message', event => {
  if (String(event?.message || '').includes('Electron Security Warning')) runtimeNotices.push({ sourceId: event.sourceId, level: event.level, message: event.message, url: contents.getURL() });
}));
let win, server, host, backend;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 18000) {
  const until = Date.now() + timeout; let last;
  do { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(70); } while (Date.now() < until);
  throw new Error(`Timeout: ${label}${last ? ': ' + last.message : ''}`);
}
const evaluate = code => win.webContents.executeJavaScript(code, true);
const record = (name, details) => { checks.push({ name, details, passed: true }); console.log('PASS ' + name); };
const snapshot = () => evaluate('IexaIDE.snapshot()');
const modelExpression = name => `monaco.editor.getModels().find(m => m.uri.path.endsWith(${JSON.stringify('/' + name)}))`;
const previewView = () => win.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL().startsWith('http://127.0.0.1:'));
async function rectangle(selector) { return evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`); }
async function click(selector) {
  const area = await rectangle(selector);
  assert.ok(area.width > 0 && area.height > 0, 'visible click target: ' + selector);
  const x = Math.round(area.x + area.width / 2), y = Math.round(area.y + area.height / 2);
  assert.equal(await evaluate(`!!document.elementFromPoint(${x},${y})?.closest(${JSON.stringify(selector)})`), true, 'reachable click target: ' + selector);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x, y, clickCount: 1 });
  await delay(100);
}
async function menuAction(menu, selector) {
  await click(menu); await click(selector);
}
async function drag(selector, dx, dy) {
  const area = await rectangle(selector); assert.ok(area.width > 0 && area.height > 0, 'visible drag handle: ' + selector);
  const x = Math.round(area.x + area.width / 2), y = Math.round(area.y + area.height / 2);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 }); await delay(100);
  for (let step = 1; step <= 5; step++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x + dx * step / 5), y: Math.round(y + dy * step / 5), movementX: dx / 5, movementY: dy / 5 }); await delay(25); }
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x + dx, y: y + dy, clickCount: 1 }); await delay(180);
}
async function screen(name) {
  await delay(180);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}

app.whenReady().then(async () => {
  const project = path.join(scratch, 'demo-site');
  fs.mkdirSync(path.join(project, 'src/nested'), { recursive: true });
  fs.writeFileSync(path.join(project, 'index.html'), [
    '<!doctype html>', '<html lang="en">', '<head>', '  <meta charset="utf-8">',
    '  <title>IDE live preview</title>', '  <link rel="stylesheet" href="/style.css">', '</head>',
    '<body>', '  <main>', '    <small>IEXA / LOCAL PROJECT</small>',
    '    <h1>Build something<br>you can see.</h1>', '    <p id="message">Ready to edit.</p>',
    '    <a href="/second.html">Open second page →</a>', '  </main>',
    '  <script src="/src/app.js"></script>', '</body>', '</html>', '',
  ].join('\n'));
  fs.writeFileSync(path.join(project, 'style.css'), 'body{margin:0;background:#181725;color:#edeaf8;font:18px system-ui}main{padding:52px 32px}small{color:#ae8df4;font-size:11px;letter-spacing:2px}h1{font-size:42px;line-height:1.12;letter-spacing:-1.5px}p{color:#b1a8c8}a{color:#ba9cf7;font-size:13px}');
  fs.writeFileSync(path.join(project, 'src/app.js'), 'document.getElementById("message").textContent = "Preview is running.";\n');
  fs.writeFileSync(path.join(project, 'src/nested/data.json'), '{"hello":"workspace"}\n');
  fs.writeFileSync(path.join(project, 'second.html'), '<!doctype html><h1>Second page</h1><a href="/">Home</a>');
  const otherProject = path.join(scratch, 'another-project'); fs.mkdirSync(otherProject);
  fs.writeFileSync(path.join(otherProject, 'index.html'), '<h1>Independent project</h1>');
  let pickerPath = project;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickerPath] });
  ipcMain.on('iexa:get-initial-appearance', event => { event.returnValue = {}; });
  ipcMain.on('iexa:get-window-state', event => { event.returnValue = { maximized: false, fullscreen: false }; });
  ipcMain.handle('iexa:window-command', () => ({}));
  ipcMain.handle('iexa:desktop-live-state', () => ({ open: false }));
  backend = require('../dist/main/server');
  server = await backend.startServer(0, false);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const code = backend.getServerCredentials(server).loginCode;
  win = new BrowserWindow({ width: 1540, height: 980, show: false, skipTaskbar: true, useContentSize: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(root, 'preload.js'), backgroundThrottling: false } });
  win.setMenuBarVisibility(false);
  win.showInactive();
  win.webContents.on('console-message', event => { if (event?.level === 'error') diagnostics.push({ source: 'main', message: event.message, sourceId: event.sourceId, lineNumber: event.lineNumber }); });
  host = require('../resources/ide-host.cjs').installIDEHost({ ipcMain, dialog, WebContentsView, session, getWindow: () => win, appOrigin: origin, workspaceFile: name => path.join(process.env.IEXA_WORKSPACE, name) });
  await win.loadURL(origin + '/#login=' + code);
  await waitFor(() => evaluate("typeof currentSessionId === 'string' && !!currentSessionId && typeof IexaIDE !== 'undefined'"), 'application ready');
  const originalChat = await evaluate('currentSessionId');
  await click('[data-workbench-view=ide]'); await click('#ideOpenFolder');
  await waitFor(async () => (await snapshot()).project?.root === project, 'picker-authorized project');
  assert.equal(await evaluate('currentSessionId'), originalChat);
  await screen('ide-default');
  record('right-side IDE opens a real directory without switching the current conversation');
  if (!(await snapshot()).expanded) await evaluate('IexaIDE.toggleExpand();true');
  await evaluate("document.querySelector('#ideTree [data-path=src]').click();true");
  await waitFor(() => evaluate("!!document.querySelector('#ideTree [data-path=\"src/nested\"]')"), 'nested directory');
  await evaluate("document.querySelector('#ideTree [data-path=\"src/nested\"]').click();true");
  await waitFor(() => evaluate("!!document.querySelector('#ideTree [data-path=\"src/nested/data.json\"]')"), 'deep file tree');
  await evaluate("IexaIDE.openFile('index.html')");
  await evaluate("IexaIDE.openFile('style.css')");
  await evaluate("IexaIDE.openFile('src/app.js')");
  await waitFor(() => evaluate("document.querySelectorAll('#ideMonaco .view-line').length > 0"), 'real Monaco rendered lines');
  assert.equal((await snapshot()).files.length, 3);
  const workerResult = await evaluate(`(async()=>{const model=${modelExpression('src/app.js')};const factory=await monaco.languages.typescript.getJavaScriptWorker();const worker=await factory(model.uri);return await worker.getSyntacticDiagnostics(model.uri.toString())})()`);
  assert.deepEqual(workerResult, []);
  record('local Monaco renders with three open files and an expandable multilevel directory tree');
  await menuAction('#ideRunMenu', '#ideRun');
  await waitFor(async () => (await snapshot()).server?.status === 'running', 'static server');
  const native = await waitFor(async () => { const view = previewView(); return view && await view.webContents.executeJavaScript("document.getElementById('message')?.textContent === 'Preview is running.'") ? view : false; }, 'native WebContents preview');
  await waitFor(() => evaluate("IexaIDE.snapshot().previewAttached === IexaIDE.snapshot().workspaceId"), 'preview attached');
  const preferences = native.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.ok(!preferences.preload);
  assert.notEqual(native.webContents.session, win.webContents.session);
  assert.equal(await native.webContents.executeJavaScript('typeof window.iexaDesktop'), 'undefined');
  const applicationAccess = await native.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/sessions')}).then(()=>true,()=>false)`);
  assert.equal(applicationAccess, false);
  record('preview runs in an isolated native WebContents with no Node, preload, app IPC or access to app API');
  const inputBounds = await rectangle('#chatInput'), ideBounds = await rectangle('#idePanel'), chatBounds = await rectangle('.chat-container');
  assert.ok(inputBounds.width > 120 && inputBounds.bottom <= 980 && inputBounds.right <= ideBounds.left + 1, JSON.stringify({ inputBounds, ideBounds }));
  assert.ok(chatBounds.right <= ideBounds.left + 1 && (await rectangle('#ideMonaco')).width >= 240);
  assert.equal(await evaluate("document.querySelector('[data-view=bots] use').getAttribute('href')"), '#ui-bot-team');
  assert.equal(await evaluate("document.querySelector('#ideAI use').getAttribute('href')"), '#ui-ide-spark');
  record('original chat composer, live code and native preview remain visible together; both requested icons are replaced');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.files-panel-title')).display"), 'none');
  // Frequently used actions stay on one compact row. Secondary task/editor
  // actions must become genuinely reachable through their visible menus.
  const toolbar = await rectangle('.ide-topbar'); assert.ok(toolbar.height <= 42);
  for (const selector of ['#ideRunFile', '#ideRunMenu', '#ideAI', '#ideExpand', '#ideMoreMenu']) {
    const bounds = await rectangle(selector);
    assert.ok(bounds.width > 0 && bounds.left >= toolbar.left && bounds.right <= toolbar.right + 1 && bounds.bottom <= toolbar.bottom + 1, 'reachable toolbar control: ' + selector);
  }
  assert.equal((await rectangle('#ideRunTask')).width, 0, 'secondary task actions start collapsed');
  await click('#ideRunMenu');
  for (const selector of ['#ideTasks', '#ideRunTask', '#ideScript', '#ideStop']) {
    const bounds = await rectangle(selector);
    assert.ok(bounds.width > 0 && bounds.left >= 0 && bounds.right <= 1540 && bounds.bottom <= 980, 'reachable run-menu control: ' + selector);
  }
  assert.equal(native.getVisible(), false, 'opening a menu keeps it above the native preview');
  await click('#ideMoreMenu');
  assert.equal((await rectangle('#ideRunTask')).width, 0, 'only one menu stays open');
  for (const selector of ['#ideSave', '#ideFind', '#ideTerminal', '#ideCommands']) {
    const bounds = await rectangle(selector); assert.ok(bounds.width > 0, 'reachable editor-menu control: ' + selector);
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(() => native.getVisible(), 'closing menus restores native preview');
  await click('#ideRunMenu');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
  assert.equal(await evaluate("document.activeElement === [...document.querySelectorAll('#ideRunMenuPopup :is(button,select):not(:disabled)')].at(-1)"), true, 'ArrowUp from trigger focuses the final available action');
  await screen('ide-run-menu');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  assert.equal(await evaluate("document.activeElement.id"), 'ideRunMenu');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  assert.equal(await evaluate("document.activeElement.id"), 'ideTasks', 'ArrowDown from trigger focuses the first task control');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(() => native.getVisible(), 'keyboard dismissal restores native preview');
  assert.equal((await rectangle('#ideSave')).width, 0);
  const bottomPanel = await rectangle('#ideBottomPanel'), mainPanel = await rectangle('#ideMain');
  assert.ok(Math.abs(bottomPanel.width - mainPanel.width) <= 1 && bottomPanel.width > (await rectangle('#idePreviewColumn')).width);
  await evaluate("document.getElementById('ideViewCode').click();true");
  await waitFor(() => !native.getVisible(), 'code-only mode hides native preview');
  assert.ok((await rectangle('#ideMonaco')).width > 400);
  await evaluate("document.getElementById('ideViewPreview').click();true");
  await waitFor(() => native.getVisible(), 'preview-only mode shows native page');
  assert.equal((await rectangle('#ideEditorColumn')).width, 0);
  await evaluate("document.getElementById('ideViewSplit').click();true");
  await waitFor(() => native.getVisible(), 'split mode restores native page');
  record('compact toolbar and shared bottom dock preserve independent code, preview and split modes');
  await drag('#filesResizer', 36, 0);
  assert.ok((await rectangle('.chat-container')).width > chatBounds.width + 20);
  const explorerBefore = await rectangle('#ideExplorer'); await drag('#ideExplorerResizer', 22, 0);
  assert.ok((await rectangle('#ideExplorer')).width > explorerBefore.width + 10);
  const previewBefore = await rectangle('#idePreviewColumn'); await drag('#idePreviewResizer', -24, 0);
  assert.ok((await rectangle('#idePreviewColumn')).width > previewBefore.width + 10);
  if (!(await rectangle('#ideLogs')).height) await click('#ideLogTab');
  const logsBefore = await rectangle('#ideLogs'); await drag('#ideLogsResizer', 0, -24);
  assert.ok((await rectangle('#ideLogs')).height > logsBefore.height + 10);
  record('real mouse drags resize chat, file explorer, editor/preview boundary and log height');
  const changedJS = 'document.getElementById("message").textContent = "Edited JavaScript is live.";\n';
  await evaluate(`${modelExpression('src/app.js')}.setValue(${JSON.stringify(changedJS)});true`);
  assert.equal((await snapshot()).files.find(file => file.path === 'src/app.js').dirty, true);
  await evaluate('IexaIDE.save()');
  assert.equal(fs.readFileSync(path.join(project, 'src/app.js'), 'utf8'), changedJS);
  await waitFor(() => native.webContents.executeJavaScript("document.getElementById('message')?.textContent === 'Edited JavaScript is live.'"), 'JavaScript live reload');
  await evaluate("IexaIDE.openFile('style.css')");
  const changedCSS = fs.readFileSync(path.join(project, 'style.css'), 'utf8') + '\nbody{background:rgb(30,25,47)}\n';
  await evaluate(`${modelExpression('style.css')}.setValue(${JSON.stringify(changedCSS)});IexaIDE.save()`);
  await waitFor(() => native.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor === 'rgb(30, 25, 47)'"), 'CSS live reload');
  record('saving JavaScript and CSS updates actual disk files and the running webpage');
  fs.writeFileSync(path.join(project, 'src/app.js'), changedJS + '// external agent edit\n');
  await waitFor(() => evaluate(`${modelExpression('src/app.js')}.getValue().includes('external agent edit')`), 'external file synchronizes');
  await evaluate("IexaIDE.openFile('src/app.js')");
  await evaluate(`${modelExpression('src/app.js')}.setValue('/* my unsaved edit */');true`);
  fs.writeFileSync(path.join(project, 'src/app.js'), changedJS + '// newer agent edit\n');
  await waitFor(async () => (await snapshot()).files.find(file => file.path === 'src/app.js')?.conflict, 'dirty external conflict');
  assert.equal(await evaluate(`${modelExpression('src/app.js')}.getValue()`), '/* my unsaved edit */');
  await evaluate('IexaIDE.save()');
  assert.match(fs.readFileSync(path.join(project, 'src/app.js'), 'utf8'), /newer agent edit/);
  await screen('ide-conflict');
  // The existing in-document confirmation is exercised rather than replaced.
  await evaluate("document.getElementById('ideReloadDisk').click();true");
  await waitFor(() => evaluate("!!document.querySelector('dialog[open] .btn-primary')"), 'discard confirmation');
  await evaluate("document.querySelector('dialog[open] .btn-primary').click();true");
  await waitFor(async () => !(await snapshot()).files.find(file => file.path === 'src/app.js')?.conflict, 'reload resolves conflict');
  record('external writes update clean models; dirty edits survive and stale saves cannot overwrite newer disk contents');
  await native.webContents.executeJavaScript("console.error('IDE_PREVIEW_ERROR_PROBE')");
  await waitFor(() => evaluate("document.getElementById('ideLogs').textContent.includes('IDE_PREVIEW_ERROR_PROBE')"), 'browser console error in IDE log');
  await evaluate("document.getElementById('ideErrorsTab').click();true");
  assert.match(await evaluate("document.getElementById('ideLogs').textContent"), /IDE_PREVIEW_ERROR_PROBE/);
  assert.equal((await snapshot()).logMode, 'errors');
  await evaluate("document.getElementById('ideLogTab').click();true");
  record('real browser console errors reach IDE logs');
  // A clearly labeled persisted example conversation exercises the existing
  // transcript renderer without making or claiming an online model request.
  const chatStoreFile = path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions.json');
  const chatStore = JSON.parse(fs.readFileSync(chatStoreFile, 'utf8'));
  const exampleId = 'sess_ide_example'; const exampleTime = Date.now();
  chatStore.sessions.push({ id: exampleId, title: 'IDE 并排开发示例', created: exampleTime, updated: exampleTime, messageCount: 2, projectRoot: project, projectName: 'demo-site' });
  fs.writeFileSync(chatStoreFile, JSON.stringify(chatStore));
  fs.mkdirSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions', exampleId + '.json'), JSON.stringify([
    { role: 'user', content: '示例对话：修改首页的标题和背景，保留右侧实时预览。', timestamp: exampleTime },
    { role: 'assistant', content: '示例对话：代码编辑器和网页预览会与聊天并排显示。你可以继续输入，同时查看文件更新。', status: 'done', timestamp: exampleTime + 1, durationMs: 1000 },
  ]));
  await evaluate(`switchSession(${JSON.stringify(exampleId)})`);
  await waitFor(() => evaluate("document.querySelectorAll('#chatMessages .message').length === 2"), 'existing transcript renders beside IDE');
  await evaluate("document.getElementById('ideFileSearch').value='data.json';document.getElementById('ideFileSearch').dispatchEvent(new Event('input'));true");
  await waitFor(() => evaluate("document.querySelectorAll('#ideTree [data-path]').length === 1 && !!document.querySelector('#ideTree [data-path=\"src/nested/data.json\"]')"), 'file search');
  await evaluate("document.getElementById('ideFileSearch').value='';document.getElementById('ideFileSearch').dispatchEvent(new Event('input'));true");
  await delay(260);
  await evaluate("IexaIDE.openFile('index.html')");
  await evaluate("setThemeMode('light');true");
  await screen('ide-light');
  const nativeWindow = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1540, height: 1020 } })).find(source => source.id === win.getMediaSourceId());
  if (nativeWindow && !nativeWindow.thumbnail.isEmpty()) fs.writeFileSync(path.join(output, 'ide-window-capture.png'), nativeWindow.thumbnail.toPNG());
  // The window compositor omits child surfaces in a hidden test window. Keep
  // the independently captured native surface as evidence and composite a
  // clearly named artifact using its actual measured bounds.
  const nativePNG = (await native.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
  fs.writeFileSync(path.join(output, 'preview-native.png'), nativePNG);
  const sharp = require('sharp');
  const nativeBounds = native.getBounds();
  await sharp(path.join(output, 'ide-light.png')).composite([{ input: await sharp(nativePNG).resize(nativeBounds.width, nativeBounds.height).png().toBuffer(), left: nativeBounds.x, top: nativeBounds.y }]).toFile(path.join(output, 'ide-light-composite.png'));
  await evaluate("setThemeMode('dark');true");
  await screen('ide-dark');
  await evaluate("document.querySelector('[data-workbench-view=files]').click();true");
  await waitFor(() => !native.getVisible(), 'native preview hidden on another tab');
  await evaluate("document.querySelector('[data-workbench-view=ide]').click();true");
  assert.equal((await snapshot()).files.length, 3);
  await waitFor(() => native.getVisible(), 'native preview restored');
  pickerPath = otherProject;
  await evaluate("document.getElementById('ideOpenFolder').click();true");
  await waitFor(async () => (await snapshot()).project?.root === otherProject, 'second workspace');
  assert.equal((await snapshot()).files.length, 0);
  await evaluate(`(async()=>IexaIDE.openProject((await iexaDesktop.ide.projects()).projects.find(p=>p.root===${JSON.stringify(project)})))()`);
  assert.equal((await snapshot()).files.length, 3);
  record('file search, tab switching and multiple projects preserve independent editor state');
  // Exercise existing AI tools against the same real file, then observe the UI.
  const { FileTools } = require('../dist/main/tools/ToolExecutors');
  const tools = new FileTools();
  const currentFile = fs.readFileSync(path.join(project, 'src/app.js'), 'utf8');
  const toolResult = await tools.writeFile('src/app.js', currentFile + '// existing FileTools write\n', project);
  assert.equal(toolResult.success, true, toolResult.output);
  await waitFor(() => evaluate(`${modelExpression('src/app.js')}.getValue().includes('existing FileTools write')`), 'real existing Agent file tools synchronize');
  await evaluate("document.getElementById('chatInput').value='继续修改页面，我会在右侧查看实时变化。';document.getElementById('chatInput').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('ideAI').click();true");
  await waitFor(() => evaluate(`currentSessionId === ${JSON.stringify(exampleId)} && document.activeElement === document.getElementById('chatInput')`), 'project-bound AI conversation');
  assert.equal(await evaluate("document.getElementById('chatInput').value"), '继续修改页面，我会在右侧查看实时变化。');
  const context = require('../dist/main/ide/IDEContext').getIDEContextForRoot(project);
  assert.match(context, /index\.html/); assert.match(context, /IDE_PREVIEW_ERROR_PROBE/);
  await evaluate("document.getElementById('ideLogsClear').click();true");
  assert.equal((await snapshot()).expanded, true); assert.equal((await snapshot()).active, true);
  assert.ok((await rectangle('#chatInput')).right <= (await rectangle('#idePanel')).left + 1);
  record('existing AI file tools synchronize the editor; Ask AI opens a matching project conversation and preserves the draft', { liveModelRequest: false });
  await screen('ide-parallel-chat');
  const parallelWindow = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1540, height: 1020 } })).find(source => source.id === win.getMediaSourceId());
  if (parallelWindow && !parallelWindow.thumbnail.isEmpty()) fs.writeFileSync(path.join(output, 'ide-parallel-window.png'), parallelWindow.thumbnail.toPNG());
  await evaluate("document.querySelector('[data-workbench-view=ide]').click();true");
  if (!(await snapshot()).expanded) await evaluate('IexaIDE.toggleExpand();true');
  win.setContentSize(1024, 768); await delay(300); await screen('ide-narrow');
  const bounds = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panel:document.getElementById('idePanel').getBoundingClientRect().toJSON()})");
  assert.ok(bounds.scrollWidth <= bounds.width); assert.ok(bounds.panel.right <= bounds.width + 1);
  assert.equal((await rectangle('#idePreviewColumn')).width, 0);
  await waitFor(() => !native.getVisible(), 'narrow code tab hides native preview');
  await evaluate("document.getElementById('ideViewPreview').click();true");
  await waitFor(() => native.getVisible(), 'narrow preview tab shows actual native page');
  assert.ok((await rectangle('#chatInput')).width > 120);
  assert.equal((await rectangle('#ideEditorColumn')).width, 0);
  await screen('ide-narrow-preview');
  const narrowWindow = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1024, height: 800 } })).find(source => source.id === win.getMediaSourceId());
  if (narrowWindow && !narrowWindow.thumbnail.isEmpty()) fs.writeFileSync(path.join(output, 'ide-narrow-window.png'), narrowWindow.thumbnail.toPNG());
  await evaluate("document.getElementById('ideViewCode').click();true");
  await waitFor(() => !native.getVisible(), 'narrow return to code');
  win.setContentSize(1540, 980); await delay(200);
  await evaluate("document.getElementById('ideViewSplit').click();true");
  const lastURL = (await snapshot()).server.url;
  await menuAction('#ideRunMenu', '#ideStop');
  await waitFor(async () => (await snapshot()).server.status === 'stopped', 'stop');
  await assert.rejects(fetch(lastURL));
  record('stopping closes the actual preview listener; narrow layout stays within the window');
  // A new renderer recreates Monaco models from persisted project/file state.
  await win.webContents.reload();
  await waitFor(() => evaluate("typeof currentSessionId === 'string' && !!currentSessionId && typeof IexaIDE !== 'undefined'"), 'renderer reloaded');
  await evaluate("(async()=>{await IexaIDE.ready();switchWorkbenchView('ide')})()");
  await waitFor(() => evaluate("typeof IexaIDE !== 'undefined' && IexaIDE.snapshot().files.length === 3"), 'persisted tabs after renderer restart');
  assert.equal(fs.readFileSync(path.join(project, 'style.css'), 'utf8'), changedCSS);
  record('saved disk content and project tabs survive renderer restart');
  const quitJS = (await evaluate(`${modelExpression('src/app.js')}.getValue()`)) + '// saved during window close\n';
  await evaluate(`${modelExpression('src/app.js')}.setValue(${JSON.stringify(quitJS)});true`);
  const workspaceId = (await snapshot()).workspaceId;
  const closeServer = await evaluate(`iexaDesktop.ide.start({workspaceId:${JSON.stringify(workspaceId)}})`);
  dialog.showMessageBox = async () => ({ response: 2 });
  assert.equal(await host.requestQuit(), false);
  assert.equal((await fetch(closeServer.url)).status, 200);
  assert.equal(await evaluate('IexaIDE.hasUnsavedChanges()'), true);
  await evaluate(`iexaDesktop.ide.read({workspaceId:${JSON.stringify(workspaceId)},path:'src/app.js'})`);
  record('canceling exit preserves unsaved edits, preview listener and working file IPC');
  dialog.showMessageBox = async () => ({ response: 0 });
  assert.equal(await host.requestQuit(), true);
  assert.equal(fs.readFileSync(path.join(project, 'src/app.js'), 'utf8'), quitJS);
  await assert.rejects(fetch(closeServer.url));
  record('saving during exit writes all dirty files before preview services are stopped');
  fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ checks, diagnostics, runtimeNotices, completed: true }, null, 2));
  console.log('IEXA_IDE_RESULT ' + JSON.stringify({ passed: checks.length, output }));
}).catch(async error => {
  console.error(error.stack || error); process.exitCode = 1;
  if (win && !win.isDestroyed()) { try { fs.writeFileSync(path.join(output, 'failure.png'), (await win.capturePage()).toPNG()); diagnostics.push({ snapshot: await snapshot() }); } catch {} }
  fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ checks, diagnostics, runtimeNotices, error: error.stack || String(error), completed: false }, null, 2));
}).finally(async () => {
  try { await host?.shutdown(); } catch {}
  if (win && !win.isDestroyed()) win.destroy();
  try { await host?.dispose(); } catch {}
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  app.exit(process.exitCode || 0);
});
