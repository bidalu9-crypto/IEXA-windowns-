'use strict';

// One decision-maker per run. Business actions are supplied by the selected
// IEXA model or live Codex session; this harness contains no GUI action plan.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const root = path.resolve(__dirname, '..'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_TOOLS = 60, MAX_RUNTIME = 480000;

// A narrowly scoped retest, deliberately distinct from the fresh-app comparison.
function existingCalculatorHandle(mode, kind) {
  const value = process.env.IEXA_COMPARISON_EXISTING_CALCULATOR_HANDLE;
  if (value === undefined) return null;
  if (mode !== 'iexa' || kind !== 'calculator' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw Error('IEXA_COMPARISON_EXISTING_CALCULATOR_HANDLE requires iexa calculator and a positive exact HWND');
  return Number(value);
}

function scopedModelHost(packagedRoot, handle) {
  const { DesktopAgent } = require(path.join(packagedRoot, 'dist/main/tools/DesktopAgent'));
  const original = DesktopAgent.prototype.execute;
  const native = DesktopAgent.prototype.executeNative;
  const currentControls = new Map();
  let verifiedCalculator = false;
  const forbiddenControl = element => /close|minimize|关闭|最小化|清除历史|clear.?history|delete.?history|clear.?memory|清除内存|清除记忆/i.test(JSON.stringify(element?.selector || {}) + ' ' + String(element?.text || ''));
  DesktopAgent.prototype.executeNative = async function(args, signal) {
    const action=String(args.action||'');
    if (args.handle !== undefined && args.handle !== handle) return {success:false,output:'Scoped retest rejects a different native HWND'};
    if (['click','move','drag','scroll','minimize','launch','bind_window'].includes(action)) return {success:false,output:'Scoped retest requires observed semantic controls; coordinates and lifecycle changes are disabled'};
    if (['click_element','type_element'].includes(action)) {
      const element=currentControls.get(args.elementId);
      if (!verifiedCalculator || !element || forbiddenControl(element)) return {success:false,output:'Scoped retest permits only currently observed Calculator controls and preserves its window and history'};
    }
    if (['key','hotkey','type','click_element','type_element'].includes(action) && !verifiedCalculator)
      return {success:false,output:'Calculator identity must be verified by exact-handle observation first'};
    const result=await native.call(this,{...args,...(['observe','list_windows','activate'].includes(action)?{handle}:{})},signal);
    if(action==='observe'&&result.success){
      let data;try{data=JSON.parse(result.output).data;}catch{}
      const valid=data?.session?.handle===handle && /^(CalculatorApp|Calculator|ApplicationFrameHost)$/i.test(data?.foreground?.process||'')
        && /计算器|calculator/i.test(data?.foreground?.title||'');
      verifiedCalculator=!!valid;currentControls.clear();
      if(!valid)return {success:false,output:'Authorized HWND did not identify as Calculator; no input permitted'};
      for(const element of data.elements||[])currentControls.set(element.id,element);
    }
    return result;
  };
  const observed = new Set();
  DesktopAgent.prototype.execute = async function(args, signal, context) {
    const owner = context?.owner, action = String(args.action || '');
    const validate = step => {
      if (step.handle !== undefined && step.handle !== handle) throw Error('Existing Calculator retest permits only its authorized exact HWND');
      if (step.backend !== undefined && step.backend !== 'native') throw Error('Existing Calculator retest requires native');
      if (step.window !== undefined || step.pid !== undefined || step.process !== undefined || step.cdpEndpoint !== undefined || step.cdpTargetId !== undefined)
        throw Error('Use the authorized exact HWND, not another target selector');
      if (['launch','minimize','bind_window'].includes(step.action) || step.allowClose === true || step.expectWindowClosed === true)
        throw Error('Existing Calculator retest may not launch, close, minimize or rebind applications');
      if (['WIN','WINDOWS','LWIN','RWIN','ALT','LALT','RALT'].some(key => (step.keys || []).some(value => String(value).toUpperCase() === key))
        || /^(WIN|WINDOWS|LWIN|RWIN|ALT|LALT|RALT)$/i.test(String(step.key || '')))
        throw Error('Application-switching and window-closing chords are outside this scoped retest');
      if (step.action === 'hotkey' && (step.keys||[]).some(key=>String(key).toUpperCase()==='CTRL')
        && (step.keys||[]).some(key=>/^(D|L|W|F4)$/i.test(String(key)))) throw Error('History deletion and closing chords are outside this scoped retest');
      if (/^(DELETE|DEL)$/i.test(String(step.key||'')) || (step.keys||[]).some(key=>/^(DELETE|DEL)$/i.test(String(key))))
        throw Error('Use the observed display-clear control; delete keys could remove history');
      if (step.target && /close|关闭|清除历史|clear.?history|delete.?history/i.test(JSON.stringify(step.target)))
        throw Error('Existing Calculator window and history must be preserved');
      if (step.action === 'batch') {
        if (!Array.isArray(step.actions)) throw Error('Expected batch actions');
        step.actions.forEach(validate);
      }
    };
    try {
      validate(args);
      if (action !== 'observe' && action !== 'list_windows' && !observed.has(owner)) throw Error('Observe the exact authorized Calculator HWND before input');
      const result = await original.call(this, { ...args, ...(action === 'observe' || action === 'list_windows' || action === 'activate' ? {handle} : {}), backend:'native', controlMode:'foreground' }, signal, context);
      if (action === 'observe' && result.success) observed.add(owner);
      return result;
    } catch (error) { return {success:false,output:String(error.message || error)}; }
  };
  process.argv[2] = packagedRoot;
  require('./helpers/model-backend-host.cjs');
}

function safeEvent(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(imageData|base64|image_url|imageUrl|dataUrl)$/i.test(key)) return undefined;
    if (/^(apiKey|api_key|authorization|cookie|password|accessToken|refreshToken|secret)$/i.test(key)) return '[REDACTED]';
    return item;
  }));
}

// Separate owned process: the parent supervisor tracks the controller and its
// auto-started helper/apps. No parent-tree ownership is fabricated for the CLI.
async function controllerWorker(appRoot, journal) {
  const { DesktopAgent } = require(path.join(appRoot, 'dist/main/tools/DesktopAgent'));
  const agent = new DesktopAgent(appRoot, false, journal);
  let active, closing = false;
  process.on('message', async message => {
    try {
      if (message.quit) {
        closing = true; active?.abort(); agent.close();
        setTimeout(() => process.exit(0), 150).unref(); return;
      }
      if (message.cancel) { active?.abort(); return; }
      if (closing || active) throw Error('Controller is closing or already executing an action');
      active = new AbortController();
      try {
        const result = await agent.execute(message.args, active.signal, { owner: message.owner, operationId: message.operationId });
        const media = result.imageData;
        const imageBase64 = typeof media === 'string' ? media : media ? Buffer.from(media).toString('base64') : undefined;
        process.send({ id: message.id, result: safeEvent(result), imageBase64 });
      } finally { active = undefined; }
    } catch (error) { process.send({ id: message.id, error: error.stack }); }
  });
  process.send({ ready: true, host: 'packaged DesktopAgent shared controller; live Codex supplies each action' });
}

function rpcChild(child) {
  let sequence = 0; const pending = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const rejectAll = error => { rejectReady(error); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.once('error', rejectAll);
  child.once('exit', (code, signal) => rejectAll(Error('Owned host exited: ' + JSON.stringify({ code, signal }))));
  child.on('message', message => {
    if (message.ready) return resolveReady(message);
    const item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(Error(message.error)) : item.resolve(message); }
    else if (message.error) rejectReady(Error(message.error));
  });
  return { ready, request(body, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Owned host request timed out')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, ...body }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
  }, dispose() { rejectAll(Error('Acceptance host closed')); } };
}

function oraclePassed(oracle) {
  if (oracle?.status) return oracle.status === 'passed';
  if (typeof oracle?.passed === 'boolean') return oracle.passed;
  return oracle?.checks && Object.keys(oracle.checks).length > 0 && Object.values(oracle.checks).every(value => value === true);
}

async function run(mode, kind) {
  if (!['iexa', 'codex'].includes(mode) || !['paint', 'wordpad', 'calculator'].includes(kind)) throw Error('Usage: check-desktop-comparison.cjs iexa|codex paint|wordpad|calculator');
  const { createTask } = require('./fixtures/desktop-comparison-tasks.cjs');
  const { createSupervisor, processTable } = require('./helpers/acceptance-supervisor.cjs');
  const { runCurrentModelAcceptance } = require('./helpers/current-model-acceptance.cjs');
  const authorizedHandle = existingCalculatorHandle(mode, kind);
  const verifyAsyncClose = process.env.IEXA_VERIFY_ASYNC_CLOSE === '1';
  if (verifyAsyncClose && (mode !== 'iexa' || kind !== 'calculator' || authorizedHandle))
    throw Error('IEXA_VERIFY_ASYNC_CLOSE=1 requires iexa calculator with a fresh test window, not authorized-existing mode');
  const out = path.join(root, '.iexa-artifacts/desktop-comparison-20261110', `${mode}-${kind}-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const task = createTask(kind, out), runId = randomUUID();
  const appRoot = path.join(root, 'release/IEXA-preview-20261109'), packagedRoot = path.join(appRoot, 'resources/app');
  let goal = authorizedHandle ? `这是用户授权的现有计算器窗口独立复测，唯一授权窗口handle=${authorizedHandle}，不是新窗口同条件对比。先使用desktop_control action=observe、handle=${authorizedHandle}确认计算器，再必要时action=activate同一个精确handle；若句柄失效或不是计算器，立即停止并如实报告。禁止launch启动新应用，禁止操作其他窗口，禁止关闭或最小化此窗口，保留现有历史记录。通过该计算器界面依次计算 (137 + 289) × 7 − 53，以及144的平方根。每次读取实际显示结果并截图；打开历史记录核对两次结果仍在记录中。不要在消息里心算后冒充应用结果。可以在开始和最后只清当前显示，禁止清除历史。全部业务仅使用desktop_control，backend=native、controlMode=foreground，必要时focusPolicy=activate；不使用shell、脚本或文件工具代做业务。不要传window/process/pid等其他定位条件，只用该精确handle和当前观察的控件。原生key/hotkey不要传target。完成后保留窗口和历史并正常给出最终结果。最多60次工具调用、8分钟。`
    : task.goal + '\n两边统一约束：仅使用 desktop_control 操作真实应用界面。backend=native，controlMode=foreground，允许 focusPolicy=activate；截图和当前控件用于定位，禁止脚本或文件工具代做业务。仅操作本轮测试文件及自启动窗口，不修改用户设置。最多60次工具调用、8分钟。完成后关闭测试窗口并正常给出最终结果。';
  if (verifyAsyncClose) goal += '\n本轮追加异步关闭验收：完成计算和历史核对后，关闭前通过实际观察记录本轮计算器的精确窗口 handle 原值。最终关闭动作显式设置 expectWindowClosed:true；核对真实关闭回执，不凭派发或失焦推断成功。关闭后再独立调用 desktop_control action=list_windows，handle=关闭前记录的原值，includeHidden:true，limit:1，不附加 pid/process/title 过滤，确认 windows 空列表。若回执失败或窗口仍存在，如实报告，不重放关闭输入、不将事后清理当作模型成功。';
  const report = { runId, mode, kind, status: 'running', phase: 'preflight', startedAt: new Date().toISOString(), goal,
    scope: mode === 'iexa' ? 'Current selected IEXA model; packaged production backend; desktop_control only' : 'Codex current session decisions through the same packaged DesktopAgent; not native Codex app computer-use tools',
    comparisonMode: authorizedHandle ? 'authorized-existing' : 'fresh-application', sameInitialConditions: !authorizedHandle,
    ...(authorizedHandle ? {authorizedExisting:{handle:authorizedHandle,preserveWindow:true,preserveHistory:true,baselineProcesses:[]}} : {}),
    ...(verifyAsyncClose ? {asyncCloseAcceptance:true,acceptanceVariant:'fresh-calculator-explicit-close-proof'} : {}),
    controllerSamePackage: true, fixture: task.fixture, limits: { maxTools: MAX_TOOLS, maxRuntimeMs: MAX_RUNTIME }, calls: [], events: [], imageIndex: [] };
  if (authorizedHandle) report.scope += '; authorized-existing Calculator exact HWND; baseline processes observed only, never claimed or killed; not an equal-initial-state comparison';
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); save();
  const names = new Set(task.processNames.map(name => String(name).toLowerCase()));
  const supervisor = createSupervisor({ output: out, maximumDurationMs: 600000, allowFixtureCleanup: true, observeProcess: row => names.has(String(row.Name).toLowerCase()) });
  let child, rpc, evaluate, sessionId, server, deadline, actionPromise, finishPromise, deadlineAt, finished = false;
  let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
  const runtimeAbort = new AbortController();

  const persistImage = (base64, callId, receivedAt = Date.now()) => {
    const imagePath = path.join(out, `model-frame-${report.imageIndex.length}.png`);
    fs.writeFileSync(imagePath, Buffer.from(base64, 'base64'));
    report.imageIndex.push({ toolCallId: callId, receivedAt, path: imagePath }); return imagePath;
  };
  const finish = (reason = 'completed') => {
    if (finishPromise) return finishPromise;
    finished = true; clearTimeout(deadline); report.phase = 'finishing'; report.stopReason = reason; save();
    finishPromise = (async () => {
      if (reason !== 'completed') { runtimeAbort.abort(); if (child?.connected && mode === 'codex') child.send({ cancel: true }); }
      if (actionPromise) try { await Promise.race([actionPromise, sleep(6000)]); } catch {}
      try {
        report.phase = 'verifying'; save();
        report.oracle = await task.verify({ calls: report.calls, events: report.events, imageIndex: report.imageIndex });
        report.businessStatus = oraclePassed(report.oracle) ? 'passed' : 'failed';
      } catch (error) { report.oracleError = error.stack; report.businessStatus = 'failed'; }
      if (evaluate && sessionId) try {
        await evaluate(`fetch('/api/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:${JSON.stringify(sessionId)}})}).then(r=>r.json())`);
      } catch (error) { report.cancelError = error.message; }
      if (child?.connected) child.send({ quit: true });
      if (child) for (let i = 0; i < 60 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
      rpc?.dispose();
      try { report.resources = await supervisor.finish(); }
      catch (error) { report.resourceError = error.message; }
      report.phase = 'finished'; report.completedAt = new Date().toISOString();
      report.elapsedMs = report.readyAt ? Date.now() - report.readyAt : null;
      report.actionCount = report.calls.length;
      report.modelCompleted = mode === 'iexa' ? report.modelState?.status === 'completed' && report.modelState?.done === true : reason === 'completed';
      report.status = report.businessStatus === 'passed' && report.modelCompleted && !report.error && !report.resourceError && reason === 'completed' ? 'passed' : 'failed'; save();
      if (server) { server.close(); server.closeIdleConnections?.(); }
      resolveDone();
      console.log(JSON.stringify({ status: report.status, businessStatus: report.businessStatus, modelCompleted: report.modelCompleted, actionCount: report.actionCount, out, error: report.error, resourceError: report.resourceError }));
      process.exitCode = report.status === 'passed' ? 0 : 1; return report;
    })();
    return finishPromise;
  };

  try {
    // Capture existing observed-process identities before any rejection path:
    // finish() must classify preflight blockers as baseline, never run leaks.
    // This grants no ownership and still runs before spawning the controller.
    await supervisor.begin();
    const existing = (await processTable()).filter(row => names.has(String(row.Name).toLowerCase()) || /^(IEXA|electron)\.exe$/i.test(row.Name));
    const blockers = existing.filter(row => !authorizedHandle || !names.has(String(row.Name).toLowerCase()));
    if (blockers.length) throw Error('Existing application prevents exclusive acceptance: ' + blockers.map(p => `${p.Name}:${p.ProcessId}`).join(', '));
    if (authorizedHandle) {
      report.authorizedExisting.baselineProcesses = existing.map(row=>({pid:row.ProcessId,created:row.CreationDate,name:row.Name,ownership:'observed-only'}));
      if (!existing.length) throw Error('Authorized existing Calculator has no baseline Calculator process; launch is prohibited');
      save();
    }
    try { await fetch('http://127.0.0.1:17891/health', { signal: AbortSignal.timeout(400) }); throw Error('Desktop helper port occupied; existing helper will not be replaced'); }
    catch (error) { if (error.message.startsWith('Desktop helper port occupied')) throw error; }
    report.packageManifestSHA256 = sha(fs.readFileSync(path.join(appRoot, 'build-manifest.json')));
    report.controllerSHA256 = sha(fs.readFileSync(path.join(packagedRoot, 'dist/main/tools/DesktopAgent.js')));
    const host = mode === 'iexa' && !authorizedHandle ? path.join(root, 'scripts/helpers/model-backend-host.cjs') : __filename;
    const args = authorizedHandle ? [host, '__scoped-model-host', packagedRoot, String(authorizedHandle)] : mode === 'iexa' ? [host, packagedRoot] : [host, '__controller-worker', packagedRoot, path.join(out, 'journal')];
    const fd = fs.openSync(path.join(out, 'application.log'), 'w'), started = Date.now();
    child = spawn(path.join(appRoot, 'IEXA.exe'), ['--max-old-space-size=384', ...args], { cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', IEXA_WORKSPACE: path.join(root, 'workspace') }, windowsHide: true, stdio: ['ignore', fd, fd, 'ipc'] });
    fs.closeSync(fd); rpc = rpcChild(child);
    const identity = await supervisor.claimSpawn(child, host, started);
    report.host = { pid: identity.ProcessId, created: identity.CreationDate };
    const ready = await Promise.race([rpc.ready, supervisor.failure]);
    report.phase = 'running'; report.readyAt = Date.now(); deadlineAt = report.readyAt + MAX_RUNTIME; report.deadlineAt = deadlineAt; save();
    supervisor.failure.catch(error => { report.error = error.message; void finish('resource_failure'); });

    if (mode === 'iexa') {
      evaluate = async expression => (await rpc.request({ expression }, 25000)).value;
      const setup = await evaluate('(' + runCurrentModelAcceptance.toString() + ')(' + JSON.stringify({ runId, goal, originalSessionId: ready.originalSessionId, maxTools: MAX_TOOLS, maxRuntimeMs: MAX_RUNTIME }) + ')');
      report.setup = setup; sessionId = setup.sessionId; save();
      let savedImages = 0, lastCount = 0;
      while (!finished) {
        const state = await evaluate('(()=>{const s=window.__iexaAcceptance;return {status:s.status,done:s.done,model:s.model,toolCalls:s.toolCalls,calls:s.calls,answer:s.answer,events:s.events,imageCount:s.images.length}})()');
        report.modelState = state; report.calls = state.calls; report.events = state.events; save();
        if (state.toolCalls !== lastCount) { lastCount = state.toolCalls; console.log(JSON.stringify({ out, toolCalls: lastCount, status: state.status })); }
        if (state.imageCount > savedImages) {
          const images = await evaluate('window.__iexaAcceptance.images.slice(' + savedImages + ')');
          for (const image of images) { persistImage(image.base64, image.toolCallId, image.receivedAt); savedImages++; }
          await evaluate('window.__iexaAcceptance.images.slice(0,' + savedImages + ').forEach(i=>i.base64="");true'); save();
        }
        if (state.done) break;
        if (Date.now() > deadlineAt + 20000) throw Error('Model cancellation did not settle within the bounded grace period');
        await Promise.race([sleep(2000), supervisor.failure]);
      }
      if (!finished) {
        const state = await evaluate('window.__iexaAcceptance'); report.modelState = { ...state, images: undefined }; report.calls = state.calls; report.events = state.events;
        for (const image of state.images.slice(savedImages)) persistImage(image.base64, image.toolCallId, image.receivedAt);
        await finish(state.status === 'completed' ? 'completed' : state.cancelReason || state.status || 'model_failed');
      }
    } else {
      const token = randomBytes(32).toString('hex');
      const authorized = request => { const supplied = Buffer.from(String(request.headers['x-comparison-token'] || '')), expected = Buffer.from(token); return supplied.length === expected.length && timingSafeEqual(supplied, expected); };
      const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
      server = http.createServer(async (request, response) => {
        if (!authorized(request)) return send(response, 403, { error: 'Unauthorized local comparison request' });
        if (request.method !== 'POST' || !['/action', '/finish'].includes(request.url)) return send(response, 404, { error: 'Unknown comparison route' });
        try {
          if (request.url === '/finish') { const result = await finish(); return send(response, 200, { status: result.status, businessStatus: result.businessStatus, out }); }
          if (finished) return send(response, 409, { error: 'Comparison already finished' });
          if (actionPromise) return send(response, 409, { error: 'A desktop action is already running' });
          if (Date.now() >= deadlineAt || report.calls.length >= MAX_TOOLS) { void finish(Date.now() >= deadlineAt ? 'runtime_limit' : 'tool_limit'); return send(response, 409, { error: 'Comparison budget exhausted' }); }
          let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 65536) throw Error('Desktop action body too large'); }
          const supplied = JSON.parse(raw); if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object' || typeof supplied.action !== 'string') throw Error('Expected one desktop action object');
          if (supplied.backend && supplied.backend !== 'native') throw Error('Comparison is restricted to the native shared controller');
          const args = { backend: 'native', controlMode: 'foreground', focusPolicy: 'activate', ...supplied };
          const id = 'codex_' + randomUUID(), call = { id, name: 'desktop_control', args: safeEvent(args), completedAt: Date.now() }; report.calls.push(call);
          report.events.push({ event: 'tool_complete', data: { id, name: call.name, args: call.args } }); save();
          actionPromise = (async () => {
            try {
              const reply = await rpc.request({ args, owner: 'codex-' + runId, operationId: id }, Math.min(90000, Math.max(1000, deadlineAt - Date.now())));
              const result = reply.result; call.success = result.success === true; call.resultAt = Date.now(); call.executionStatus = result.success ? 'completed' : 'failed';
              report.events.push({ event: 'tool_result', data: { id, ...safeEvent(result) } });
              const imagePath = reply.imageBase64 ? persistImage(reply.imageBase64, id) : undefined; save();
              const responseFile = path.join(out, `action-result-${report.calls.length}.json`);
              const response = { id, success: result.success, output: result.output, durationMs: result.durationMs, imagePath, actionCount: report.calls.length, remainingMs: Math.max(0, deadlineAt - Date.now()), responseFile };
              fs.writeFileSync(responseFile, JSON.stringify(response, null, 2)); return response;
            } catch (error) {
              call.success = false; call.resultAt = Date.now(); call.executionStatus = 'failed';
              report.events.push({ event: 'tool_result', data: { id, success: false, output: error.message } }); save(); throw error;
            }
          })();
          try { send(response, 200, await actionPromise); } finally { actionPromise = undefined; }
        } catch (error) { send(response, 500, { error: error.message }); }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      // The token is an ephemeral loopback capability, not a model credential.
      const bridgeFile = path.join(out, 'bridge.json'); fs.writeFileSync(bridgeFile, JSON.stringify({ endpoint: 'http://127.0.0.1:' + server.address().port, token, runId, deadlineAt }));
      deadline = setTimeout(() => { void finish('runtime_limit'); }, Math.max(1, deadlineAt - Date.now()));
      console.log(JSON.stringify({ ready: true, mode, kind, out, bridgeFile, goal, deadlineAt }));
      await done;
    }
  } catch (error) { report.error = error.stack; await finish('error'); }
  finally { if (!finished) await finish('unexpected_exit'); }
  return report.status === 'passed' ? 0 : 1;
}

async function client(route, out, json) {
  out = path.resolve(out);
  if (route === 'finish' && fs.existsSync(path.join(out, 'report.json'))) {
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    if (report.phase === 'finished') { console.log(JSON.stringify({ status: report.status, businessStatus: report.businessStatus, out, alreadyFinished: true })); return 0; }
  }
  const bridge = JSON.parse(fs.readFileSync(path.join(out, 'bridge.json'), 'utf8')), target = new URL(bridge.endpoint);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' || target.username || target.password) throw Error('Invalid loopback bridge endpoint');
  const body = route === 'call' ? JSON.parse(json) : {};
  const response = await fetch(new URL(route === 'call' ? '/action' : '/finish', target), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-comparison-token': bridge.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  if (typeof result.output === 'string' && result.output.length > 18000) {
    result.outputCharacters = result.output.length; result.output = result.output.slice(0, 18000); result.outputTruncated = true;
  }
  console.log(JSON.stringify(result)); return response.ok ? 0 : 1;
}

const [mode, kind, json] = process.argv.slice(2);
if (mode === '__scoped-model-host') scopedModelHost(kind, Number(json));
else if (mode === '__controller-worker') controllerWorker(kind, json).catch(error => { process.send?.({ error: error.stack }); process.exitCode = 1; });
else if (mode === 'call' || mode === 'finish') client(mode, kind, json).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
else run(mode, kind).then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack); process.exitCode = 1; });
