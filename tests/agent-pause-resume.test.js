// Pause parks the turn at a safe boundary and resume continues from the exact
// step: completed tool results stay in history, the half-written model step is
// re-asked instead of being committed.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentLoop } = require('../dist/main/agent/AgentLoop');

const noop = () => {};

function makeLoop(provider, overrides = {}) {
  // A stable, never-aborted run signal: without one the tool runtime refuses
  // to execute, which would hide the very state the pause must preserve.
  const runSignal = new AbortController().signal;
  return new AgentLoop({
    sessionId: 'pause-fixture',
    workspaceDir: process.cwd(),
    memoryDir: process.cwd(),
    memoryEnabled: false,
    provider,
    toolRuntime: {
      initialize: async () => {},
      beginTurn: () => {},
      getBudget: () => ({ maxTurns: 8 }),
      recordInputTokens: noop,
      isParallelSafe: () => false,
      execute: async () => ({ success: true, output: 'TOOL_OUTPUT' }),
    },
    contextWindow: 200_000,
    maxTokens: 512,
    getAbortSignal: () => runSignal,
    ...overrides,
  });
}

function makeCallbacks(overrides = {}) {
  return {
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
    onPaused: noop,
    ...overrides,
  };
}

const textOf = (message) => (message.parts || [])
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('\n');
const toolResultsOf = (message) => (message.parts || []).filter((part) => part.type === 'toolResult');

test('a pause after a tool keeps its result and resume re-asks from that point', async () => {
  const requests = [];
  const executed = [];
  const paused = [];
  const provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 512,
    async *streamMessage(messages) {
      const index = requests.length;
      requests.push(JSON.parse(JSON.stringify(messages)));
      if (index === 0) {
        yield { type: 'toolCallComplete', id: 't1', name: 'grep', args: { pattern: 'x' } };
        yield { type: 'done', stopReason: 'toolUse' };
        return;
      }
      yield { type: 'textDelta', text: 'finished after resume' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  let loop;
  const done = [];
  loop = makeLoop(provider, {
    toolRuntime: {
      initialize: async () => {},
      beginTurn: () => {},
      getBudget: () => ({ maxTurns: 8 }),
      recordInputTokens: noop,
      isParallelSafe: () => false,
      execute: async (name) => { executed.push(name); return { success: true, output: 'TOOL_OUTPUT' }; },
    },
  });

  await loop.run('do the work', [], makeCallbacks({
    // The user presses stop while the tool result is landing: the tool has
    // already run, so its output must survive the pause.
    onToolResult: () => { assert.equal(loop.pause(), true); },
    onPaused: () => paused.push(Date.now()),
    onDone: (reason) => done.push(reason),
  }));

  assert.equal(paused.length, 1, 'the turn parked once');
  assert.equal(loop.isPaused(), true);
  assert.deepEqual(executed, ['grep'], 'the tool ran exactly once');
  assert.deepEqual(done, [], 'a paused turn is not finished');
  const historyAfterPause = requests.length;
  assert.equal(historyAfterPause, 1, 'no extra model call was made while paused');

  const resumedRequests = [];
  const resumedProvider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 512,
    async *streamMessage(messages) {
      resumedRequests.push(JSON.parse(JSON.stringify(messages)));
      yield { type: 'textDelta', text: 'finished after resume' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  loop.config.provider = resumedProvider;

  await loop.resume([], makeCallbacks({
    onDone: (reason) => done.push(reason),
  }));

  assert.equal(loop.isPaused(), false);
  assert.deepEqual(done, ['endTurn'], 'the resumed turn finished normally');
  assert.equal(resumedRequests.length, 1);
  const second = resumedRequests[0];
  const last = second[second.length - 1];
  assert.equal(last.role, 'user', 'the request resumes on the tool results');
  assert.equal(toolResultsOf(last).length, 1, 'the completed tool result is carried forward');
  assert.equal(toolResultsOf(last)[0].content, 'TOOL_OUTPUT');
  assert.ok(second.some((message) => message.role === 'assistant'
    && (message.parts || []).some((part) => part.type === 'toolUse' && part.id === 't1')),
  'the tool call the result belongs to is still in history');
});

test('pausing mid-stream discards the half-written step instead of committing it', async () => {
  const requests = [];
  const paused = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 512,
    async *streamMessage(messages) {
      const index = requests.length;
      requests.push(JSON.parse(JSON.stringify(messages)));
      if (index === 0) {
        yield { type: 'textDelta', text: 'half a sentence' };
        await gate;
        yield { type: 'textDelta', text: ' and the rest' };
        yield { type: 'done', stopReason: 'endTurn' };
        return;
      }
      yield { type: 'textDelta', text: 'clean answer' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  let loop;
  loop = makeLoop(provider);
  const runPromise = loop.run('question', [], makeCallbacks({
    onTextDelta: (text) => { if (text === 'half a sentence') { loop.pause(); release(); } },
    onPaused: () => paused.push(true),
  }));
  await runPromise;

  assert.equal(paused.length, 1);
  const last = requests[0][requests[0].length - 1];
  assert.equal(textOf(last), 'question');

  const resumed = [];
  loop.config.provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 512,
    async *streamMessage(messages) {
      resumed.push(JSON.parse(JSON.stringify(messages)));
      yield { type: 'textDelta', text: 'clean answer' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  await loop.resume([], makeCallbacks({}));

  const history = resumed[0];
  const partial = history.filter((message) => message.role === 'assistant'
    && textOf(message).includes('half a sentence'));
  assert.equal(partial.length, 0, 'the interrupted text is not treated as a finished answer');
  assert.equal(textOf(history[history.length - 1]), 'question', 'the model is re-asked from the same request');
});

test('a paused turn that is cancelled settles as cancelled, not paused', async () => {
  const provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 512,
    async *streamMessage() {
      yield { type: 'toolCallComplete', id: 't1', name: 'grep', args: {} };
      yield { type: 'done', stopReason: 'toolUse' };
    },
  };
  let loop;
  loop = makeLoop(provider);
  const cancelled = [];
  await loop.run('work', [], makeCallbacks({
    onToolResult: () => { loop.pause(); },
    onPaused: () => { loop.cancel(); },
    onCancelled: () => cancelled.push(true),
  }));
  assert.equal(loop.isPaused(), true, 'the loop is parked');
  assert.equal(loop.isCancelledNow(), true, 'the cancel flag survives the pause');
  assert.equal(cancelled.length, 0, 'cancellation is reported by the runtime, not by the parked loop');
});
