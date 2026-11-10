/* Actual Electron + production HTTP/auth + DesktopAgent CDP + desktop-live page.
 * No model call, native helper, global hook, physical input or window activation.
 * Run with node scripts/check-desktop-live.cjs after npm run build. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), http = require('node:http'), net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

if (!process.versions.electron) {
  (async () => {
    const out = process.env.IEXA_DESKTOP_LIVE_TEST_OUT || path.join(root, '.iexa-artifacts', 'desktop-live', `${Date.now()}-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(out, { recursive: true });
    const cdpPort = await freePort(), env = { ...process.env, IEXA_DESKTOP_LIVE_TEST_OUT: out, IEXA_DESKTOP_LIVE_TEST_PORT: String(cdpPort) };
    delete env.ELECTRON_RUN_AS_NODE;
    const log = fs.openSync(path.join(out, 'electron.log'), 'a');
    const child = require('node:child_process').spawn(require('electron'), [`--remote-debugging-port=${cdpPort}`, __filename], { cwd: root, windowsHide: true, env, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
    child.once('error', error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
    child.once('exit', (code, signal) => {
      clearTimeout(watchdog);
      const report = path.join(out, 'report.json');
      const evidence = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
      if (evidence?.temporaryWorkspace && !evidence.temporaryWorkspaceRemoved) {
        assert.equal(path.dirname(evidence.temporaryWorkspace), fs.realpathSync.native(os.tmpdir()));
        assert.match(path.basename(evidence.temporaryWorkspace), /^iexa-desktop-live-/);
        fs.rmSync(evidence.temporaryWorkspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        evidence.temporaryWorkspaceRemoved = true; delete evidence.cleanupError;
        fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
      }
      process.exitCode = code === 0 && evidence?.passed === true && evidence?.temporaryWorkspaceRemoved === true ? 0 : 1;
      console.log(JSON.stringify({ out, exitCode: code, signal, passed: evidence?.passed, cases: evidence?.cases, error: evidence?.error, commandCounts: evidence?.commandCounts, temporaryWorkspaceRemoved: evidence?.temporaryWorkspaceRemoved }, null, 2));
    });
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const out = process.env.IEXA_DESKTOP_LIVE_TEST_OUT;
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-desktop-live-')));
  process.env.IEXA_WORKSPACE = path.join(scratch, 'workspace');
  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
  app.setPath('userData', path.join(scratch, 'profile'));
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.on('window-all-closed', () => {});
  const report = { scope: 'production DesktopAgent, HTTP login, cached desktop-live APIs and actual Electron page; no autonomous model or native input claims', temporaryWorkspace: scratch, cases: [], actions: [], diagnostics: [], commandCounts: {} };
  let production, fixtureServer, agent, taskWindow, liveWindow, secondWindow;
  let origin, endpoint, actualTarget, latestResult, originalCommand, ChromiumCdpAdapter, failureExitCode = 0;
  const commands = [], receipts = [];
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const evalLive = expression => liveWindow.webContents.executeJavaScript(expression, false);
  async function until(fn, label, timeout = 20000) {
    const deadline = Date.now() + timeout; let error;
    do { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await pause(70); } while (Date.now() < deadline);
    throw Error(`Timeout: ${label}${error ? ': ' + error.message : ''}`);
  }
  async function check(name, fn) {
    const started = Date.now(); const evidence = await fn();
    report.cases.push({ name, passed: true, durationMs: Date.now() - started, evidence }); save(); console.log('PASS ' + name);
  }
  const counts = () => ({ total: commands.length, screenshots: commands.filter(c => c.method === 'Page.captureScreenshot').length, semanticInputs: commands.filter(c => c.input).length, forbidden: commands.filter(c => /^(Input\.|Page.bringToFront|Target.activateTarget)/.test(c.method)).length });
  async function execute(args) {
    const result = await agent.execute({ ...args, detail: 'raw' }, undefined, { owner: 'desktop-live-real', operationId: randomUUID() });
    report.actions.push({ action: args.action, success: result.success, output: result.output, desktop: result.metadata?.desktop }); save(); latestResult = result; return result;
  }
  async function run(args) { const result = await execute(args); assert.equal(result.success, true, result.output); return result; }
  async function api(suffix) {
    return evalLive(`fetch('/api/desktop-live/${suffix}',{cache:'no-store'}).then(async r=>({status:r.status,headers:Object.fromEntries(r.headers),${suffix === 'frame' ? "bytes:Array.from(new Uint8Array(await r.arrayBuffer()))" : 'data:await r.json()'}}))`);
  }
  async function screenshot(name) {
    fs.writeFileSync(path.join(out, name + '.png'), (await liveWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  }
  const windows = () => [taskWindow, liveWindow, secondWindow].filter(window => window && !window.isDestroyed());
  function window(options = {}) {
    const owned = new BrowserWindow({ show: false, skipTaskbar: true, width: 900, height: 650, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }, ...options });
    owned.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    owned.webContents.on('console-message', event => { if (event?.level === 'error') { report.diagnostics.push({ level: event.level, message: event.message }); save(); } });
    owned.on('focus', () => { report.unexpectedWindowFocus = true; save(); }); return owned;
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(out, { recursive: true }); save();
    ({ ChromiumCdpAdapter } = require('../dist/main/tools/desktop/ChromiumCdpAdapter'));
    originalCommand = ChromiumCdpAdapter.prototype.command;
    ChromiumCdpAdapter.prototype.command = async function(method, params, signal) {
      commands.push({ method, input: method === 'Runtime.callFunctionOn' && String(params?.functionDeclaration).includes('this.apply(') });
      return originalCommand.call(this, method, params, signal);
    };
    fixtureServer = http.createServer(async (req, res) => {
      if (req.url === '/receipt' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk; const receipt = JSON.parse(body); receipts.push(receipt);
        fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipts, null, 2)); res.end('ok'); return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="en"><title>IEXA Desktop Live Real Task</title><style>body{background:#171728;color:#eceaf5;font:20px system-ui;padding:50px}input,button{font:inherit;padding:10px;margin:12px}h1{color:#bba1f4}</style><h1>Desktop live acceptance</h1><label>Reference<input id="reference" aria-label="Reference"></label><button id="send" aria-label="Send">Send</button><p role="status" id="result">Ready</p><script>document.querySelector("#send").onclick=async()=>{const reference=document.querySelector("#reference").value;await fetch("/receipt",{method:"POST",body:JSON.stringify({reference})});document.querySelector("#result").textContent="Submitted "+reference}</script></html>');
    });
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
    const taskUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;
    endpoint = `http://127.0.0.1:${process.env.IEXA_DESKTOP_LIVE_TEST_PORT}`;
    const backend = require('../dist/main/server'); production = await backend.startServer(0, false);
    origin = `http://127.0.0.1:${production.address().port}`;
    taskWindow = window(); await taskWindow.loadURL(taskUrl); taskWindow.showInactive();
    actualTarget = await until(async () => { const rows = await (await fetch(endpoint + '/json/list')).json(); return rows.find(row => row.type === 'page' && row.url === taskUrl); }, 'actual task CDP target');
    liveWindow = window({ width: 950, height: 730 });
    await liveWindow.loadURL(origin + '/desktop-live.html');
    const loginCode = backend.getServerCredentials(production).loginCode;
    const bootstrap = await evalLive(`fetch('/api/auth/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(loginCode)}})}).then(r=>r.status)`);
    assert.equal(bootstrap, 200); await liveWindow.loadURL(origin + '/desktop-live.html'); liveWindow.showInactive();
    await until(() => evalLive("!!document.querySelector('[data-live-control-mode]')"), 'production desktop-live page');
    const { DesktopAgent } = require('../dist/main/tools/DesktopAgent'); agent = new DesktopAgent(root, false, path.join(out, 'journal'));
    await check('real loginCode authenticates production live APIs without a helper or model request', async () => {
      const status = await api('status'), frame = await api('frame');
      assert.equal(status.status, 200); assert.equal(status.data.observed, false); assert.equal(frame.status, 404); assert.equal(commands.length, 0);
      assert.ok(windows().every(owned => !owned.isFocused())); return { status: status.data, frameStatus: frame.status, windowsFocused: false };
    });
    await check('DesktopAgent observes, types and submits the real page in persistent background mode', async () => {
      await run({ action: 'observe', backend: 'chromium-cdp', cdpEndpoint: endpoint, cdpTargetId: actualTarget.id });
      const reference = 'LIVE-' + randomUUID();
      await run({ action: 'type', target: { automationId: 'reference' }, text: reference, verifyText: reference });
      await run({ action: 'click', target: { automationId: 'send' }, verifyText: 'Submitted ' + reference });
      assert.deepEqual(receipts, [{ reference }]);
      assert.equal(fs.readFileSync(path.join(out, 'receipt.json'), 'utf8'), JSON.stringify(receipts, null, 2));
      assert.equal(latestResult.metadata.desktop.control.mode, 'background'); assert.equal(latestResult.metadata.desktop.control.backend, 'chromium-cdp');
      assert.equal(counts().semanticInputs, 2); assert.equal(counts().forbidden, 0);
      return { receipt: receipts[0], control: latestResult.metadata.desktop.control, counts: counts() };
    });
    await check('live status/frame use the exact cached observation and never capture or input while polled', async () => {
      const expectedHash = JSON.parse(latestResult.output).data.postObservation.frameHash, first = await api('frame'), status = await api('status');
      const expected = Buffer.from(first.bytes);
      assert.equal(first.status, 200); assert.match(first.headers['content-type'], /image\/png/); assert.equal(first.headers['x-iexa-frame-mode'], 'cached-observation');
      assert.equal(createHash('sha256').update(expected).digest('hex'), expectedHash); assert.equal(status.data.capturedAt, Number(first.headers['x-captured-at']));
      const timestamp = status.data.capturedAt, before = counts();
      for (let i = 0; i < 3; i++) { assert.equal((await api('status')).data.capturedAt, timestamp); assert.deepEqual((await api('frame')).bytes, first.bytes); }
      await until(() => evalLive("document.querySelector('[data-live-frame]').naturalWidth>0&&!document.querySelector('[data-live-frame]').hidden"), 'cached frame rendered');
      await pause(1100); assert.deepEqual(counts(), before);
      fs.writeFileSync(path.join(out, 'cached-task.png'), expected); report.cachedTimestamp = timestamp;
      return { timestamp, mime: first.headers['content-type'], sha256: createHash('sha256').update(expected).digest('hex'), countsBefore: before, countsAfter: counts() };
    });
    await check('explicit cached frame action retains original capture time and real UI shows actual mode', async () => {
      const cachedTime = report.cachedTimestamp; await pause(120); const before = counts();
      await run({ action: 'frame' }); const current = await api('status');
      assert.equal(current.data.capturedAt, cachedTime); assert.equal(counts().screenshots, before.screenshots); assert.equal(counts().semanticInputs, before.semanticInputs);
      await until(() => evalLive("document.querySelector('[data-live-control-mode]').textContent==='后台 · 浏览器'"), 'actual background mode label');
      const rendered = await evalLive("({mode:document.querySelector('[data-live-control-mode]').textContent,route:document.querySelector('[data-live-control-route]').textContent,status:document.querySelector('[data-live-status]').textContent,overflow:document.documentElement.scrollWidth>innerWidth})");
      assert.match(rendered.route, /chromium-cdp/); assert.match(rendered.route, /browser-dom/); assert.match(rendered.status, /最近观察快照/); assert.equal(rendered.overflow, false);
      await screenshot('live-background-browser');
      liveWindow.setSize(430, 680); await pause(250); assert.equal(await evalLive('document.documentElement.scrollWidth>innerWidth'), false); await screenshot('live-background-browser-narrow');
      return rendered;
    });
    await check('real failed retarget clears cached pixels and the rendered page removes the old image', async () => {
      secondWindow = window(); const secondUrl = taskUrl + 'second'; await secondWindow.loadURL(secondUrl);
      const second = await until(async () => (await (await fetch(endpoint + '/json/list')).json()).find(row => row.url === secondUrl), 'second real page target');
      secondWindow.destroy(); secondWindow = undefined;
      await until(async () => !(await (await fetch(endpoint + '/json/list')).json()).some(row => row.id === second.id), 'closed target absent');
      const before = counts(), failed = await execute({ action: 'observe', backend: 'chromium-cdp', cdpEndpoint: endpoint, cdpTargetId: second.id });
      assert.equal(failed.success, false); assert.equal(failed.metadata.desktop.dispatchedActions, 0);
      const frame = await api('frame'), status = await api('status'); assert.equal(frame.status, 404); assert.equal(status.data.hasFrame, false); assert.equal(status.data.success, false);
      await until(() => evalLive("document.querySelector('[data-live-frame]').hidden&&!document.querySelector('[data-live-frame]').hasAttribute('src')&&!document.querySelector('[data-live-placeholder]').hidden"), 'old frame removed after failed retarget');
      const rendered = await evalLive("({mode:document.querySelector('[data-live-control-mode]').textContent,route:document.querySelector('[data-live-control-route]').textContent,placeholder:document.querySelector('[data-live-placeholder]').textContent})");
      assert.match(rendered.route, /最近操作未成功/); assert.match(rendered.placeholder, /暂无可用画面/); assert.deepEqual(counts(), before);
      await screenshot('live-failed-retarget'); return { frameStatus: frame.status, control: status.data.control, rendered };
    });
    report.commandCounts = counts(); report.noPhysicalInputOrActivationCommands = counts().forbidden === 0;
    report.windows = windows().map(owned => ({ visible: owned.isVisible(), focused: owned.isFocused() }));
    assert.ok(report.windows.every(owned => !owned.focused)); assert.equal(report.unexpectedWindowFocus, undefined);
    report.passed = true; save();
  }).catch(async error => {
    report.passed = false; report.error = error.stack; failureExitCode = 1; console.error(error);
    if (liveWindow && !liveWindow.isDestroyed()) try { await screenshot('live-failure'); } catch {}
  }).finally(async () => {
    agent?.close(); if (ChromiumCdpAdapter && originalCommand) ChromiumCdpAdapter.prototype.command = originalCommand;
    for (const owned of windows()) owned.destroy();
    for (const server of [fixtureServer, production]) if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    report.commandCounts = counts(); report.completedAt = new Date().toISOString(); save();
    assert.equal(path.dirname(scratch), fs.realpathSync.native(os.tmpdir())); assert.match(path.basename(scratch), /^iexa-desktop-live-/);
    try { fs.rmSync(scratch, { recursive: true, force: true }); report.temporaryWorkspaceRemoved = true; } catch (error) { report.cleanupError = error.message; }
    save(); app.exit(failureExitCode);
  });
}
