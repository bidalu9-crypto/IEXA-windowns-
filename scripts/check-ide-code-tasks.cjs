/* Real generic-language execution through IDE buttons and the existing PTY. */
'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const appRoot = path.resolve(process.env.IEXA_IDE_TEST_APP_ROOT || repo);
const output = process.env.IEXA_IDE_ARTIFACT_DIR || path.join(repo, '.iexa-artifacts/ide-first-open-fix-20261108', process.env.IEXA_IDE_TEST_APP_ROOT ? 'packaged-code-tasks' : 'code-tasks');
fs.mkdirSync(output, { recursive: true });
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-code-tasks-')));
const projects = { python: path.join(scratch, "Python 中文 & ' project"), node: path.join(scratch, 'Node project'), dotnet: path.join(scratch, 'CSharp project') };
const data = path.join(scratch, 'data');
for (const root of [...Object.values(projects), data]) fs.mkdirSync(root);
const token = crypto.randomUUID();
const pythonContent = `import json, os, sys\nprint('PYTHON_IDE_OK ${token}', flush=True)\nwith open('python-receipt.json', 'w', encoding='utf-8') as f: json.dump({'token':'${token}','cwd':os.getcwd(),'version':sys.version},f)\n`;
fs.writeFileSync(path.join(projects.python, 'main.py'), '# saved by the real IDE before running\n');
fs.writeFileSync(path.join(projects.python, 'slow.py'), "import os, time\nprint('SLOW_TASK_STARTED PID=' + str(os.getpid()), flush=True)\ntime.sleep(120)\n");
fs.writeFileSync(path.join(projects.python, 'unsupported.xyz'), 'plain text\n');
fs.writeFileSync(path.join(projects.node, 'main.js'), `const fs=require('node:fs');console.log('NODE_IDE_OK ${token}');fs.writeFileSync('node-receipt.json',JSON.stringify({token:'${token}',cwd:process.cwd(),version:process.version}));\n`);
fs.writeFileSync(path.join(projects.node, 'fail.js'), "console.error('EXPECTED_FAILURE_7');process.exit(7);\n");
fs.writeFileSync(path.join(projects.node, 'package.json'), JSON.stringify({ name: 'iexa-task-fixture', version: '1.0.0', scripts: { start: 'node main.js', build: 'node build.cjs', test: 'node test.cjs' } }, null, 2));
fs.writeFileSync(path.join(projects.node, 'build.cjs'), `require('node:fs').writeFileSync('build-receipt.json',JSON.stringify({token:'${token}',cwd:process.cwd()}));console.log('NODE_BUILD_OK');\n`);
fs.writeFileSync(path.join(projects.node, 'test.cjs'), "console.log('NODE_TEST_OK');\n");
fs.writeFileSync(path.join(projects.dotnet, 'ConsoleFixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
fs.writeFileSync(path.join(projects.dotnet, 'Program.cs'), `using System.Text.Json;\nConsole.WriteLine("DOTNET_IDE_OK ${token}");\nFile.WriteAllText("dotnet-receipt.json",JsonSerializer.Serialize(new {token="${token}",cwd=Directory.GetCurrentDirectory(),version=Environment.Version.ToString()}));\n`);
process.env.IEXA_WORKSPACE = data;
app.setPath('userData', path.join(scratch, 'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
let win, host, server, chosen;
const report = { appRoot, token, projects, scope: 'Real Electron renderer, production IPC planner, actual existing TerminalManager/ConPTY; no model API or webpage server required', checks: [], diagnostics: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
const snapshot = () => evaluate('IexaIDE.snapshot()');
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const record = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); save(); };
async function wait(fn, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await pause(70); }
  throw Error('Timeout: ' + label + (last ? ': ' + last.message : ''));
}
async function rect(selector) { return evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`); }
async function click(selector) {
  const r = await rect(selector); assert.ok(r.width > 0 && r.height > 0, 'visible: ' + selector);
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  assert.equal(await evaluate(`!!document.elementFromPoint(${x},${y})?.closest(${JSON.stringify(selector)})`), true, 'reachable: ' + selector);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x, y, clickCount: 1 }); await pause(100);
}
async function capture(name) {
  await pause(150); fs.writeFileSync(path.join(output, name + '-renderer.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  const source = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1384, height: 900 } })).find(value => value.id === win.getMediaSourceId());
  if (source && !source.thumbnail.isEmpty()) fs.writeFileSync(path.join(output, name + '-window.png'), source.thumbnail.toPNG());
}
async function choose(key) {
  chosen = projects[key]; await click('#ideOpenFolder');
  await wait(async () => (await snapshot()).project?.root === chosen, 'open ' + key);
}
async function openFile(file) {
  const selector = '#ideTree [data-path=' + JSON.stringify(file) + ']';
  if (!(await rect('#ideTree')).width) await click('#ideViewFiles');
  await wait(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 'tree entry ' + file);
  await click(selector); await wait(async () => (await snapshot()).activeFile === file, 'active file ' + file);
  await wait(() => evaluate("!!document.querySelector('#ideMonaco .view-line')"), 'Monaco rendered');
}
const taskState = () => evaluate('IexaIDEAgent.taskState(IexaIDE.snapshot().workspaceId)');
async function run(kind = 'file') {
  if (kind === 'file') await click('#ideRunFile');
  else {
    await click('#ideRunMenu');
    await evaluate(`document.getElementById('ideTasks').value=${JSON.stringify(kind)};document.getElementById('ideTasks').dispatchEvent(new Event('change',{bubbles:true}));true`);
    await click('#ideRunTask');
  }
  await wait(() => evaluate("!!document.querySelector('dialog.iexa-app-dialog[open]')"), 'actual command confirmation');
  const confirmation = await evaluate("document.querySelector('dialog.iexa-app-dialog p').textContent");
  assert.ok(confirmation.includes(chosen), 'confirmation contains actual authorized cwd');
  await click('dialog.iexa-app-dialog .btn-primary');
  return wait(async () => { const task = await taskState(); return task?.kind === kind && task.status === 'running' ? task : false; }, 'actual task created');
}
async function finish(label, expectedExit = 0, timeout = 35000) {
  const task = await wait(async () => { const value = await taskState(); return ['completed', 'failed'].includes(value?.status) ? value : false; }, label, timeout);
  assert.equal(task.exitCode, expectedExit, JSON.stringify(task));
  assert.equal(task.status, expectedExit === 0 ? 'completed' : 'failed');
  assert.ok(task.sessionRunning, 'persistent shell remains alive after program exit');
  const name = report.checks.length + '-' + label.replace(/[^a-z0-9]+/gi, '-').slice(0, 65);
  fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(task, null, 2));
  assert.ok((await rect('#chatInput')).width > 120, 'original composer visible');
  assert.ok((await rect('#ideMonaco')).width > 200, 'code remains visible');
  assert.equal((await snapshot()).server?.status === 'running', false, 'no web preview needed');
  return task;
}
app.whenReady().then(async () => {
  const backend = require(path.join(appRoot, 'dist/main/server'));
  server = await backend.startServer(0, false);
  const origin = `http://127.0.0.1:${server.address().port}`;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  ipcMain.on('iexa:get-initial-appearance', event => { event.returnValue = {}; });
  ipcMain.on('iexa:get-window-state', event => { event.returnValue = {}; });
  ipcMain.handle('iexa:window-command', () => ({})); ipcMain.handle('iexa:desktop-live-state', () => ({ open: false }));
  win = new BrowserWindow({ width: 1384, height: 860, useContentSize: true, show: false, skipTaskbar: true, webPreferences: { preload: path.join(appRoot, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.setMenuBarVisibility(false); win.showInactive();
  win.webContents.on('console-message', event => { if (event?.level === 'error') report.diagnostics.push({ message: event.message, sourceId: event.sourceId }); });
  host = require(path.join(appRoot, 'resources/ide-host.cjs')).installIDEHost({ ipcMain, dialog, WebContentsView, session, getWindow: () => win, appOrigin: origin, workspaceFile: name => path.join(data, name) });
  await win.loadURL(origin + '/#login=' + backend.getServerCredentials(server).loginCode);
  await wait(() => evaluate("typeof currentSessionId==='string' && !!currentSessionId && typeof IexaIDE!=='undefined'"), 'original chat ready');
  await evaluate("document.getElementById('filesPanel').style.width='530px';document.getElementById('filesPanel').style.maxWidth='530px';document.getElementById('chatInput').value='保留原对话，运行非网页代码';true");
  await click('[data-workbench-view="ide"]'); await evaluate('IexaIDE.ready()');
  await choose('python'); await openFile('main.py');
  await evaluate(`monaco.editor.getModels().find(model=>model.uri.path.endsWith('/main.py')).setValue(${JSON.stringify(pythonContent)});true`);
  assert.ok((await snapshot()).files.find(file => file.path === 'main.py').dirty);
  await run();
  const python = await finish('python-dirty-file'); assert.ok(python.output.includes('PYTHON_IDE_OK ' + token));
  assert.equal(fs.readFileSync(path.join(chosen, 'main.py'), 'utf8'), pythonContent);
  assert.equal(JSON.parse(fs.readFileSync(path.join(chosen, 'python-receipt.json'), 'utf8')).token, token);
  await capture('python-editor-and-terminal');
  record('Run file saves the real dirty Python buffer first; Python runs in a Chinese, apostrophe and ampersand path, produces receipt and exit 0 beside chat', { sessionId: python.sessionId, exitCode: python.exitCode, cwd: python.cwd });
  await choose('node'); await openFile('main.js'); await run();
  const node = await finish('node-file'); assert.ok(node.output.includes('NODE_IDE_OK ' + token));
  assert.equal(JSON.parse(fs.readFileSync(path.join(chosen, 'node-receipt.json'), 'utf8')).token, token);
  record('Node.js file executes in actual Node with real output and disk receipt', { exitCode: node.exitCode, cwd: node.cwd });
  await openFile('fail.js'); await run(); const fail = await finish('node-exit-seven', 7);
  assert.ok(fail.output.includes('EXPECTED_FAILURE_7')); await capture('failed-task-exit-code');
  record('Nonzero program exit is shown as failed with exit 7 even though its terminal shell stays alive');
  await openFile('main.js'); await run('project'); const projectTask = await finish('npm-project-run'); assert.ok(projectTask.output.includes('NODE_IDE_OK ' + token));
  record('Run project executes the actual package.json start script without waiting for an HTTP port');
  await openFile('build.cjs');
  const editedBuild = fs.readFileSync(path.join(chosen, 'build.cjs'), 'utf8') + "console.log('OTHER_DIRTY_TAB_SAVED');\n";
  await evaluate(`monaco.editor.getModels().find(model=>model.uri.path.endsWith('/build.cjs')).setValue(${JSON.stringify(editedBuild)});true`);
  await openFile('main.js');
  assert.ok((await snapshot()).files.find(file => file.path === 'build.cjs').dirty);
  await run('build'); const build = await finish('npm-build'); assert.ok(build.output.includes('NODE_BUILD_OK'));
  assert.ok(build.output.includes('OTHER_DIRTY_TAB_SAVED'));
  assert.equal(fs.readFileSync(path.join(chosen, 'build.cjs'), 'utf8'), editedBuild);
  assert.equal(JSON.parse(fs.readFileSync(path.join(chosen, 'build-receipt.json'), 'utf8')).token, token);
  await run('test'); const tests = await finish('npm-test'); assert.ok(tests.output.includes('NODE_TEST_OK'));
  record('Build saves another dirty tab in this project before running the actual npm script; build and test return exit 0 with disk receipt');
  await choose('dotnet'); await openFile('Program.cs'); await run('build'); const dotnetBuild = await finish('dotnet-build', 0, 60000);
  assert.ok(fs.existsSync(path.join(chosen, 'bin/Debug/net8.0/ConsoleFixture.dll'))); await capture('csharp-build-output');
  await run('project'); const dotnetRun = await finish('dotnet-project-run', 0, 60000); assert.ok(dotnetRun.output.includes('DOTNET_IDE_OK ' + token));
  assert.equal(JSON.parse(fs.readFileSync(path.join(chosen, 'dotnet-receipt.json'), 'utf8')).token, token);
  record('A C#/.NET project builds a real DLL and runs with an independent disk receipt', { buildExit: dotnetBuild.exitCode, runExit: dotnetRun.exitCode });
  await choose('python'); await openFile('slow.py'); await run();
  await wait(async () => (await taskState())?.output.includes('SLOW_TASK_STARTED'), 'long task actual output');
  const slowPID = Number((await taskState()).output.match(/SLOW_TASK_STARTED PID=(\d+)/)[1]);
  await click('#ideTaskStop'); const stopped = await wait(async () => { const task = await taskState(); return task?.status === 'stopped' ? task : false; }, 'stop own task');
  assert.equal(stopped.sessionRunning, false);
  await wait(() => { try { process.kill(slowPID, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, 'actual Python child process exits');
  record('Stop terminates the dedicated long-running Python process and reports stopped, preserving editor and chat', { stoppedPID: slowPID });
  await openFile('main.py');
  await evaluate("monaco.editor.getModels().find(model=>model.uri.path.endsWith('/main.py')).setValue('# unsaved conflict buffer\\n');true");
  const external = '# disk changed independently\n'; fs.writeFileSync(path.join(chosen, 'main.py'), external);
  await wait(async () => (await snapshot()).files.find(file => file.path === 'main.py').conflict, 'actual external conflict');
  await click('#ideRunFile');
  await wait(async () => !!(await snapshot()).error, 'run rejected after save conflict');
  assert.equal((await taskState()).sessionId, stopped.sessionId, 'no replacement task created');
  assert.equal(fs.readFileSync(path.join(chosen, 'main.py'), 'utf8'), external);
  assert.equal(await evaluate("!!document.querySelector('dialog.iexa-app-dialog[open]')"), false);
  record('Run refuses to execute after a real disk/save conflict, retaining both the user buffer and external disk content', { message: (await snapshot()).error });
  await click('#ideReloadDisk');
  await wait(() => evaluate("!!document.querySelector('dialog.iexa-app-dialog[open]')"), 'discard conflicting buffer confirmation');
  await click('dialog.iexa-app-dialog .btn-primary');
  await wait(async () => !(await snapshot()).files.find(file => file.path === 'main.py').dirty, 'reload disk after explicit confirmation');
  await openFile('unsupported.xyz'); await click('#ideRunFile');
  await wait(async () => !!(await snapshot()).error, 'unsupported extension explanation');
  assert.equal(await evaluate("!!document.querySelector('dialog.iexa-app-dialog[open]')"), false);
  record('An unconfigured file type shows a specific setup message instead of a fake successful task', { message: (await snapshot()).error });
  assert.deepEqual(report.diagnostics, []); report.status = 'passed';
}).catch(async error => {
  report.status = 'failed'; report.error = error.stack || String(error); console.error(report.error); process.exitCode = 1;
  try { report.snapshot = await snapshot(); report.task = await taskState(); await capture('failure'); } catch {}
}).finally(async () => {
  save(); await host?.shutdown(); if (win && !win.isDestroyed()) win.destroy(); await host?.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  console.log('CODE_TASK_RESULT ' + JSON.stringify({ status: report.status, checks: report.checks.length, output })); app.exit(process.exitCode || 0);
});
