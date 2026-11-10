'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getEventListeners } = require('node:events');
const { make, remove } = require('./helpers/temp-dir');
const { AgentRuntime } = require('../dist/main/runtime/AgentRuntime');
const { ToolScheduler } = require('../dist/main/runtime/ToolScheduler');
const { ProcessManager } = require('../dist/main/tools/shell/ProcessManager');
const { ShellSessionTools } = require('../dist/main/tools/ShellSessionTools');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function callbacks(events) {
  const noop = () => {};
  return { onTextDelta: (_text, full) => events.push(['text', full]), onThinkingDelta: noop,
    onToolCallStart: noop, onToolInputDelta: noop, onToolCallComplete: noop,
    onToolResult: (id, result) => events.push(['result', id, result.executionStatus]),
    onToolState: event => events.push(['state', event.id, event.status]),
    onUsage: noop, onContext: noop, onDone: () => events.push(['done']),
    onError: error => events.push(['error', error]), onCancelled: () => events.push(['cancelled']) };
}
function runtime(t, provider, extra = {}) {
  const root = make('iexa-stop-'); t.after(() => remove(root));
  const agent = new AgentRuntime({ sessionId: 'stop-fixture', workspaceDir: root, memoryDir: path.join(root, 'memory'),
    memoryEnabled: false, provider: { name: 'openai', model: 'fixture', defaultMaxTokens: 512, ...provider }, contextWindow: 200000, permissionMode: 'full', ...extra });
  return { root, agent };
}
function request(agent, events, message = 'run') { return { message, tools: agent.toolDefinitions(), callbacks: callbacks(events) }; }
async function until(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await sleep(15); }
  assert.fail('fixture did not reach its observable boundary');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('a provider stalled in next and return stops promptly once, and late data cannot enter a new turn', { timeout: 5000 }, async t => {
  const entered = deferred(), late = deferred(); let calls = 0, returned = 0;
  const f = runtime(t, { streamMessage() {
    if (++calls === 1) return { [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return late.promise; }, return() { returned++; return new Promise(() => {}); } };
    return (async function* () { yield { type: 'textDelta', text: 'NEW_TURN_RECEIPT' }; yield { type: 'done', stopReason: 'endTurn' }; })();
  } });
  const old = [], current = [];
  const run = f.agent.run(request(f.agent, old)); await entered.promise;
  const started = Date.now(); f.agent.cancel(); f.agent.cancel(); await run;
  assert.ok(Date.now() - started < 300, 'provider cancellation must not await next/return');
  assert.equal(f.agent.isRunning(), false); assert.equal(f.agent.getState().status, 'cancelled'); assert.equal(old.filter(event => event[0] === 'cancelled').length, 1); assert.equal(returned, 1);
  await f.agent.run(request(f.agent, current, 'new request'));
  late.resolve({ done: false, value: { type: 'textDelta', text: 'LATE_OLD_TURN' } }); await tick();
  assert.deepEqual(current, [['text', 'NEW_TURN_RECEIPT'], ['done']]); assert.equal(f.agent.getState().status, 'completed'); assert.ok(!JSON.stringify(old).includes('LATE_OLD_TURN'));
});

test('noncooperative tool cancellation is bounded and suppresses late desktop state/results after a new turn', { timeout: 5000 }, async t => {
  const entered = deferred(), late = deferred(); let toolContext, providerCalls = 0, executions = 0;
  const f = runtime(t, { async *streamMessage(messages) {
    if (++providerCalls === 1) { yield { type: 'toolCallComplete', id: 'old-tool', name: 'stall_fixture', args: {} }; yield { type: 'toolCallComplete', id: 'never-started', name: 'stall_fixture', args: {} }; yield { type: 'done', stopReason: 'toolUse' }; }
    else {
      const unresolved = new Set();
      for (const message of messages) for (const part of message.parts) { if (part.type === 'toolUse') unresolved.add(part.id); else if (part.type === 'toolResult') assert.equal(unresolved.delete(part.id), true); }
      assert.equal(unresolved.size, 0, 'all old emitted calls have cancelled results before the next model request');
      yield { type: 'textDelta', text: 'NEW_AFTER_TOOL' }; yield { type: 'done', stopReason: 'endTurn' };
    }
  } });
  f.agent.registerDynamicTool({ name: 'stall_fixture', description: 'fixture', parameters: {}, required: [] }, async (_args, context) => {
    executions++; toolContext = context; entered.resolve(); await late.promise;
    context.onToolState?.({ id: 'old-tool', status: 'running', desktop: { phase: 'late' } });
    return { success: true, output: 'LATE_SUCCESS' };
  }, { risk: 'low', requiresApproval: false, parallelSafe: false, cancellable: true });
  const old = [], current = [], run = f.agent.run(request(f.agent, old)); await entered.promise;
  const started = Date.now(); f.agent.cancel(); f.agent.cancel(); await run;
  assert.ok(Date.now() - started < 450, 'tool cleanup has a fixed 150ms window'); assert.equal(toolContext.signal.aborted, true);
  assert.equal(old.filter(event => event[0] === 'cancelled').length, 1); assert.equal(old.at(-2)[0], 'result'); assert.equal(old.at(-2)[2], 'cancelled');
  await f.agent.run(request(f.agent, current, 'continue')); const before = JSON.stringify(old); late.resolve(); await tick();
  assert.equal(JSON.stringify(old), before); assert.equal(executions, 1); assert.deepEqual(current, [['text', 'NEW_AFTER_TOOL'], ['done']]); assert.equal(f.agent.getState().status, 'completed');
});

test('a never-resolving approval stops without running the tool or granting a late turn', { timeout: 3000 }, async t => {
  const entered = deferred(), permission = deferred(); let executions = 0;
  const f = runtime(t, { async *streamMessage() { yield { type: 'toolCallComplete', id: 'approval', name: 'approval_fixture', args: {} }; yield { type: 'done', stopReason: 'toolUse' }; } },
    { permissionMode: 'risk', permissionResolver: () => { entered.resolve(); return permission.promise; } });
  f.agent.registerDynamicTool({ name: 'approval_fixture', description: '', parameters: {}, required: [] }, async () => { executions++; return { success: true, output: 'bad' }; }, { requiresApproval: true, risk: 'high' });
  const events = [], run = f.agent.run(request(f.agent, events)); await entered.promise; f.agent.cancel(); await run;
  assert.equal(executions, 0); assert.equal(events.at(-1)[0], 'cancelled'); permission.resolve('allow_session'); await tick(); assert.equal(executions, 0);
});

test('a hung descendant cleanup does not strand the parent terminal state', { timeout: 3000 }, async t => {
  const entered = deferred();
  const tree = { definitions: () => [], cancelDescendants() {}, settleDescendants: () => new Promise(() => {}), hasActiveWork: () => true };
  const f = runtime(t, { streamMessage() { return { [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return new Promise(() => {}); } }; } }, { subAgentTree: tree });
  const events = [], run = f.agent.run(request(f.agent, events)); await entered.promise; const started = Date.now(); f.agent.cancel(); await run;
  assert.ok(Date.now() - started < 450); assert.equal(events.at(-1)[0], 'cancelled'); assert.equal(f.agent.isRunning(), false);
});

test('tool deadlines also settle when executor ignores its signal and remove listeners', { timeout: 3000 }, async () => {
  const controller = new AbortController(); const started = Date.now(); let seen;
  const result = await new ToolScheduler().execute({ timeoutMs: 20, execute: (_args, context) => { seen = context.signal; return new Promise(() => {}); } }, {}, { signal: controller.signal });
  assert.equal(result.executionStatus, 'timed_out'); assert.equal(result.success, false); assert.equal(seen.aborted, true); assert.ok(Date.now() - started < 450); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a pre-aborted process never starts a command with side effects', async t => {
  const root = make('iexa-stop-preabort-'); t.after(() => remove(root)); const controller = new AbortController(); controller.abort();
  const marker = path.join(root, 'must-not-exist');
  const result = await new ProcessManager().run(`echo bad > "${marker}"`, root, controller.signal, { timeoutMs: 5000, maxOutputBytes: 4096, killGracePeriodMs: 500 }, 'cmd');
  assert.equal(result.cancelled, true); assert.equal(fs.existsSync(marker), false);
});

test('cancel during asynchronous CMD/PowerShell materialization never launches the late command', { skip: process.platform !== 'win32', timeout: 5000 }, async t => {
  const root = make('iexa-stop-materialize-'); t.after(() => remove(root));
  const original = fs.promises.writeFile;
  try {
    for (const shell of ['cmd', 'powershell']) {
      const entered = deferred(), release = deferred(), controller = new AbortController(), marker = path.join(root, 'must-not-exist-' + shell);
      fs.promises.writeFile = async function (file, ...args) {
        const result = await original.call(this, file, ...args);
        if (String(file).endsWith(shell === 'cmd' ? 'command.cmd' : 'command.ps1')) { entered.resolve(); await release.promise; }
        return result;
      };
      const command = shell === 'cmd' ? `echo bad > "${marker}"` : `Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value bad`;
      const pending = new ProcessManager().run(command, root, controller.signal, { timeoutMs: 5000, maxOutputBytes: 4096, killGracePeriodMs: 500 }, shell);
      await entered.promise; controller.abort(); release.resolve(); const result = await pending;
      assert.equal(result.cancelled, true); await sleep(30); assert.equal(fs.existsSync(marker), false);
    }
  } finally { fs.promises.writeFile = original; }
});

test('real command cancellation kills a sleeping parent/grandchild while output is still streaming', { timeout: 10000 }, async t => {
  const entered = deferred(); let providerCalls = 0;
  const f = runtime(t, { async *streamMessage() {
    if (++providerCalls === 1) { yield { type: 'toolCallComplete', id: 'shell', name: 'shell_execute', args: { tool_title: 'Stop fixture streaming command', command: `"${process.execPath}" "${path.join(f.root, 'worker.cjs')}"`, shell: process.platform === 'win32' ? 'cmd' : 'auto' } }; yield { type: 'done', stopReason: 'toolUse' }; }
    else { yield { type: 'textDelta', text: 'NEW_REAL_TURN' }; yield { type: 'done', stopReason: 'endTurn' }; }
  } });
  const pidsFile = path.join(f.root, 'pids.json');
  fs.writeFileSync(path.join(f.root, 'worker.cjs'), `const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>process.stdout.write('STREAM_RECEIPT:'+'.'.repeat(4096)+'\\n'),4);setInterval(()=>{},1000);`);
  const old = [], actualRequest = request(f.agent, old);
  actualRequest.callbacks.onToolResult = (id, result) => old.push(['result', id, result.executionStatus, result.output]);
  const run = f.agent.run(actualRequest);
  let pids;
  try { pids = await until(() => { try { return JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { return null; } }); }
  catch (error) { f.agent.cancel(); await run; assert.fail(error.message + ': ' + JSON.stringify(old)); }
  t.after(() => { for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  await sleep(80); const started = Date.now(); f.agent.cancel(); f.agent.cancel(); await run;
  assert.ok(Date.now() - started < 650); assert.equal(old.at(-1)[0], 'cancelled');
  await until(() => pids.every(pid => !alive(pid)), 4000);
  const current = []; await f.agent.run(request(f.agent, current, 'new request'));
  assert.deepEqual(current, [['text', 'NEW_REAL_TURN'], ['done']]); assert.equal(f.agent.getState().status, 'completed');
});

test('persistent shell sends pass abort through to terminal tree termination and settle promptly', { timeout: 3000 }, async () => {
  let kills = 0; const entered = deferred();
  const info = { id: 'terminal', shell: 'powershell', cwd: process.cwd(), running: true, createdAt: Date.now() };
  const manager = { create: () => info, write() { entered.resolve(); }, output: () => ({ chunks: [], lastSeq: 0, running: true }), async terminate() { kills++; info.running = false; info.endedAt = Date.now(); } };
  const tools = new ShellSessionTools(process.cwd(), manager); await tools.execute('open', {}, 'owner');
  const controller = new AbortController(), pending = tools.execute('send', { session_id: 'terminal', command: 'Start-Sleep -Seconds 600' }, 'owner', controller.signal);
  await entered.promise; const started = Date.now(); controller.abort(); const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(kills, 1); assert.ok(Date.now() - started < 200); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('shell_session non-send actions do not require or classify a command', async t => {
  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime'); const root = make('iexa-stop-shell-schema-'); t.after(() => remove(root));
  const seen = [], shellSessions = { execute: async (action, args) => { seen.push([action, args.command]); return { output: action, success: true }; } };
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: root, memoryEnabled: false, permissionMode: 'full', shellSessions }); runtime.registerDefaults(); runtime.beginRun();
  for (const action of ['open', 'list', 'read', 'close']) {
    const result = await runtime.execute('shell_session', { tool_title: 'Manage persistent terminal', action, ...(action === 'read' || action === 'close' ? { session_id: 'test-id' } : {}) }, { sessionId: 'owner', toolCallId: action, workspaceDir: root, signal: new AbortController().signal });
    assert.equal(result.success, true, result.output); assert.equal(result.output, action);
  }
  assert.deepEqual(seen, [['open', undefined], ['list', undefined], ['read', undefined], ['close', undefined]]);
});

test('cancelling a real hook ends its parent and grandchild without launching the pending tool', { timeout: 10000 }, async t => {
  const { runHooks } = require('../dist/main/runtime/HookRunner'); const root = make('iexa-stop-hook-'); t.after(() => remove(root));
  const script = path.join(root, 'hook.cjs'), marker = path.join(root, 'pids.json');
  fs.writeFileSync(script, `const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const controller = new AbortController(), pending = runHooks([{ phase: 'preToolUse', script, timeoutMs: 10000 }], { phase: 'preToolUse', tool: 'file_write', args: {}, sessionId: 'stop' }, root, controller.signal);
  const pids = await until(() => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return null; } });
  t.after(() => { for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const started = Date.now(); controller.abort(); const result = await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 450, 'hook cancellation acknowledgement is bounded, took ' + elapsed + 'ms');
  t.diagnostic('real hook cancellation acknowledged in ' + elapsed + 'ms');
  assert.ok(result.errors.some(error => /取消/.test(error))); await until(() => pids.every(pid => !alive(pid)), 3000);
});

test('a stalled process-cleanup helper cannot hold hook cancellation open', { timeout: 4000 }, async t => {
  const processes = require('../dist/main/tools/shell/ProcessManager');
  const { runHooks } = require('../dist/main/runtime/HookRunner');
  const root = make('iexa-stop-hook-cleanup-'); t.after(() => remove(root));
  const script = path.join(root, 'hook.cjs'), marker = path.join(root, 'pid.txt');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
  const original = processes.terminateProcessTree;
  let cleanup;
  processes.terminateProcessTree = (child, graceMs) => {
    cleanup = original(child, graceMs);
    return cleanup.then(() => new Promise(() => {}));
  };
  const controller = new AbortController();
  const pending = runHooks([{ phase: 'preToolUse', script, timeoutMs: 10000 }], { phase: 'preToolUse', tool: 'file_write', args: {}, sessionId: 'stop' }, root, controller.signal);
  let pid;
  try {
    pid = await until(() => { try { return Number(fs.readFileSync(marker, 'utf8')); } catch { return null; } });
    const started = Date.now(); controller.abort(); const result = await pending;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 450, 'stalled cleanup cannot retain the hook await, took ' + elapsed + 'ms');
    assert.ok(result.errors.some(error => /取消/.test(error)));
    await cleanup; await until(() => !alive(pid), 2000);
    t.diagnostic('stalled-cleanup hook cancellation acknowledged in ' + elapsed + 'ms; owned process exited');
  } finally {
    controller.abort(); processes.terminateProcessTree = original;
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});
