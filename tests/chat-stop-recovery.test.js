const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs'), path = require('node:path');
const { functions } = require('./helpers/transcript-harness.cjs');

function fixture(fetchImpl) {
  const runtimes = new Map([['owner', { activeChatTurnToken: 4, isProcessing: true }], ['other', { activeChatTurnToken: 9, isProcessing: true }]]);
  const timers = [], cancelled = [], errors = [], calls = [];
  const sandbox = {
    currentSessionId: 'owner', visibleSessionId: 'owner', activeChatTurnToken: 4,
    API_BASE: '', Date, AbortSignal,
    runtimeForSession: id => runtimes.get(id),
    withSessionRuntime(id, callback) {
      const previous = sandbox.currentSessionId; sandbox.currentSessionId = id;
      try { return callback(); } finally { sandbox.currentSessionId = previous; }
    },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    fetch: async (route, options) => { calls.push({ route, options }); return fetchImpl(route, options); },
    stopBtn: { disabled: false, setAttribute() {}, removeAttribute() {} },
    setStatusText(value) { sandbox.status = value; },
    protectLiveTurnDom() {}, flushStreamUpdates() {}, hideWaitingIndicator() {}, snapshotActiveSessionRuntime() {},
    addError: value => errors.push(value),
    handleCancelled(token) { cancelled.push({ sessionId: sandbox.currentSessionId, token }); runtimes.get(sandbox.currentSessionId).turnStopPending = false; },
  };
  vm.createContext(sandbox);
  vm.runInContext(functions(['recoverStoppedChatTurn', 'stopProcessing']), sandbox);
  return { sandbox, runtimes, timers, cancelled, errors, calls };
}
const response = body => ({ ok: true, json: async () => body });

test('a lost cancellation terminal frame recovers from actual non-running server state', async () => {
  const f = fixture(async route => response(route.includes('/api/cancel') ? { ok: true, settled: false } : { running: false }));
  await f.sandbox.stopProcessing();
  assert.equal(f.runtimes.get('owner').turnStopPending, true);
  assert.equal(f.cancelled.length, 0, 'an acknowledgement alone never pretends the command stopped');
  await f.timers.shift()();
  assert.deepEqual(f.cancelled, [{ sessionId: 'owner', token: 4 }]);
  assert.ok(f.calls[1].route.includes('/api/agent/state?sessionId=owner'));
});

test('an acknowledgement delayed across a session switch settles only its owning session', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const stopping = f.sandbox.stopProcessing();
  f.sandbox.currentSessionId = 'other'; f.sandbox.visibleSessionId = 'other'; f.sandbox.activeChatTurnToken = 9;
  resolve(response({ ok: true, settled: true })); await stopping;
  assert.deepEqual(f.cancelled, [{ sessionId: 'owner', token: 4 }]);
  assert.equal(f.runtimes.get('other').isProcessing, true);
});

test('repeated Stop sends one cancellation and a late response cannot settle a newer turn', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const first = f.sandbox.stopProcessing(); await f.sandbox.stopProcessing();
  assert.equal(f.calls.length, 1);
  f.runtimes.get('owner').activeChatTurnToken = 5;
  resolve(response({ ok: true, settled: true })); await first;
  assert.deepEqual(f.cancelled, []);
});

test('unreachable stop endpoint restores retry without claiming that execution finished', async () => {
  const f = fixture(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
  await f.sandbox.stopProcessing();
  assert.equal(f.runtimes.get('owner').turnStopPending, false);
  assert.equal(f.runtimes.get('owner').isProcessing, true);
  assert.equal(f.sandbox.stopBtn.disabled, false);
  assert.deepEqual(f.cancelled, []);
  assert.match(f.errors[0], /超时/);
});

test('a still-running executor stays busy and offers retry when its recovery deadline expires', async () => {
  const f = fixture(async route => response(route.includes('/api/cancel') ? { ok: true } : { running: true }));
  await f.sandbox.stopProcessing();
  f.runtimes.get('owner').stopRecoveryDeadline = Date.now() - 1;
  // Install a recovery attempt using the expired absolute deadline.
  f.sandbox.recoverStoppedChatTurn('owner', 4);
  await f.timers.at(-1)();
  assert.equal(f.runtimes.get('owner').isProcessing, true);
  assert.equal(f.runtimes.get('owner').turnStopPending, false);
  assert.equal(f.sandbox.stopBtn.disabled, false);
  assert.deepEqual(f.cancelled, []);
  assert.match(f.sandbox.status, /重试/);
});

test('Stop drops late progress but still accepts cancelled tool states before the terminal turn event', () => {
  const runtime = { turnStopPending: true }, events = [];
  const sandbox = {
    currentSessionId: 'owner', activeChatTurnToken: 4, runtimeForSession: () => runtime,
    window: { IexaPermissionDialog: { closeForTool() {} }, IexaToolLifecycleView: { apply: (_block, data) => events.push(data.status) } },
    currentToolBlocks: { tool: { block: {} } }, setToolStepStatus() {}, handleToolResult: () => events.push('result'),
    handleDone: () => events.push('done'), document: { visibilityState: 'visible' },
  };
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/services/StreamPipeline.js'), 'utf8'), sandbox);
  const emit = (event, data) => sandbox.handleSSEEvent('event: ' + event + '\ndata: ' + JSON.stringify(data), 4);
  emit('text', { content: 'late text' });
  emit('tool_state', { id: 'tool', status: 'running' });
  emit('tool_state', { id: 'tool', status: 'cancelled' });
  emit('tool_result', { id: 'tool', executionStatus: 'cancelled', success: false });
  emit('done', {});
  assert.deepEqual(events, ['cancelled', 'result', 'done']);
  runtime.finishedChatTurnToken = 4; emit('tool_state', { id: 'tool', status: 'running' }); emit('done', {});
  assert.deepEqual(events, ['cancelled', 'result', 'done'], 'finished turns cannot recreate a spinner or run terminal cleanup twice');
});
