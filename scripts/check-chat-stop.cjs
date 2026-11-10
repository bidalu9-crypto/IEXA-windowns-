/* Real Electron/packaged application, real AgentRuntime, loopback-only LLM fixture.
 * Usage: node check-chat-stop.cjs --baseline | --source | --packaged
 * Runs in a fresh TEMP workspace/profile. No real account or existing workspace is used.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { createSupervisor } = require('./helpers/acceptance-supervisor.cjs');
const mode = process.argv.includes('--baseline') ? 'baseline' : process.argv.includes('--source') ? 'source' : 'packaged';
const scenario = process.argv.includes('--shell-session') ? 'shell_session' : 'shell_execute';
const out = path.resolve(process.env.IEXA_STOP_TEST_OUTPUT || path.join(root, '.iexa-artifacts/chat-stop-20261109', mode + (scenario === 'shell_session' ? '-shell-session' : '')));
fs.mkdirSync(out, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const report = { mode, scenario, startedAt: new Date().toISOString(), scope: 'Actual app entry, actual renderer mouse clicks, actual AgentRuntime + ' + scenario + ', local OpenAI-compatible provider only, thousands of persisted history messages; chat Stop is distinct from IDE Stop', checks: [], providerRequests: [], diagnostics: [], measurements: {} };
let child, main, page, provider, fixture, expectedPids = [], expectedIdentities = [], pageClosed = false;
const supervisor = createSupervisor({ output: out, maximumDurationMs: Number(process.env.IEXA_STOP_ACCEPTANCE_TIMEOUT_MS || 300000), onStop: reason => { report.resourceStopReason = reason; save(); } });
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const record = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); save(); console.log('PASS ' + name); };
async function until(fn, label, timeout = 20000, interval = 45) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await wait(interval); }
  throw Error(label + (last ? ': ' + last.message : ''));
}
async function port() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)); }); }); }
async function connect(url) {
  const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map(), events = [];
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (!message.id) { events.push(message); return; } const p = pending.get(message.id); if (!p) return; clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(Error(message.error.message)) : p.resolve(message.result); });
  return { events, close: () => socket.close(), send: (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 30000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }) };
}
async function evaluate(connection, expression) { const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }
const ui = expression => evaluate(page, expression);
const native = expression => evaluate(main, expression);
async function click(selector) {
  const target = await ui(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,width:r.width,height:r.height,disabled:el.disabled,hit:!!document.elementFromPoint(x,y)?.closest(${JSON.stringify(selector)})}})()`);
  assert.ok(target?.width > 0 && target?.height > 0 && target.hit && !target.disabled, 'Visible reachable enabled control ' + selector + ': ' + JSON.stringify(target));
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: target.x, y: target.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: target.x, y: target.y });
}
async function typeAndSend(text) { await click('#chatInput'); await page.send('Input.insertText', { text }); await click('#sendBtn'); }
async function killExact(identity) { return supervisor.terminate([identity]); }
async function screenshot(name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '-renderer.png'), Buffer.from(shot.data, 'base64'));
  const image = await native("(async()=>{const e=globalThis.__iexaStopElectron,w=e.BrowserWindow.getAllWindows()[0];const s=(await e.desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1384,height:900}})).find(s=>s.id===w.getMediaSourceId());return s&&!s.thumbnail.isEmpty()?s.thumbnail.toPNG().toString('base64'):null})()");
  if (image) fs.writeFileSync(path.join(out, name + '-window.png'), Buffer.from(image, 'base64'));
}
async function createFixture() {
  fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-chat-stop-')));
  const workspace = path.join(fixture, 'workspace'); fs.mkdirSync(workspace);
  const marker = path.join(workspace, 'fixture-pids.json');
  fs.writeFileSync(path.join(workspace, 'long-shell.cjs'), `const fs=require('node:fs'),{spawn}=require('node:child_process');
if(process.argv.includes('--grandchild')){setInterval(()=>process.stdout.write('GRANDCHILD_HEARTBEAT '+Date.now()+'\\n'),125);}
else {const child=spawn(process.execPath,[__filename,'--grandchild'],{stdio:['ignore','inherit','inherit'],windowsHide:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,grandchild:child.pid,createdAt:Date.now()}));
process.stdout.write('FIXTURE_NOISY_SHELL_STARTED\\n');for(let i=0;i<384;i++)process.stdout.write('OUTPUT_'+i+' '+('0123456789abcdef'.repeat(64))+'\\n');setInterval(()=>process.stdout.write('PARENT_HEARTBEAT '+Date.now()+'\\n'),100);}
setTimeout(()=>process.exit(0),120000);
`);
  const sid = 'stop-history-' + crypto.randomUUID(); const total = Number(process.env.IEXA_STOP_HISTORY_COUNT || 2400); const now = Date.now(); const messages = [];
  for (let i = 0; i < total; i++) messages.push(i % 2 === 0
    ? { role: 'user', content: `历史问题 ${i}：保留上下文与文件路径 src/example-${i}.ts，核查工作台布局、工具输出和当前任务。`, timestamp: now - total + i }
    : { role: 'assistant', content: `### 历史回答 ${i}\n\n已经检查本地工作区。这个记录用于实际长会话滚动与停止响应验收。\n\n\`\`\`ts\nexport const item${i} = { value: ${i}, status: 'verified' };\n\`\`\`\n\n工具结果：fixture-${i}.txt，退出码 0。`, timestamp: now - total + i });
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sid + '.json'), JSON.stringify(messages));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({ activeSessionId: sid, sessions: [{ id: sid, title: '2400条历史 · Chat Stop 验收', projectRoot: '', projectName: '无项目', created: now - total, updated: now, messageCount: total }] }));
  provider = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] })); return; }
      let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      const lastUser = [...body.messages].reverse().find(message => message.role === 'user'); const prompt = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
      report.providerRequests.push({ at: Date.now(), path: request.url, stream: !!body.stream, messageCount: body.messages?.length, prompt: prompt.slice(0, 150) }); save();
      if (!body.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '{"title":"Chat Stop 验收","category":"code"}' } }] })); return; }
      response.setHeader('Content-Type', 'text/event-stream');
      const delta = value => response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: null }] }) + '\n\n');
      const done = reason => { response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + '\n\n'); response.end('data: [DONE]\n\n'); };
      if (!body.tools?.length) { delta({ content: prompt.includes('short title') ? '{"title":"Chat Stop 验收","category":"code"}' : 'Local fixture context summary; stop fixture history retained.' }); done('stop'); }
      else if (prompt.includes('STOP_FIXTURE_NEXT')) { delta({ content: 'NEXT_TURN_OK：上一轮已经终止，现在可以正常发送。' }); done('stop'); }
      else if (prompt.includes('STOP_FIXTURE_START')) {
        delta({ content: '开始运行真实长任务，等待点击对话输入框旁的停止按钮。' });
        let args, name;
        if (scenario === 'shell_session') {
          name = 'shell_session';
          const tools = body.messages.filter(message => message.role === 'tool').map(message => { let content = message.content; try { content = JSON.parse(content); } catch {} return typeof content === 'object' ? String(content.output || content.content || '') : String(content); });
          const opened = tools.find(content => content.includes('已打开持久终端。'));
          const sessionId = opened?.match(/\bid:\s*([^\s]+)/)?.[1];
          if (tools.length && !sessionId) { report.fixtureSetupError = tools.slice(-3); save(); delta({ content: 'FIXTURE_SETUP_ERROR: ' + tools.slice(-1)[0] }); done('stop'); return; }
          args = sessionId ? { tool_title: '运行持久终端真实长任务', action: 'send', session_id: sessionId, command: 'node long-shell.cjs', timeout: 900 } : { tool_title: '打开验收持久终端', action: 'open', shell: 'cmd' };
        } else { name = 'shell_execute'; args = { tool_title: '运行真实长任务与父子进程', command: 'node long-shell.cjs', shell: 'cmd', timeout: 900 }; }
        delta({ tool_calls: [{ index: 0, id: 'stop-noisy-shell-' + crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); done('tool_calls');
      } else { delta({ content: 'LOCAL_FIXTURE_RESPONSE' }); done('stop'); }
    } catch (error) { report.providerError = error.stack; save(); response.statusCode = 500; response.end(String(error.stack)); }
  }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(workspace, '.iexa-settings.json'), JSON.stringify({ profiles: [{ id: 'stop-local-fixture', name: 'Local Stop Fixture', provider: 'openai', model: 'gpt-5', apiKey: 'LOCAL_FIXTURE_ONLY', baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiMode: 'chat_completions', maxOutputTokens: 2000 }], activeProfileId: 'stop-local-fixture', thinkingLevel: 'off', permissionMode: 'full' }));
  report.fixture = { root: fixture, workspace, sid, marker, historyCount: total, historyBytes: fs.statSync(path.join(workspace, '.iexa-sessions', sid + '.json')).size, providerOrigin: `http://127.0.0.1:${provider.address().port}`, noisyShellSHA256: hash(fs.readFileSync(path.join(workspace, 'long-shell.cjs'))) }; save();
  return report.fixture;
}
async function run() {
  const f = await createFixture();
  const dist = path.join(root, 'release/IEXA'); const appRoot = mode === 'source' ? root : path.join(dist, 'resources/app'); const exe = mode === 'source' ? path.join(root, 'node_modules/electron/dist/electron.exe') : path.join(dist, 'IEXA.exe');
  assert.ok(fs.existsSync(exe), exe); report.application = { exe, appRoot, rendererSHA256: hash(fs.readFileSync(path.join(appRoot, 'src/renderer/app.js'))), runtimeSHA256: hash(fs.readFileSync(path.join(appRoot, 'dist/main/runtime/AgentRuntime.js'))) };
  const manifest = path.join(dist, 'build-manifest.json'); if (mode !== 'source') report.application.manifestSHA256 = hash(fs.readFileSync(manifest));
  const apiPort = await port(), cdpPort = await port(), inspectPort = await port();
  const env = { ...process.env, IEXA_WORKSPACE: f.workspace, IEXA_HEADLESS: '1', IEXA_PORT: String(apiPort) }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(mode === 'source' ? [root] : []), `--remote-debugging-port=${cdpPort}`, `--inspect=127.0.0.1:${inspectPort}`, '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  const spawnedAt = Date.now(), fd = fs.openSync(path.join(out, 'application.log'), 'w'); child = spawn(exe, args, { cwd: mode === 'source' ? root : dist, env, windowsHide: true, stdio: ['ignore', fd, fd] }); fs.closeSync(fd); child.on('error', error => { report.spawnError = error.stack; save(); });
  const applicationIdentity = await supervisor.claimSpawn(child, `--remote-debugging-port=${cdpPort}`, spawnedAt);
  report.application.identity = { pid: applicationIdentity.ProcessId, created: applicationIdentity.CreationDate }; save();
  const mainTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0], 'Actual app main inspector'); main = await connect(mainTarget.webSocketDebuggerUrl);
  await native("globalThis.__iexaStopElectron=(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))('electron');true");
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(target => target.type === 'page' && target.url.startsWith(`http://127.0.0.1:${apiPort}`)), 'Actual app renderer'); page = await connect(target.webSocketDebuggerUrl); await page.send('Runtime.enable'); await page.send('Network.enable');
  await until(() => ui("typeof currentSessionId==='string'&&!!currentSessionId&&typeof switchSession==='function'"), 'Original app ready');
  report.window = await native('(()=>{const w=globalThis.__iexaStopElectron.BrowserWindow.getAllWindows()[0];w.setContentSize(1384,860);w.showInactive();return {visible:w.isVisible(),focused:w.isFocused(),bounds:w.getContentBounds()}})()');
  const loadStart = Date.now(); await ui(`switchSession(${JSON.stringify(f.sid)})`);
  await until(() => ui(`currentSessionId===${JSON.stringify(f.sid)}&&runtimeForSession(currentSessionId).historyReady&&runtimeForSession(currentSessionId).historyMessages?.length===${f.historyCount}`), 'Thousands of actual history records rendered', 120000);
  const history = await ui("({mounted:document.querySelectorAll('.chat-messages .message').length,total:runtimeForSession(currentSessionId).historyMessages.length,composer:document.getElementById('chatInput').getBoundingClientRect().toJSON()})"); report.measurements.historyLoadMs = Date.now() - loadStart;
  record('Real renderer loads persisted thousands-message conversation', history);
  await ui(`(()=>{window.__stopAcceptance={events:[],frames:[],longTasks:[],startedAt:Date.now()};const a=window.__stopAcceptance;let last=performance.now();function frame(t){const gap=t-last;last=t;a.frames.push({at:Date.now(),gap});if(a.frames.length>12000)a.frames.shift();requestAnimationFrame(frame)}requestAnimationFrame(frame);try{new PerformanceObserver(list=>{for(const e of list.getEntries())a.longTasks.push({at:Date.now(),duration:e.duration})}).observe({entryTypes:['longtask']})}catch{}document.getElementById('stopBtn').addEventListener('click',()=>a.events.push({type:'stop-click',at:Date.now()}),true);const originalFetch=window.fetch;window.fetch=async function(...args){const route=String(args[0]);const tracked=/\\/api\\/(cancel|pause|chat)(\\?|$)/.test(route);if(tracked)a.events.push({type:'request',route,at:Date.now()});const r=await originalFetch.apply(this,args);if(tracked){const entry={type:'response',route,status:r.status,at:Date.now()};a.events.push(entry);if(route.includes('/api/cancel')||route.includes('/api/pause'))r.clone().json().then(body=>{entry.body=body}).catch(()=>{});}return r;};const originalHandle=handleSSEEvent;handleSSEEvent=function(part,...rest){const event=String(part).match(/^event: (.+)$/m)?.[1];if(['cancelled','paused','done','error','tool_start','tool_result'].includes(event))a.events.push({type:'sse',event,at:Date.now()});return originalHandle.call(this,part,...rest);};return true})()`);
  await typeAndSend('STOP_FIXTURE_START：运行真实长任务，稍后从聊天框停止。');
  const pids = await until(() => { if (report.fixtureSetupError) throw Error(JSON.stringify(report.fixtureSetupError)); if (!fs.existsSync(f.marker)) return false; return JSON.parse(fs.readFileSync(f.marker, 'utf8')); }, 'Actual long-shell parent/grandchild marker', 45000);
  expectedPids = [pids.parent, pids.grandchild]; expectedIdentities = await supervisor.claimFixture(expectedPids, 'long-shell.cjs');
  assert.equal((await supervisor.living(expectedIdentities)).length, 2, 'Exact task process identities alive before Stop');
  report.fixtureProcessIdentities = expectedIdentities.map(row => ({ pid: row.ProcessId, created: row.CreationDate, command: row.CommandLine })); save();
  await until(() => ui("isProcessing&&document.getElementById('stopBtn').getBoundingClientRect().width>0"), 'Chat Stop reachable'); await wait(350);
  record('Real AgentRuntime starts noisy long-running parent and grandchild', { ...pids, alive: expectedIdentities.map(() => true), identities: report.fixtureProcessIdentities, outputBytesPlanned: 384 * 1038, promptQueue: await ui('runtimeForSession(currentSessionId).promptQueue?.length||0') });
  await screenshot('before-chat-stop'); const stopSentAt = Date.now(); await click('#stopBtn');
  const processDeaths = {}; let readyAt = null, readyState = null;
  const limit = mode === 'baseline' ? 2500 : 10000; const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const living = new Set((await supervisor.living(expectedIdentities)).map(row => row.ProcessId));
    for (const pid of expectedPids) if (!processDeaths[pid] && !living.has(pid)) processDeaths[pid] = Date.now();
    const state = await ui("({processing:isProcessing,pending:!!runtimeForSession(currentSessionId).turnStopPending,paused:!!runtimeForSession(currentSessionId).pausedTurn,inputDisabled:document.getElementById('chatInput').disabled,sendDisabled:document.getElementById('sendBtn').disabled,stopVisible:document.getElementById('stopBtn').getBoundingClientRect().width>0,queue:runtimeForSession(currentSessionId).promptQueue?.length||0})");
    if (!readyAt && !state.processing && !state.pending && !state.inputDisabled && !state.sendDisabled) { readyAt = Date.now(); readyState = state; }
    if (readyAt && expectedPids.every(pid => processDeaths[pid])) break; await wait(25);
  }
  const observed = await ui('window.__stopAcceptance'); const clickAt = observed.events.find(event => event.type === 'stop-click')?.at || stopSentAt;
  const liveAfterObservation = new Set((await supervisor.living(expectedIdentities)).map(row => row.ProcessId));
  report.measurements = { ...report.measurements, clickAt, stopSentAt, readyAt, clickToReadyMs: readyAt ? readyAt - clickAt : null, readyState, processDeaths, clickToProcessDeathMs: Object.fromEntries(expectedPids.map(pid => [pid, processDeaths[pid] ? processDeaths[pid] - clickAt : null])), aliveAfterObservation: expectedPids.map(pid => ({ pid, alive: liveAfterObservation.has(pid) })), terminalEvents: observed.events.filter(event => event.type === 'sse' && ['cancelled','paused','done','error'].includes(event.event)), stopRoutes: observed.events.filter(event => event.route?.includes('/api/cancel') || event.route?.includes('/api/pause')), maxFrameGapAfterClickMs: Math.max(0, ...observed.frames.filter(frame => frame.at >= clickAt && frame.at < (readyAt || Date.now())).map(frame => frame.gap)), longTasksAfterClick: observed.longTasks.filter(task => task.at >= clickAt) };
  report.observation = observed; save(); await screenshot('after-chat-stop');
  if (mode === 'baseline') {
    report.status = 'baseline-observed'; report.baselineDefectReproduced = !readyAt || liveAfterObservation.size > 0; record('Baseline observation is recorded without altering old package', report.measurements); return;
  }
  assert.ok(readyAt, 'Chat composer becomes available after Stop'); assert.ok(readyAt - clickAt <= 2000, 'Stop→composer <=2000ms'); assert.equal(liveAfterObservation.size, 0, 'Exact owned shell parent/grandchild identities both terminated');
  assert.ok(observed.events.some(event => event.type === 'request' && event.route.includes('/api/cancel')), 'Ordinary Chat Stop sends /api/cancel'); assert.ok(!observed.events.some(event => event.type === 'request' && event.route.includes('/api/pause')), 'Ordinary Chat Stop does not pause'); assert.ok(report.measurements.terminalEvents.some(event => event.event === 'cancelled'), 'Production SSE cancellation terminal received');
  record('Chat Stop cancels real task, kills process tree and restores composer within budget', report.measurements);
  await typeAndSend('STOP_FIXTURE_NEXT：验证停止之后能立即发送新问题。');
  await until(() => ui("!isProcessing&&document.querySelector('.chat-messages').textContent.includes('NEXT_TURN_OK')"), 'Actual next user turn completes after cancellation', 20000);
  const responseErrors = page.events.filter(event => event.method === 'Network.responseReceived' && event.params.response.url.includes('/api/chat') && event.params.response.status >= 400); assert.deepEqual(responseErrors, [], 'No next-send409 or other chat HTTP error');
  record('Next actual mouse Send reaches same AgentRuntime session and completes without409', { nextMarker: 'NEXT_TURN_OK', providerRequests: report.providerRequests, finalProcessing: await ui('isProcessing') });
  await screenshot('next-turn-complete'); report.status = 'passed';
}
(async () => { await supervisor.begin(); await Promise.race([run(), supervisor.failure]); })().catch(error => {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error);
}).finally(async () => {
  try {
    if (page) { try { report.finalUI = await ui("({sessionId:currentSessionId,processing:isProcessing,text:document.querySelector('.chat-messages')?.innerText?.slice(-2500)})"); } catch {} }
    for (const identity of expectedIdentities) await killExact(identity);
    if (page) { try { await page.send('Runtime.evaluate', { expression: "void window.iexaDesktop.windowCommand('close')" }); pageClosed = true; } catch {} }
    main?.close(); page?.close(); main = page = null;
    if (child) {
      try { await until(() => child.exitCode !== null || child.signalCode !== null, 'Test application exits', 12000); }
      catch (error) { report.status = 'failed'; report.applicationExitError = error.message; process.exitCode = 1; }
      report.applicationExitCode = child.exitCode; report.applicationExitSignal = child.signalCode;
      if (child.exitCode !== 0 || child.signalCode) { report.status = 'failed'; process.exitCode = 1; }
    }
  } catch (error) { report.status = 'failed'; report.cleanupError = error.stack; process.exitCode = 1; }
  finally {
    main?.close(); page?.close();
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    try { report.resources = await supervisor.finish(); }
    catch (error) { report.status = 'failed'; report.resourceCleanupError = error.message; process.exitCode = 1; }
    report.completedAt = new Date().toISOString();
    report.fixtureCleanup = 'TEMP fixture retained; exact PID and CreationDate identities recorded; process cleanup result recorded separately';
    save(); console.log(JSON.stringify({ mode, scenario, status: report.status, error: report.error, measurements: report.measurements, report: path.join(out, 'report.json') }, null, 2));
  }
});
