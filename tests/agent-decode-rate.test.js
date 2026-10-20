// The streaming rate must divide output tokens by decode time only. Prompt
// prefill (the wait before the first token) belongs to the input, not output.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentLoop, STREAM_RATE_VERSION } = require('../dist/main/agent/AgentLoop');

const noop = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeLoop(provider) {
  return new AgentLoop({
    sessionId: 'rate-fixture',
    workspaceDir: process.cwd(),
    memoryDir: process.cwd(),
    memoryEnabled: false,
    provider,
    toolRuntime: {
      initialize: async () => {},
      beginTurn: () => {},
      getBudget: () => ({ maxTurns: 4 }),
      recordInputTokens: noop,
      execute: async () => ({ success: true, output: '' }),
    },
    contextWindow: 200_000,
    maxTokens: 256,
    getAbortSignal: () => undefined,
  });
}

const callbacks = {
  onTextDelta: noop,
  onThinkingDelta: noop,
  onToolCallStart: noop,
  onToolInputDelta: noop,
  onToolCallComplete: noop,
  onToolResult: noop,
  onUsage: noop,
  onContext: noop,
  onError: (error) => { throw new Error(error); },
  onDone: noop,
  onCancelled: noop,
};

test('prefill wait is reported separately from decode time', async () => {
  const PREFILL_MS = 1200;
  const DELTAS = 10;
  const GAP_MS = 20;
  const provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 256,
    async *streamMessage() {
      await sleep(PREFILL_MS);
      for (let index = 0; index < DELTAS; index++) {
        yield { type: 'textDelta', text: 'x' };
        await sleep(GAP_MS);
      }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: DELTAS } };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };

  const loop = makeLoop(provider);
  await loop.run('measure the rate', [], callbacks);

  const prefill = loop.getTimeToFirstTokenMs();
  const decode = loop.getGenerationMs();
  assert.ok(prefill >= PREFILL_MS - 50, 'the prefill wait is recorded: ' + prefill);
  assert.ok(decode >= DELTAS * GAP_MS - 30, 'the whole decode window is counted: ' + decode);
  assert.ok(decode < 800, 'prefill must not leak into decode time: ' + decode);
  assert.ok(decode < prefill, 'decode stays below the prefill wait for this fixture');

  const rate = DELTAS / (decode / 1000);
  assert.ok(rate > 12, 'the fixture decodes faster than 12 tok/s, got ' + rate.toFixed(1));
  assert.equal(STREAM_RATE_VERSION, 2);
});

test('a stream that never emits a token contributes no decode time', async () => {
  const provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 256,
    async *streamMessage() {
      await sleep(300);
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const loop = makeLoop(provider);
  await loop.run('empty answer', [], callbacks);
  assert.equal(loop.getGenerationMs(), 0);
  assert.equal(loop.getTimeToFirstTokenMs(), 0);
});
