// The setting must actually change behaviour, not just persist. Two halves:
//  1. the real server round-trips a custom window and a custom trigger point;
//  2. a real AgentLoop compacts at 50% and does not compact at 100% for the
//     same history — that difference can only come from the configured ratio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentLoop } = require('../dist/main/agent/AgentLoop');

const noop = () => {};
const text = (role, value) => ({ role, parts: [{ type: 'text', text: value }] });
const user = (value) => text('user', value);
function toolPair(id, size = 2000) {
  return [
    { role: 'assistant', parts: [{ type: 'toolUse', id, name: 'fixture', input: { path: `src/${id}.ts` } }] },
    { role: 'user', parts: [{ type: 'toolResult', id, name: 'fixture', content: `${id}: verified\n` + 'e'.repeat(size) }] },
  ];
}
function history(count = 60, size = 2000) {
  return [user('LATEST_USER_REQUEST: keep the exact constraints'), ...Array.from({ length: count }, (_, i) => toolPair(`call-${i}`, size)).flat()];
}
const isSummary = (request) => request.system === 'You are a precise context-compaction engine.';

async function runWith(ratio, window) {
  const events = { compacted: [], errors: [], done: 0 };
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 512,
    async *streamMessage(request) {
      if (isSummary(request)) { yield { type: 'textDelta', text: 'CHECKPOINT: older work summarised.' }; return; }
      yield { type: 'textDelta', text: 'done' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const runtime = {
    initialize: async () => {}, beginTurn: noop, getBudget: () => ({ maxTurns: 4 }),
    recordInputTokens: noop, isParallelSafe: () => false,
    async execute() { return { success: true, output: 'ok' }; },
  };
  const loop = new AgentLoop({
    sessionId: 'compaction-live', workspaceDir: process.cwd(), memoryDir: process.cwd(), memoryEnabled: false,
    provider, toolRuntime: runtime, contextWindow: window, maxTokens: 512,
    compactionThresholdRatio: ratio, getAbortSignal: () => new AbortController().signal,
  });
  loop.agentHistory = history();
  await loop.run('LATEST_USER_REQUEST', [], {
    onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop,
    onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop,
    onError: (error) => events.errors.push(error), onDone: () => { events.done += 1; },
    onCancelled: noop, onCompacted: (event) => events.compacted.push(event),
  });
  return events;
}

test('the configured trigger point decides whether the same history compacts', async () => {
  const window = 48000;
  const early = await runWith(0.5, window);
  const late = await runWith(1, window);

  assert.deepEqual(early.errors, [], JSON.stringify(early.errors));
  assert.equal(early.done, 1);
  assert.equal(early.compacted.length, 1, '50% must compact this history');
  assert.ok(early.compacted[0].before > early.compacted[0].after, 'and it must shrink');

  assert.deepEqual(late.errors, [], JSON.stringify(late.errors));
  assert.equal(late.done, 1);
  assert.equal(late.compacted.length, 0,
    'the same history must not compact at 100%; otherwise the ratio is ignored');
});

test('a live loop picks up a changed trigger without being rebuilt', async () => {
  const window = 200000;
  const seen = [];
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 512,
    async *streamMessage(request) {
      if (isSummary(request)) { yield { type: 'textDelta', text: 'CHECKPOINT: summary' }; return; }
      yield { type: 'textDelta', text: 'ok' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const runtime = {
    initialize: async () => {}, beginTurn: noop, getBudget: () => ({ maxTurns: 4 }),
    recordInputTokens: noop, isParallelSafe: () => false,
    async execute() { return { success: true, output: 'ok' }; },
  };
  const loop = new AgentLoop({
    sessionId: 'compaction-live-ratio', workspaceDir: process.cwd(), memoryDir: process.cwd(), memoryEnabled: false,
    provider, toolRuntime: runtime, contextWindow: window, maxTokens: 512,
    compactionThresholdRatio: 0.8, getAbortSignal: () => new AbortController().signal,
  });
  const callbacks = {
    onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop,
    onToolCallComplete: noop, onToolResult: noop, onUsage: noop,
    onContext: (context) => seen.push(context.compactThreshold),
    onError: (error) => { throw new Error(error); }, onDone: noop, onCancelled: noop,
  };

  await loop.run('first', [], callbacks);
  assert.equal(seen.at(-1), 160000, '80% of the window');

  // The same loop, after the user saves 90%: the next request must use it.
  loop.setCompactionThresholdRatio(0.9);
  await loop.run('second', [], callbacks);
  assert.equal(seen.at(-1), 180000, '90% of the window, without rebuilding the loop');
});

test('a custom window and trigger point survive a real server round trip', async (t) => {  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-compaction-api-'));
  process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const token = backend.getServerCredentials(server).token;
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const call = async (method, body) => {
    const response = await fetch(endpoint + '/api/context-compaction', {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const initial = await call('GET');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.contextCompactionLimit, null, 'auto by default');
  assert.equal(initial.body.contextCompactionThreshold, null, '80% by default');

  const saved = await call('PUT', { contextCompactionLimit: 200000, contextCompactionThreshold: 0.5 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.contextCompactionLimit, 200000);
  assert.equal(saved.body.contextCompactionThreshold, 0.5);

  const readBack = await call('GET');
  assert.equal(readBack.body.contextCompactionLimit, 200000, 'the custom window persists');
  assert.equal(readBack.body.contextCompactionThreshold, 0.5, 'and so does the trigger point');

  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'workspace', '.iexa-settings.json'), 'utf8'));
  assert.equal(stored.contextCompactionLimit, 200000, 'it is on disk, not just in memory');
  assert.equal(stored.contextCompactionThreshold, 0.5);

  const tooSmall = await call('PUT', { contextCompactionLimit: 100000 });
  assert.equal(tooSmall.status, 400, 'below 128K is rejected, not silently clamped');
  assert.match(String(tooSmall.body.error || ''), /128000|128K/);

  const tooLow = await call('PUT', { contextCompactionThreshold: 0.4 });
  assert.equal(tooLow.status, 400, 'below 50% is rejected');

  const cleared = await call('PUT', { contextCompactionLimit: 'auto', contextCompactionThreshold: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.contextCompactionLimit, null, 'auto clears the ceiling');
  assert.equal(cleared.body.contextCompactionThreshold, null, 'and the default trigger returns');
});
