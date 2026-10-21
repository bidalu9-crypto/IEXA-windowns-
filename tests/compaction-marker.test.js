// A compaction must be visible: the loop reports it with real before/after token
// counts, and the recorder keeps it in the ordered transcript.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentLoop } = require('../dist/main/agent/AgentLoop');
const { TranscriptRecorder } = require('../dist/main/session/TranscriptRecorder');

const text = (role, value) => ({ role, parts: [{ type: 'text', text: value }] });
const user = value => text('user', value);
const noop = () => {};
function toolPair(id, size = 2000) {
  return [
    { role: 'assistant', parts: [{ type: 'toolUse', id, name: 'fixture', input: { path: `src/${id}.ts` } }] },
    { role: 'user', parts: [{ type: 'toolResult', id, name: 'fixture', content: `${id}: verified\n` + 'e'.repeat(size) }] },
  ];
}
function history(count = 60, size = 2000) {
  return [user('LATEST_USER_REQUEST: keep the exact constraints'), ...Array.from({ length: count }, (_, i) => toolPair(`call-${i}`, size)).flat()];
}
const isSummary = request => request.system === 'You are a precise context-compaction engine.';

function fixture(impl, options = {}) {
  const requests = [];
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 512,
    async *streamMessage(messages, system, tools, maxTokens, signal) {
      const request = { messages, system, tools, maxTokens, signal };
      requests.push(request);
      yield* impl(request);
    },
  };
  const controller = new AbortController();
  const events = { compacted: [], errors: [], done: 0 };
  const runtime = {
    initialize: async () => {}, beginTurn: noop, getBudget: () => ({ maxTurns: 4 }),
    recordInputTokens: noop, isParallelSafe: () => false,
    async execute() { return { success: true, output: 'ok' }; },
  };
  const loop = new AgentLoop({
    sessionId: 'compaction-marker', workspaceDir: process.cwd(), memoryDir: process.cwd(), memoryEnabled: false,
    provider, toolRuntime: runtime, contextWindow: options.window ?? 32000, maxTokens: 512,
    getAbortSignal: () => controller.signal,
  });
  const callbacks = {
    onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop,
    onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop,
    onError: error => events.errors.push(error), onDone: () => events.done++,
    onCancelled: noop, onCompacted: event => events.compacted.push(event),
  };
  return { loop, callbacks, events, requests };
}

test('a real checkpoint is reported once with shrinking token counts', async () => {
  const f = fixture(async function* (request) {
    if (isSummary(request)) { yield { type: 'textDelta', text: 'CHECKPOINT: older tool work summarised.' }; return; }
    yield { type: 'textDelta', text: 'done' };
    yield { type: 'done', stopReason: 'endTurn' };
  });
  f.loop.agentHistory = history();
  await f.loop.run('LATEST_USER_REQUEST', [], f.callbacks);

  assert.equal(f.events.errors.length, 0, f.events.errors.join(' | '));
  assert.equal(f.events.compacted.length, 1, 'exactly one marker per checkpoint');
  const [event] = f.events.compacted;
  assert.ok(Number.isSafeInteger(event.before) && event.before > 0, 'before is a token count');
  assert.ok(Number.isSafeInteger(event.after) && event.after > 0, 'after is a token count');
  assert.ok(event.after < event.before, `the checkpoint shrinks the prompt: ${event.before} → ${event.after}`);
});

test('a run below the threshold reports nothing', async () => {
  const f = fixture(async function* () {
    yield { type: 'textDelta', text: 'short answer' };
    yield { type: 'done', stopReason: 'endTurn' };
  });
  f.loop.agentHistory = [user('LATEST'), { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }];
  await f.loop.run('LATEST', [], f.callbacks);
  assert.equal(f.events.compacted.length, 0);
  assert.equal(f.requests.length, 1, 'no summary request was made');
});

test('the recorder keeps the marker in order between the tool work it folded', () => {
  const recorder = new TranscriptRecorder(() => 1000);
  recorder.recordText('before');
  recorder.recordTool('call-1', 'file_read');
  recorder.recordCompaction(128000, 24000);
  recorder.recordTool('call-2', 'file_edit');
  recorder.recordText('beforeafter');
  recorder.finish('completed');

  const snapshot = recorder.snapshot();
  const types = snapshot.items.map(item => item.type);
  assert.deepEqual(types, ['text', 'tool', 'compaction', 'tool', 'text']);
  const marker = snapshot.items[2];
  assert.equal(marker.before, 128000);
  assert.equal(marker.after, 24000);
  assert.equal(marker.id, `${snapshot.turnId}:3`);
  // The compaction boundary closes the open text range, so ranges stay valid.
  assert.equal(snapshot.valid, true);
});

test('the recorder refuses a marker after the turn settled', () => {
  const recorder = new TranscriptRecorder();
  recorder.finish('completed');
  recorder.recordCompaction(10, 5);
  assert.equal(recorder.snapshot().items.length, 0);
});
