// Codex-style steer: a follow-up must enter the turn that is already running,
// at a protocol-valid boundary, without discarding completed work.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentLoop } = require('../dist/main/agent/AgentLoop');

const noop = () => {};

function makeLoop(provider, overrides = {}) {
  return new AgentLoop({
    sessionId: 'steer-fixture',
    workspaceDir: process.cwd(),
    memoryDir: process.cwd(),
    memoryEnabled: false,
    provider,
    toolRuntime: {
      initialize: async () => {},
      beginTurn: () => {},
      getBudget: () => ({ maxTurns: 8 }),
      recordInputTokens: noop,
      execute: async () => ({ success: true, output: '' }),
    },
    contextWindow: 200_000,
    maxTokens: 512,
    getAbortSignal: () => undefined,
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
    ...overrides,
  };
}

/** Provider that records every request and answers with plain text. */
function scriptedProvider(onFirstDelta) {
  const requests = [];
  const provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 512,
    async *streamMessage(messages) {
      const callIndex = requests.length;
      requests.push(messages);
      if (callIndex === 0) {
        if (onFirstDelta) onFirstDelta();
        yield { type: 'textDelta', text: 'first answer' };
        yield { type: 'done', stopReason: 'endTurn' };
        return;
      }
      yield { type: 'textDelta', text: 'second answer' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  return { provider, requests };
}

const textOf = (message) => (message.parts || [])
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('\n');

test('a steer arriving mid-completion is answered by the same turn', async () => {
  const applied = [];
  const done = [];
  let loop;
  const { provider, requests } = scriptedProvider(() => {
    // Exactly the user action: type while the first completion streams.
    const accepted = loop.steer({ id: 'steer-1', text: 'STEER_MARK change direction' });
    assert.equal(accepted, true, 'a live turn must accept the steer');
  });
  loop = makeLoop(provider);

  await loop.run('original request', [], makeCallbacks({
    onSteerApplied: (event) => applied.push(event),
    onDone: (reason) => done.push(reason),
  }));

  assert.deepEqual(applied.map((event) => event.id), ['steer-1']);
  assert.deepEqual(done, ['endTurn'], 'the turn must finish once, after answering the steer');
  assert.equal(requests.length, 2, 'the steer must trigger exactly one more model step');

  const second = requests[1];
  const last = second[second.length - 1];
  assert.equal(last.role, 'user');
  assert.match(textOf(last), /STEER_MARK/);
  assert.equal(loop.getHistoryLength(), 4, 'history must be user → assistant → steer → assistant');
});

test('steer attachments travel as protocol-valid user text', async () => {
  let loop;
  const { provider, requests } = scriptedProvider(() => {
    loop.steer({
      id: 'steer-file',
      text: 'use this file',
      attachments: [{ name: 'notes.txt', mime: 'text/plain', kind: 'text', text: 'FILE_BODY' }],
    });
  });
  loop = makeLoop(provider);

  await loop.run('original', [], makeCallbacks());

  const second = requests[1];
  const lastText = textOf(second[second.length - 1]);
  assert.match(lastText, /use this file/);
  assert.match(lastText, /Attached file: notes\.txt/);
  assert.match(lastText, /FILE_BODY/);
});

test('a steer that never finds a boundary is reported, not silently dropped', async () => {
  const dropped = [];
  const { provider } = scriptedProvider();
  const loop = makeLoop(provider);

  await loop.run('original', [], makeCallbacks({
    onSteerDropped: (event) => dropped.push(event),
  }));

  // The turn is over; the runtime has not settled it yet in this direct-loop
  // fixture, so the loop still accepts a late message.
  assert.equal(loop.steer({ id: 'late', text: 'too late' }), true);
  loop.endRun();

  assert.deepEqual(dropped, [{ id: 'late', reason: 'turn_ended' }]);
  assert.equal(loop.steer({ id: 'after', text: 'after teardown' }), false, 'a settled run accepts nothing');
});
