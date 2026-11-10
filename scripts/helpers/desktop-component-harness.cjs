'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { createSupervisor, processTable } = require('./acceptance-supervisor.cjs');
const { descendants } = require('./owned-processes.cjs');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(fn, label, timeout = 15000) {
  let last; const end = Date.now() + timeout;
  do { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await pause(80); } while (Date.now() < end);
  throw Error(label + (last ? ': ' + last.message : ''));
}
async function port() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map(), events = [], exceptions = []; let seq = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (!m.id) { if (m.method === 'Runtime.exceptionThrown') exceptions.push(m); if (events.length < 1000) events.push(m); return; } const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); });
  return { events, exceptions, close: () => socket.close(), send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); } };
}
async function evaluate(connection, expression) { const r = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }

async function createHarness(options = {}) {
  const runId = randomUUID(), out = path.resolve(options.output), fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-components-'))), workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true }); fs.mkdirSync(path.join(fixture, 'temp'), { recursive: true });
  const report = { runId, startedAt: new Date().toISOString(), scope: 'Actual IEXA window controlled through production DesktopAgent; read-only CDP oracle; isolated fixture provider; no autonomous online model claim', checks: [], actions: [], providerRequests: [], coverage: {}, fixture: { root: fixture, workspace } };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const supervisor = createSupervisor({ output: out, maximumDurationMs: options.timeout || 600000, onStop: reason => { report.resourceStopReason = reason; save(); } });
  let child, main, page, agent, provider, target, endpoint, lockFd, nativeChild, nativeAgent, nativeEndpoint, appIdentity;
  const lock = path.join(root, '.iexa-artifacts', 'desktop-components.lock');
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|APPDATA|LOCALAPPDATA|USERPROFILE|USERNAME|HOMEDRIVE|HOMEPATH|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS)$/i.test(key)));
  const source = options.source === true, packageRoot = options.packageRoot ? path.resolve(options.packageRoot) : path.join(root, 'release/IEXA'), appRoot = source ? root : path.join(packageRoot, 'resources/app');
  async function start() {
    lockFd = fs.openSync(lock, 'wx'); fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, runId, startedAt: report.startedAt }));
    if (!source) report.packageManifestSha256 = sha(fs.readFileSync(path.join(packageRoot, 'build-manifest.json')));
    await supervisor.begin();
    const project = path.join(fixture, 'project'); fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><title>IEXA component project</title><h1>COMPONENT_PREVIEW_RECEIPT</h1><input aria-label="Preview input"><button>Preview submit</button>');
    fs.writeFileSync(path.join(project, 'example.js'), "console.log('COMPONENT_NODE_RUN');\n");
    fs.writeFileSync(path.join(project, 'note.txt'), 'COMPONENT_FILE_ORIGINAL\n');
    options.prepareProject?.(project);
    execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true, timeout: 10000 });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: project, windowsHide: true, timeout: 10000 });
    execFileSync('git', ['add', '.'], { cwd: project, windowsHide: true, timeout: 10000 });
    execFileSync('git', ['-c', 'user.name=IEXA Component Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Component fixture baseline'], { cwd: project, windowsHide: true, timeout: 10000 });
    fs.appendFileSync(path.join(project, 'note.txt'), 'COMPONENT_GIT_WORKTREE_CHANGE\n');
    const sid = 'component-' + runId, now = Date.now();
    fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.iexa-sessions', sid + '.json'), JSON.stringify([{ role: 'user', content: '桌面组件验收历史', timestamp: now - 2 }, { role: 'assistant', content: 'COMPONENT_HISTORY_READY\n\n```js\nconst component = true;\n```', timestamp: now - 1 }]));
    fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({ activeSessionId: sid, sessions: [{ id: sid, title: '桌面组件验收', projectRoot: project, projectName: 'component-project', created: now, updated: now, messageCount: 2 }] }));
    provider = http.createServer(async (req, res) => {
      if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'component-model', object: 'model' }] })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); const last = [...(body.messages || [])].reverse().find(x => x.role === 'user'); const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content || '');
      report.providerRequests.push({ path: req.url, stream: !!body.stream, prompt: prompt.slice(-1000), userTexts: typeof last?.content === 'string' ? [last.content] : (last?.content || []).filter(part => part.type === 'text').map(part => part.text), model: body.model }); save();
      let content = body.stream ? 'COMPONENT_REPLY_OK' : '{"title":"桌面组件验收","category":"code"}';
      if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] })); return; }
      res.setHeader('content-type', 'text/event-stream');
      const featureReply = require('../fixtures/iexa-component-bots.cjs').providerReply(body) || require('../fixtures/iexa-component-agent-features.cjs').providerReply(body);
      if (featureReply) {
        const delta = { ...(featureReply.content ? { content: featureReply.content } : {}), ...(featureReply.toolCalls ? { tool_calls: featureReply.toolCalls.map((call, index) => ({ index, ...call })) } : {}) };
        res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: featureReply.finishReason || 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      const lastUserIndex = body.messages.map(x => x.role).lastIndexOf('user');
      if (prompt.includes('COMPONENT_TOOL_READ') || prompt.includes('COMPONENT_DESKTOP_SELF')) {
        const tool = body.messages.slice(lastUserIndex + 1).find(x => x.role === 'tool');
        if (tool) content = (prompt.includes('COMPONENT_DESKTOP_SELF') ? 'COMPONENT_DESKTOP_SELF_OK ' : 'COMPONENT_TOOL_READ_OK ') + String(tool.content).slice(-300);
        else {
          const self = prompt.includes('COMPONENT_DESKTOP_SELF'), name = self ? 'desktop_control' : 'file_read';
          const args = self ? { action: 'observe', backend: 'chromium-cdp', cdpEndpoint: endpoint, cdpTargetId: target.id, controlMode: 'background', tool_title: '观察真实IEXA自身窗口' } : { path: 'note.txt', tool_title: '组件读取文件' };
          res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'component-' + randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n'); return;
        }
      }
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(workspace, '.iexa-settings.json'), JSON.stringify({ profiles: [{ id: 'component-local', name: 'Component Local Fixture', provider: 'openai', model: 'component-model', apiKey: 'LOCAL_FIXTURE_ONLY', baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiMode: 'chat_completions', maxOutputTokens: 1000 }], activeProfileId: 'component-local', thinkingLevel: 'off', permissionMode: 'full' }));
    Object.assign(report.fixture, { project, sid });
    const apiPort = await port(), cdpPort = await port(), inspectPort = await port(); endpoint = `http://127.0.0.1:${cdpPort}`;
    report.cdpEndpoint = endpoint;
    if (options.denyMicrophone) {
      const profile = path.join(workspace, '.iexa-electron-profile', 'Default'); fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({ profile: { default_content_setting_values: { media_stream_mic: 2 } } }));
      report.microphoneFixture = 'Actual isolated Chromium profile microphone setting denied; no recorded audio fixture';
    }
    const exe = source ? path.join(root, 'node_modules/electron/dist/electron.exe') : path.join(packageRoot, 'IEXA.exe');
    const env = { ...localEnv, IEXA_WORKSPACE: workspace, IEXA_HEADLESS: '1', IEXA_PORT: String(apiPort), TEMP: path.join(fixture, 'temp'), TMP: path.join(fixture, 'temp') };
    const args = [...(source ? [root] : []), `--user-data-dir=${path.join(workspace, '.iexa-electron-profile')}`, `--remote-debugging-port=${cdpPort}`, `--inspect=127.0.0.1:${inspectPort}`, '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
    const started = Date.now(), fd = fs.openSync(path.join(out, 'application.log'), 'w'); child = spawn(exe, args, { cwd: path.dirname(exe), env, windowsHide: true, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
    const identity = await supervisor.claimSpawn(child, `--remote-debugging-port=${cdpPort}`, started); appIdentity = identity; report.application = { exe, appRoot, pid: identity.ProcessId, created: identity.CreationDate };
    const mainTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0], 'IEXA main inspector'); main = await connect(mainTarget.webSocketDebuggerUrl);
    await evaluate(main, "globalThis.__componentElectron=(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))('electron');true");
    target = await until(async () => (await (await fetch(endpoint + '/json/list')).json()).find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${apiPort}`)), 'Actual IEXA page'); page = await connect(target.webSocketDebuggerUrl);
    await page.send('Runtime.enable'); await page.send('Log.enable');
    report.fixture.downloads = path.join(fixture, 'downloads'); fs.mkdirSync(report.fixture.downloads);
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: report.fixture.downloads });
    if (options.denyMicrophone) {
      await page.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: new URL(target.url).origin });
      report.microphonePermission = await read("navigator.permissions.query({name:'microphone'}).then(r=>r.state)");
    }
    await until(() => read("typeof currentSessionId==='string'&&!!currentSessionId&&!!document.querySelector('#chatInput')"), 'IEXA ready');
    report.window = await evaluate(main, "(()=>{const e=globalThis.__componentElectron,w=e.BrowserWindow.getAllWindows()[0];w.setContentSize(1384,860);" + (options.hidden ? '' : 'w.showInactive();') + "return {visible:w.isVisible(),focused:w.isFocused(),handle:Number(w.getNativeWindowHandle().readBigUInt64LE()),userData:e.app.getPath('userData'),crashDumps:e.app.getPath('crashDumps')}})()");
    const controllerRoot = options.controllerRoot || appRoot;
    const { DesktopAgent } = require(path.join(controllerRoot, 'dist/main/tools/DesktopAgent.js'));
    agent = new DesktopAgent(controllerRoot, false, path.join(out, 'journal'));
    report.controller = { appRoot: controllerRoot, sha256: Object.fromEntries(['DesktopAgent.js', 'desktop/DesktopControlSession.js', 'desktop/ChromiumCdpAdapter.js', 'desktop/CdpPageSnapshot.js'].map(rel => [rel, sha(fs.readFileSync(path.join(controllerRoot, 'dist/main/tools', rel)))])) };
    save(); return api;
  }
  const read = expression => evaluate(page, expression);
  async function raw(args) {
    if (report.resourceStopReason) throw Error(report.resourceStopReason);
    const r = await agent.execute({ ...args, detail: 'raw' }, undefined, { owner: runId, operationId: randomUUID() });
    report.actions.push({ action: args.action, target: args.target, success: r.success, output: r.output, desktop: r.metadata?.desktop }); save(); return r;
  }
  async function observe() {
    return until(async () => { const r = await raw({ action: 'observe', backend: 'chromium-cdp', cdpEndpoint: endpoint, cdpTargetId: target.id, controlMode: 'background' }); if (r.success) return JSON.parse(r.output).data; if (!/changed during capture/.test(r.output)) throw Error(r.output); }, 'Desktop observation', 8000);
  }
  async function act(action, targetSelector, values = {}) {
    let last;
    for (let i = 0; i < 3; i++) {
      if (!targetSelector?.elementId) await observe(); const r = await raw({ action, target: typeof targetSelector === 'string' ? { automationId: targetSelector } : targetSelector, ...values });
      if (r.success) return JSON.parse(r.output).data;
      last = r; if (r.metadata?.desktop?.dispatchedActions || !/stale|changed during capture/.test(r.output)) break;
      await pause(100);
    }
    const error = Error(last.output); error.desktopResult = last; throw error;
  }
  async function bySelector(selector, hovered = false, stableAttempt = 0) {
    const snapshot = await observe();
    const info = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {id:e.id,tag:e.tagName,role:e.getAttribute('role'),name:e.getAttribute('aria-label')||e.title||e.textContent?.trim(),bounds:{left:r.left,top:r.top,width:r.width,height:r.height}}})()`);
    assert.ok(info?.bounds.width > 1 && info?.bounds.height > 1, 'Visible actual IEXA selector ' + selector);
    let matches = snapshot.elements.filter(e => e.selector && (!info.id || e.selector.automationId === info.id) && e.bounds && ['left','top','width','height'].every(key => Math.abs(e.bounds[key] - info.bounds[key]) < 2));
    if (matches.length > 1) {
      const role = info.role || (info.tag === 'INPUT' ? await read(`document.querySelector(${JSON.stringify(selector)}).type`) : ({ BUTTON:'button', A:'link', TEXTAREA:'edit', SELECT:'combobox', SUMMARY:'button' })[info.tag]);
      const semantic = matches.filter(e => e.role === role); if (semantic.length) matches = semantic;
      const named = matches.filter(e => e.selector.name === info.name); if (named.length) matches = named;
      if (['BUTTON','INPUT','TEXTAREA','SELECT','SUMMARY','A'].includes(info.tag)) { const nativeControls = matches.filter(e => e.capabilities?.includes('keyInput')); if (nativeControls.length) matches = nativeControls; }
    }
    if (!matches.length && !hovered) {
      const x=info.bounds.left+info.bounds.width/2,y=info.bounds.top+info.bounds.height/2;
      const regions=snapshot.elements.filter(e=>e.selector&&e.capabilities?.includes('rendererPointer')&&e.bounds&&e.bounds.left<=x&&e.bounds.top<=y&&e.bounds.left+e.bounds.width>x&&e.bounds.top+e.bounds.height>y).sort((a,b)=>a.bounds.width*a.bounds.height-b.bounds.width*b.bounds.height);
      if (regions.length) { const moved=await raw({action:'move',target:{elementId:regions[0].id},relativeX:x,relativeY:y}); if(moved.success){await pause(100);return bySelector(selector,true);} }
    }
    if (!matches.length && stableAttempt < 3) { await pause(150); return bySelector(selector, hovered, stableAttempt + 1); }
    assert.equal(matches.length, 1, 'One observed desktop node for ' + selector + '; target=' + JSON.stringify(info) + '; near=' + JSON.stringify(snapshot.elements.filter(e=>e.selector&&e.bounds&&Math.abs(e.bounds.top-info.bounds.top)<25).map(e=>({id:e.id,selector:e.selector,role:e.role,bounds:e.bounds}))));
    return { elementId: matches[0].id };
  }
  async function ensureVisible(selector) {
    for (let i = 0; i < 8; i++) {
      const scroll = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();if(!r.width||!r.height)return null;let p=e.parentElement;while(p){const b=p.getBoundingClientRect(),s=getComputedStyle(p);if(/auto|scroll/.test(s.overflowY)&&p.scrollHeight>p.clientHeight+2&&(r.top<b.top-1||r.bottom>b.bottom+1)){const css=n=>n.id?'#'+CSS.escape(n.id):n===document.body?'body':css(n.parentElement)+' > '+n.tagName.toLowerCase()+':nth-child('+(Array.from(n.parentElement.children).indexOf(n)+1)+')';return {selector:css(p),delta:r.top<b.top-1?r.top-b.top-24:r.bottom-b.bottom+24};}p=p.parentElement;}return null})()`);
      if (!scroll) return;
      await ensureVisible(scroll.selector);
      const target = await bySelector(scroll.selector); await act('scroll', target, { deltaY: scroll.delta }); await pause(80);
    }
    throw Error('Control remains clipped after bounded component scrolling: ' + selector);
  }
  async function selectorAction(action, selector, values = {}) {
    await ensureVisible(selector);
    let last;
    for (let i = 0; i < 3; i++) {
      const target = await bySelector(selector), r = await raw({ action, target, ...values });
      if (r.success) return JSON.parse(r.output).data;
      last = r; if (r.metadata?.desktop?.acknowledgedActions || !/stale|changed during capture|Fresh observe is required/.test(r.output)) break;
      await pause(120);
    }
    const error = Error(last.output); error.desktopResult = last; throw error;
  }
  async function startNative() {
    if (report.resourceStopReason) throw Error(report.resourceStopReason);
    if (nativeAgent) return;
    nativeEndpoint = 'http://127.0.0.1:' + await port();
    const controllerRoot = options.controllerRoot || appRoot, exe = path.join(controllerRoot, 'desktop-agent/publish/Iexa.DesktopAgent.exe');
    const fd = fs.openSync(path.join(out, 'native.log'), 'w'), began = Date.now();
    nativeChild = spawn(exe, [], { cwd: path.dirname(exe), env: { ...localEnv, IEXA_DESKTOP_PORT: new URL(nativeEndpoint).port }, windowsHide: true, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
    await supervisor.claimSpawn(nativeChild, 'Iexa.DesktopAgent.exe', began);
    await until(async () => { try { const r = await fetch(nativeEndpoint + '/health', { signal: AbortSignal.timeout(500) }); const health = await r.json(); if (health.pid === nativeChild.pid) { report.nativeHelper = health; return true; } } catch {} }, 'Owned shipped native helper');
    const { DesktopAgent } = require(path.join(controllerRoot, 'dist/main/tools/DesktopAgent.js')); nativeAgent = new DesktopAgent(controllerRoot, false, path.join(out, 'native-journal'), nativeEndpoint);
  }
  async function nativeRaw(args) {
    await startNative(); const r = await nativeAgent.execute({ ...args, detail: 'raw' }, undefined, { owner: runId + '-native', operationId: randomUUID() });
    if (r.success && ['list_windows','observe'].includes(args.action)) { const body = JSON.parse(r.output); if (Array.isArray(body.data?.windows)) { const ownedPids = new Set(descendants(await processTable(), appIdentity).map(row => row.ProcessId)); body.data.windows = body.data.windows.filter(w => ownedPids.has(w.pid)); body.data.count = body.data.windows.length; r.output = JSON.stringify(body); } }
    report.actions.push({ channel: 'native', action: args.action, target: args.target, success: r.success, output: r.output, desktop: r.metadata?.desktop }); save(); return r;
  }
  async function nativeRun(args) { const r = await nativeRaw(args); if (!r.success) { const error = Error(r.output); error.desktopResult = r; throw error; } return JSON.parse(r.output).data; }
  async function nativeClickSelector(selector) {
    await startNative();
    await nativeRun({ action: 'activate', backend: 'native', controlMode: 'foreground', focusPolicy: 'activate', handle: report.window.handle, pid: child.pid });
    await ensureVisible(selector);
    const info = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r||!r.width||!r.height)throw Error('Native click target absent');const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))throw Error('Native click target covered');return {x,y,width:innerWidth,height:innerHeight}})()`);
    const seen = await nativeRun({ action: 'observe', backend: 'native', controlMode: 'foreground', focusPolicy: 'activate', handle: report.window.handle, pid: child.pid, includeElements: true, limit: 180 });
    assert.equal(seen.session.foreground, true, 'Explicit actual foreground before physical native click');
    return nativeRun({ action: 'click', relativeX: Math.round(info.x * seen.frame.width / info.width), relativeY: Math.round(info.y * seen.frame.height / info.height), durationMs: 80 });
  }
  async function nativeDialog() {
    return until(async () => {
      const data = await nativeRun({ action: 'list_windows' });
      const windows = data.windows.filter(w => w.handle !== report.window.handle);
      if (windows.length === 1) return windows[0]; return false;
    }, 'Actual IEXA native dialog', 12000);
  }
  async function chooseNativePath(trigger, selectedPath, { cancel = false } = {}) {
    await startNative();
    await nativeRun({ action: 'activate', backend: 'native', controlMode: 'foreground', focusPolicy: 'activate', handle: report.window.handle, pid: child.pid });
    try { await trigger(); } catch (error) { if (!error.desktopResult?.metadata?.desktop?.dispatchedActions) throw error; report.knownToolIssues ||= []; report.knownToolIssues.push({ action: 'native-dialog-open', issue: error.message }); }
    const dialog = await nativeDialog();
    const observeDialog = () => nativeRun({ action: 'observe', backend: 'native', controlMode: 'foreground', focusPolicy: 'activate', handle: dialog.handle, pid: dialog.pid, includeElements: true, limit: 180 });
    async function closingAction(args) {
      const r = await nativeRaw({ ...args, expectWindowClosed: true });
      if (!r.success) {
        const windows = (await nativeRun({ action: 'list_windows' })).windows;
        if (windows.some(w => w.handle === dialog.handle) || !r.metadata?.desktop?.dispatchedActions) throw Error(r.output);
        report.knownToolIssues ||= []; report.knownToolIssues.push({ action: args.action, issue: r.output, independentlyVerified: 'Owned modal handle gone after acknowledged action; business result checked by scenario' }); save();
      }
    }
    if (cancel) { await observeDialog(); await closingAction({ action: 'key', key: 'ESC' }); return { cancelled: true, dialog }; }
    if (fs.existsSync(selectedPath) && fs.statSync(selectedPath).isFile()) {
      await observeDialog(); await nativeRun({ action: 'hotkey', keys: ['ALT', 'N'] });
      await nativeRun({ action: 'hotkey', keys: ['CTRL', 'A'] });
      await nativeRun({ action: 'type', text: selectedPath }); await closingAction({ action: 'key', key: 'ENTER' });
      await until(async () => !(await nativeRun({ action: 'list_windows' })).windows.some(w => w.handle === dialog.handle), 'Selected file dialog closed', 8000);
      return { selectedPath, dialog };
    }
    await observeDialog(); await nativeRun({ action: 'hotkey', keys: ['CTRL', 'L'] });
    await nativeRun({ action: 'type', text: selectedPath }); await nativeRun({ action: 'key', key: 'ENTER' }); await pause(350);
    let snapshot = await observeDialog();
    const pick = snapshot.elements.filter(e => e.role === 'button' && e.selector?.automationId === '1' && e.enabled !== false);
    if (pick.length === 1) await closingAction({ action: 'click', target: { elementId: pick[0].id } });
    else { throw Error('Native dialog has no unique observed enabled default action button'); }
    await until(async () => { const d = await nativeRun({ action: 'list_windows' }); return !d.windows.some(w => w.handle === dialog.handle); }, 'IEXA dialog closed', 8000);
    return { selectedPath, dialog };
  }
  async function screenshot(name) {
    if (options.hidden) {
      const url = await read('location.href');
      const data = await evaluate(main, `(async()=>{const w=globalThis.__componentElectron.webContents.getAllWebContents().find(w=>w.getURL()===${JSON.stringify(url)});if(!w)throw Error('Screenshot target absent');return (await w.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64')})()`);
      fs.writeFileSync(path.join(out, 'screenshots', name + '.png'), Buffer.from(data, 'base64')); return;
    }
    const r = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'screenshots', name + '.png'), Buffer.from(r.data, 'base64'));
  }
  async function check(name, fn, options = {}) {
    if (api.onlyChecks && !api.onlyChecks.some(pattern => name.includes(pattern))) return;
    const began = Date.now();
    try { const evidence = await fn(); report.checks.push({ name, passed: true, durationMs: Date.now() - began, evidence }); console.log('PASS ' + name); }
    catch (error) { report.checks.push({ name, passed: false, durationMs: Date.now() - began, error: error.stack }); console.log('FAIL ' + name + ': ' + error.message); await screenshot('failure-' + report.checks.length).catch(() => {}); if (options.fatal || report.resourceStopReason) throw error; }
    save();
  }
  async function inventory(name) {
    const elements = await read("Array.from(document.querySelectorAll('button,input,textarea,select,a,summary,[role],[tabindex],[onclick],[contenteditable=true]')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'}).map(e=>({tag:e.tagName,id:e.id,role:e.getAttribute('role'),type:e.type,name:e.getAttribute('aria-label')||e.title||e.textContent?.trim().slice(0,140)||e.placeholder,value:e.type==='password'?'[redacted]':('value'in e?e.value:undefined),disabled:!!e.disabled,bounds:e.getBoundingClientRect().toJSON()}))");
    report.coverage[name] = elements; fs.writeFileSync(path.join(out, 'inventory-' + name + '.json'), JSON.stringify(elements, null, 2)); save(); return elements;
  }
  async function nav(view) {
    const nested = !['chat','bots','skills','scheduled'].includes(view);
    if (nested && !await read("document.querySelector('#sidebarMore').open")) await selectorAction('click', '#sidebarMore > summary');
    await selectorAction('click', `.nav-btn[data-view="${view}"]`);
    await until(() => read(`document.querySelector('#view-${view}')?.classList.contains('active') || (document.querySelector('.nav-btn.active')?.dataset.view===${JSON.stringify(view)} && document.querySelector('#view-${view}')?.getBoundingClientRect().height>0)`), 'Actual IEXA navigation ' + view);
    await pause(120);
  }
  async function withTarget(urlPart, fn) {
    const next = await until(async () => (await (await fetch(endpoint + '/json/list')).json()).find(t => t.type === 'page' && t.url.includes(urlPart)), 'Actual IEXA secondary page ' + urlPart);
    const previous = { page, target }; target = next; page = await connect(next.webSocketDebuggerUrl); await page.send('Runtime.enable');
    try { return await fn(); } finally { (report.secondaryRuntimeErrors ||= []).push(...page.exceptions.map(error => ({ ...error, targetUrl: next.url }))); page.close(); page = previous.page; target = previous.target; await observe(); }
  }
  async function finish() {
    agent?.close(); nativeAgent?.close();
    if (page) {
      report.runtimeErrors = [...page.exceptions, ...(report.secondaryRuntimeErrors || [])];
      try { await evaluate(main, 'globalThis.__componentElectron.app.quit();true'); } catch {}
    }
    main?.close(); page?.close();
    if (child) { try { await until(() => child.exitCode !== null || child.signalCode !== null, 'IEXA normal exit', 12000); } catch (e) { report.exitError = e.message; } report.applicationExitCode = child.exitCode; }
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    if (nativeChild?.exitCode === null) { try { await fetch(nativeEndpoint + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(1500) }); await until(() => nativeChild.exitCode !== null, 'Native helper normal exit', 5000); } catch (e) { report.nativeExitError = e.message; } }
    try { report.resources = await supervisor.finish(); } catch (e) { report.resourceError = e.message; }
    report.completedAt = new Date().toISOString(); report.status = report.checks.some(c => !c.passed) || report.runtimeErrors?.length || report.knownToolIssues?.length || report.error || report.resourceError || report.exitError || report.nativeExitError ? 'failed' : 'passed'; save();
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
    return report;
  }
  const api = { root, out, fixture, workspace, report, start, finish, read, raw, observe, act, nav, withTarget, bySelector, selectorAction, ensureVisible, click: target => act('click', target), type: (target, text) => act('type', target, { text, replace: true }), clickSelector: selector => selectorAction('click', selector), typeSelector: (selector, text) => selectorAction('type', selector, { text, replace: true }), selectSelector: (selector, value) => selectorAction('select_option', selector, { value }), scrollSelector: (selector, deltaY) => selectorAction('scroll', selector, { deltaY }), keySelector: (selector, keys) => selectorAction(Array.isArray(keys) ? 'hotkey' : 'key', selector, Array.isArray(keys) ? { keys } : { key: keys }), chooseNativePath, nativeClickSelector, nativeRun, check, screenshot, inventory, until, pause, failure: supervisor.failure, save };
  return api;
}
module.exports = { createHarness };
