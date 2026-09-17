const test = require('node:test');
const assert = require('node:assert/strict');
const { ContextCompactor, compactThresholdForWindow, estimateMessageTokens, estimateRequestTokens } = require('../dist/main/agent/ContextCompactor');
const { ContextManager } = require('../dist/main/context/ContextManager');
const { AgentLoop } = require('../dist/main/agent/AgentLoop');

const text = (role, value) => ({ role, parts: [{ type: 'text', text: value }] });
const user = value => text('user', value);
const assistant = value => text('assistant', value);
const noop = () => {};
const allText = messages => messages.flatMap(message => message.parts).filter(part => part.type === 'text').map(part => part.text).join('\n');
function toolPair(id, size = 2000) {
  return [
    { role: 'assistant', parts: [{ type: 'toolUse', id, name: 'fixture', input: { path: `src/${id}.ts` } }] },
    { role: 'user', parts: [{ type: 'toolResult', id, name: 'fixture', content: `${id}: verified\n` + 'e'.repeat(size) }] },
  ];
}
function history(count = 15, size = 2000) {
  return [user('LATEST_USER_REQUEST: fix src/main.ts; preserve exact constraints'), ...Array.from({ length: count }, (_, i) => toolPair(`call-${i}`, size)).flat()];
}
function paired(messages) {
  const calls = new Set();
  for (const message of messages) for (const part of message.parts) {
    if (part.type === 'toolUse') { assert.ok(!calls.has(part.id), 'duplicate call'); calls.add(part.id); }
    if (part.type === 'toolResult') { assert.ok(calls.delete(part.id), `orphan result ${part.id}`); }
  }
  assert.equal(calls.size, 0, 'unresolved calls');
}
function providerWith(impl) {
  const requests = [];
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 512,
    async *streamMessage(messages, system, tools, maxTokens, signal) {
      const request = { messages, system, tools, maxTokens, signal };
      requests.push(request);
      if (impl) yield* impl(request, requests.length);
      else { yield { type: 'textDelta', text: 'Checkpoint: old tools completed; continue the latest request.' }; yield { type: 'done', stopReason: 'endTurn' }; }
    },
  };
  return { provider, requests };
}
function compactor(impl, window = 4000, options) {
  const fake = providerWith(impl);
  return { ...fake, compactor: new ContextCompactor(fake.provider, window, [], '', 512, options) };
}

// All fixtures are local providers; no live model or credentials are involved.
test('compaction threshold reserves actual output and counts system/tools/reasoning', async () => {
  assert.equal(compactThresholdForWindow(1000), 800);
  assert.equal(compactThresholdForWindow(1000, 700), 300);
  const tools = [{ name: 'fixture', description: 'd'.repeat(2000), parameters: {}, required: [] }];
  const f = providerWith();
  const c = new ContextCompactor(f.provider, 4000, tools, 's'.repeat(1000), 512);
  const messages = [user('old'), { ...assistant('answer'), reasoningContent: 'r'.repeat(15000) }, user('LATEST')];
  assert.ok(c.status(messages).usedTokens >= estimateRequestTokens(messages, 's'.repeat(1000), tools));
  const result = await c.compactIfNeeded(messages, noop);
  assert.equal(f.requests.length, 1);
  assert.ok(estimateRequestTokens(result, 's'.repeat(1000), tools) < 3200);
  assert.match(allText(result), /LATEST/);
});

test('below threshold is identity; exact threshold triggers compaction', async () => {
  const f = compactor();
  const messages = [user('old'), assistant('a'.repeat(800)), user('latest')];
  assert.equal(await f.compactor.compactIfNeeded(messages, noop), messages);
  assert.equal(f.requests.length, 0);
  f.compactor.recordProviderUsage(3200, messages);
  const result = await f.compactor.compactIfNeeded(messages, noop);
  assert.notEqual(result, messages);
  assert.equal(f.requests.length, 1);
});

test('provider receipt includes new history growth and checkpoint usage never contaminates it', async () => {
  const f = compactor(async function* () {
    yield { type: 'usage', usage: { inputTokens: 900000, outputTokens: 1 } };
    yield { type: 'textDelta', text: 'A short checkpoint.' };
  });
  const messages = [user('old'), assistant('a'.repeat(800)), user('latest')];
  f.compactor.recordProviderUsage(3100, messages);
  assert.equal(f.compactor.status(messages).estimated, false);
  const extended = [...messages, assistant('b'.repeat(800))];
  assert.ok(f.compactor.status(extended).usedTokens > 3200);
  const result = await f.compactor.compactIfNeeded(extended, noop);
  assert.ok(f.compactor.status(result).usedTokens < 3200);
  assert.equal(f.compactor.status(result).usedTokens, estimateMessageTokens(result));
});

test('single-user long-running tools compact and preserve latest request, image and last pair', async () => {
  const f = compactor();
  const messages = history();
  messages[0].parts.push({ type: 'imageData', mimeType: 'image/png', data: Buffer.from('pixels') });
  const original = JSON.stringify(messages);
  const result = await f.compactor.compactIfNeeded(messages, noop);
  assert.equal(JSON.stringify(messages), original, 'caller history is immutable');
  assert.notEqual(result, messages);
  assert.deepEqual(result[0].parts.slice(1), messages[0].parts);
  assert.deepEqual(result.slice(-2), messages.slice(-2));
  assert.equal(allText(result).split('LATEST_USER_REQUEST').length - 1, 1);
  assert.ok(estimateMessageTokens(result) < 3200);
  paired(result);
});

test('multi-call batches, interleaved result messages and text beside results remain paired', async () => {
  const messages = history();
  messages.push({ role: 'assistant', parts: [
    { type: 'toolUse', id: 'a', name: 'fixture', input: {} },
    { type: 'toolUse', id: 'b', name: 'fixture', input: {} },
  ] });
  messages.push({ role: 'user', parts: [{ type: 'toolResult', id: 'a', name: 'fixture', content: 'a'.repeat(1500) }, { type: 'text', text: 'tool metadata, not user intent' }] });
  messages.push({ role: 'user', parts: [{ type: 'toolResult', id: 'b', name: 'fixture', content: 'b'.repeat(1500) }] });
  const result = await compactor().compactor.compactIfNeeded(messages, noop);
  paired(result);
  assert.deepEqual(result.slice(-3), messages.slice(-3));
  assert.match(allText(result), /LATEST_USER_REQUEST/);
});

test('newest user request and image-only request survive even with a short history', async () => {
  for (const latest of [user('latest exact request'), { role: 'user', parts: [{ type: 'imageData', data: Buffer.from('pixels'), mimeType: 'image/png' }] }]) {
    const messages = [user('old '.repeat(5000)), latest];
    const result = await compactor().compactor.compactIfNeeded(messages, noop);
    assert.deepEqual(result[0].parts.slice(1), latest.parts);
    assert.ok(estimateMessageTokens(result) < estimateMessageTokens(messages));
  }
});

test('summary prompt/output are bounded for huge histories; tools and pixels are not sent', async () => {
  const f = compactor();
  const messages = [user('old intent'), assistant('HUGE_HEAD ' + 'x'.repeat(500000) + ' HUGE_TAIL'), ...history()];
  messages[0].parts.push({ type: 'imageData', mimeType: 'image/png', data: Buffer.from('BINARY_SECRET') });
  const result = await f.compactor.compactIfNeeded(messages, noop);
  const request = f.requests[0];
  assert.ok(estimateRequestTokens(request.messages, request.system, request.tools) + request.maxTokens < 4000);
  assert.ok(allText(request.messages).length < 8400);
  assert.ok(!allText(request.messages).includes('BINARY_SECRET'));
  assert.deepEqual(request.tools, []);
  assert.ok(request.maxTokens <= 512);
  assert.ok(estimateMessageTokens(result) < 3200);
});

for (const mode of ['empty', 'throw', 'partial-error', 'oversized', 'truncated', 'tool-call']) {
  test(`summary ${mode} uses one bounded extractive fallback without losing the live tail`, async () => {
    const f = compactor(async function* () {
      if (mode === 'empty') return;
      if (mode === 'throw') throw new Error('503 fixture');
      if (mode === 'partial-error') { yield { type: 'textDelta', text: 'UNCOMMITTED_PARTIAL' }; throw new Error('stream interrupted'); }
      if (mode === 'oversized') yield { type: 'textDelta', text: 'x'.repeat(50000) };
      if (mode === 'truncated') { yield { type: 'textDelta', text: 'UNCOMMITTED_PARTIAL' }; yield { type: 'done', stopReason: 'maxTokens' }; }
      if (mode === 'tool-call') yield { type: 'toolCallComplete', id: 'oops', name: 'fixture', args: {} };
    });
    const statuses = [];
    const messages = history();
    const result = await f.compactor.compactIfNeeded(messages, s => statuses.push(s));
    assert.equal(f.requests.length, 1);
    assert.match(f.compactor.getSummary(), /Extractive checkpoint/);
    assert.ok(!f.compactor.getSummary().includes('UNCOMMITTED_PARTIAL'));
    assert.deepEqual(result[0].parts.slice(1), messages[0].parts);
    assert.equal(statuses.at(-1).state, 'compacted');
    assert.ok(statuses.at(-1).usedTokens < statuses.at(-1).compactThreshold);
    paired(result);
  });
}

test('stalled summary times out even when provider ignores abort and return', { timeout: 2000 }, async () => {
  const f = compactor(async function* () { await new Promise(() => {}); }, 4000, { summaryTimeoutMs: 15 });
  const result = await f.compactor.compactIfNeeded(history(), noop);
  assert.match(f.compactor.getSummary(), /Extractive checkpoint/);
  assert.ok(f.requests[0].signal.aborted);
  paired(result);
});

test('cancellation of stalled or partial summaries rejects promptly and commits nothing', { timeout: 2000 }, async () => {
  for (const partial of [false, true]) {
    const controller = new AbortController();
    const f = compactor(async function* () {
      if (partial) yield { type: 'textDelta', text: 'uncommitted summary' };
      setImmediate(() => controller.abort(new Error('fixture cancelled')));
      await new Promise(() => {});
    });
    f.compactor.setSummary('durable previous summary');
    const messages = history();
    const before = JSON.stringify(messages);
    const states = [];
    await assert.rejects(f.compactor.compactIfNeeded(messages, s => states.push(s.state), controller.signal), /fixture cancelled/);
    assert.equal(f.compactor.getSummary(), 'durable previous summary');
    assert.equal(JSON.stringify(messages), before);
    assert.ok(!states.includes('compacted'));
    assert.equal(f.requests[0].signal.aborted, true);
  }
});

test('already cancelled and cancellation during pressure callback never call provider', async () => {
  for (const beforehand of [true, false]) {
    const controller = new AbortController();
    const f = compactor();
    if (beforehand) controller.abort();
    await assert.rejects(f.compactor.compactIfNeeded(history(), () => controller.abort(), controller.signal));
    assert.equal(f.requests.length, 0);
  }
});

test('unshrinkable latest user or live transaction reports exhaustion without mutation or requests', async () => {
  for (const messages of [[user('u'.repeat(50000))], [user('request'), ...toolPair('huge-live', 50000)]]) {
    const f = compactor();
    const states = [];
    const before = JSON.stringify(messages);
    await assert.rejects(f.compactor.compactIfNeeded(messages, s => states.push(s.state)), /Context exhausted/);
    assert.equal(states.at(-1), 'exhausted');
    assert.equal(JSON.stringify(messages), before);
    assert.equal(f.requests.length, 0);
  }
});

test('repeated compactions replace checkpoints rather than nesting or duplicating them', async () => {
  const f = compactor();
  f.compactor.setSummary('RESTORED_PRIOR_SUMMARY');
  const first = await f.compactor.compactIfNeeded(history(), noop);
  assert.match(allText(f.requests[0].messages), /RESTORED_PRIOR_SUMMARY/);
  const next = [...first, ...history().slice(1)];
  const second = await f.compactor.compactIfNeeded(next, noop);
  assert.equal(allText(second).split('<context-summary>').length - 1, 1);
  assert.equal(allText(second).split('LATEST_USER_REQUEST').length - 1, 1);
  paired(second);
  assert.equal(await f.compactor.compactIfNeeded(second, noop), second);
  assert.equal(f.requests.length, 2);
});

test('ContextManager recovery forces compaction below threshold and forwards abort', async () => {
  const f = providerWith();
  const manager = new ContextManager(f.provider, 4000, [], '', 512);
  const messages = [user('old'), assistant('a'.repeat(2000)), user('latest')];
  assert.equal(await manager.compact(messages, noop), messages);
  const result = await manager.recover(messages, noop);
  assert.notEqual(result, messages);
  assert.ok(manager.summary());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(manager.recover(messages, noop, controller.signal));
});

function loopFixture(impl, options = {}) {
  const f = providerWith(impl);
  const controller = new AbortController();
  const events = { errors: [], done: 0, cancelled: 0, states: [], retries: [], turns: 0, tools: 0, text: '' };
  const runtime = {
    initialize: async () => {}, beginTurn: () => events.turns++, getBudget: () => ({ maxTurns: options.maxTurns ?? 5 }),
    recordInputTokens: noop, isParallelSafe: () => false,
    async execute() { events.tools++; return { success: true, output: 'tool verified' }; },
  };
  const loop = new AgentLoop({
    sessionId: 'compaction-regression', workspaceDir: process.cwd(), memoryDir: process.cwd(), memoryEnabled: false,
    provider: f.provider, toolRuntime: runtime, contextWindow: options.window ?? 32000, maxTokens: 512,
    getAbortSignal: () => controller.signal,
  });
  const callbacks = {
    onTextDelta: (_, full) => { events.text = full; }, onThinkingDelta: noop, onToolCallStart: noop,
    onToolInputDelta: noop, onToolCallComplete: noop, onToolResult: noop, onUsage: noop,
    onContext: status => events.states.push(status), onError: error => events.errors.push(error),
    onDone: () => events.done++, onCancelled: () => events.cancelled++, onRetry: (...args) => events.retries.push(args),
  };
  return { ...f, loop, events, callbacks, controller };
}
const isSummary = request => request.system === 'You are a precise context-compaction engine.';

test('agent compacts, executes tools, then continues to the final answer in the same run', async () => {
  let normalRequests = 0;
  const f = loopFixture(async function* (request) {
    if (isSummary(request)) { yield { type: 'textDelta', text: 'CHECKPOINT_V1: historical evidence retained.' }; return; }
    normalRequests++;
    assert.match(allText(request.messages), /CHECKPOINT_V1/);
    assert.match(allText(request.messages), /LATEST_NEW_REQUEST/);
    paired(request.messages);
    if (normalRequests === 1) yield { type: 'toolCallComplete', id: 'new-tool', name: 'fixture', args: {} };
    else { assert.ok(request.messages.at(-1).parts.some(p => p.type === 'toolResult' && p.id === 'new-tool')); yield { type: 'textDelta', text: 'Finished after compaction.' }; }
    yield { type: 'done', stopReason: normalRequests === 1 ? 'toolUse' : 'endTurn' };
  });
  f.loop.agentHistory = history(60, 2000);
  await f.loop.run('LATEST_NEW_REQUEST', [], f.callbacks);
  assert.deepEqual(f.events.errors, []);
  assert.equal(f.events.done, 1);
  assert.equal(f.events.tools, 1);
  assert.equal(normalRequests, 2);
  assert.equal(f.events.text, 'Finished after compaction.');
  assert.ok(f.events.states.some(s => s.state === 'compacted'));
  assert.equal(f.loop.getCompactorSummary(), 'CHECKPOINT_V1: historical evidence retained.');
});

test('agent uses fallback after summary failure and still answers (no retry storm)', async () => {
  const f = loopFixture(async function* (request) {
    if (isSummary(request)) throw new Error('summary gateway unavailable');
    assert.match(allText(request.messages), /Extractive checkpoint/);
    yield { type: 'textDelta', text: 'continued' };
    yield { type: 'done', stopReason: 'endTurn' };
  });
  f.loop.agentHistory = history(60);
  await f.loop.run('continue', [], f.callbacks);
  assert.equal(f.events.done, 1);
  assert.deepEqual(f.events.errors, []);
  assert.equal(f.requests.length, 2);
  assert.equal(f.events.retries.length, 0);
});

for (const how of ['cancel', 'external']) test(`agent ${how} aborts an in-flight summary with exactly one cancellation`, { timeout: 2000 }, async () => {
  const f = loopFixture(async function* (request) {
    assert.ok(isSummary(request), 'no normal model request after cancellation');
    setImmediate(() => how === 'cancel' ? f.loop.cancel() : f.controller.abort());
    await new Promise(() => {});
  });
  f.loop.setCompactorSummary('PERSISTED');
  f.loop.agentHistory = history(60);
  await f.loop.run('continue', [], f.callbacks);
  assert.equal(f.events.cancelled, 1);
  assert.equal(f.events.done, 0);
  assert.deepEqual(f.events.errors, []);
  assert.equal(f.loop.getCompactorSummary(), 'PERSISTED');
  assert.equal(f.requests.length, 1);
});

test('restored checkpoint is visible once, survives later runs, and reset clears it', async () => {
  const f = loopFixture(async function* (request) {
    assert.equal(allText(request.messages).split('PERSISTED_CHECKPOINT').length - 1, 1);
    yield { type: 'textDelta', text: 'answer' }; yield { type: 'done', stopReason: 'endTurn' };
  });
  f.loop.setCompactorSummary('PERSISTED_CHECKPOINT');
  assert.equal(f.loop.getCompactorSummary(), 'PERSISTED_CHECKPOINT');
  await f.loop.run('first exact request', [], f.callbacks);
  assert.ok(f.requests[0].messages.at(-1).parts.some(p => p.type === 'text' && p.text === 'first exact request'));
  await f.loop.run('second exact request', [], f.callbacks);
  assert.equal(f.loop.getCompactorSummary(), 'PERSISTED_CHECKPOINT');
  assert.equal(f.events.done, 2);
  assert.deepEqual(f.events.errors, []);
  f.loop.reset();
  assert.equal(f.loop.getCompactorSummary(), '');
  assert.equal(f.loop.getHistoryLength(), 0);
});

test('newly generated checkpoint, rather than stale restored one, survives subsequent runs', async () => {
  const f = loopFixture(async function* (request) {
    if (isSummary(request)) { yield { type: 'textDelta', text: 'NEW_CHECKPOINT' }; return; }
    assert.match(allText(request.messages), /NEW_CHECKPOINT/);
    assert.ok(!allText(request.messages).includes('STALE_CHECKPOINT'));
    yield { type: 'done', stopReason: 'endTurn' };
  });
  f.loop.setCompactorSummary('STALE_CHECKPOINT');
  f.loop.agentHistory = history(60);
  await f.loop.run('first', [], f.callbacks);
  await f.loop.run('second', [], f.callbacks);
  assert.equal(f.loop.getCompactorSummary(), 'NEW_CHECKPOINT');
  assert.equal(f.events.done, 2);
  assert.deepEqual(f.events.errors, []);
});

test('provider-confirmed overflow compacts once and retries without spending another tool turn', async () => {
  let normal = 0;
  const f = loopFixture(async function* (request) {
    if (isSummary(request)) { yield { type: 'textDelta', text: 'OVERFLOW_CHECKPOINT' }; return; }
    if (++normal === 1) throw new Error('context window exceeded');
    assert.match(allText(request.messages), /OVERFLOW_CHECKPOINT/);
    yield { type: 'textDelta', text: 'recovered' }; yield { type: 'done', stopReason: 'endTurn' };
  }, { maxTurns: 1 });
  f.loop.agentHistory = history(4);
  await f.loop.run('recover latest', [], f.callbacks);
  assert.equal(f.events.done, 1);
  assert.equal(normal, 2);
  assert.equal(f.events.turns, 1);
  assert.equal(f.events.retries.length, 1);
  assert.deepEqual(f.events.errors, []);
});

test('repeated overflow is bounded to one recovery and reports an error', async () => {
  const f = loopFixture(async function* (request) {
    if (isSummary(request)) { yield { type: 'textDelta', text: 'checkpoint' }; return; }
    throw new Error('context window exceeded');
  });
  f.loop.agentHistory = history(4);
  await f.loop.run('latest', [], f.callbacks);
  assert.equal(f.requests.filter(isSummary).length, 1);
  assert.equal(f.requests.filter(r => !isSummary(r)).length, 2);
  assert.equal(f.events.errors.length, 1);
  assert.equal(f.events.done, 0);
});

test('summary input bound is conservative for CJK, emoji and a large restored checkpoint', async () => {
  const f = compactor();
  f.compactor.setSummary('已完成约束🧪'.repeat(3000));
  const messages = [user('历史请求🧪'.repeat(3000)), assistant('历史结果🧪'.repeat(3000)), ...history()];
  await f.compactor.compactIfNeeded(messages, noop);
  const request = f.requests[0];
  const bytes = Buffer.byteLength(allText(request.messages)) + Buffer.byteLength(request.system);
  assert.ok(bytes + request.maxTokens + 32 < 4000, `summary envelope too large: ${bytes}`);
});

test('live unresolved tool call stays verbatim while completed older pairs compact', async () => {
  const messages = [...history(), { role: 'assistant', parts: [{ type: 'toolUse', id: 'pending', name: 'fixture', input: { path: 'keep.ts' } }] }];
  const result = await compactor().compactor.compactIfNeeded(messages, noop);
  assert.deepEqual(result.at(-1), messages.at(-1));
  paired(result.slice(0, -1));
  assert.match(allText(result), /LATEST_USER_REQUEST/);
});

test('system/tool envelope that leaves no room is exhausted before summary provider work', async () => {
  const f = providerWith();
  const c = new ContextCompactor(f.provider, 4000, [], 's'.repeat(20000), 512);
  const states = [];
  await assert.rejects(c.compactIfNeeded(history(), s => states.push(s.state)), /Context exhausted/);
  assert.equal(states.at(-1), 'exhausted');
  assert.equal(f.requests.length, 0);
});

test('agent triggers compaction after receipt plus a completed tool transaction grows past threshold', async () => {
  let normal = 0;
  const f = loopFixture(async function* (request) {
    if (isSummary(request)) { yield { type: 'textDelta', text: 'MID_RUN_CHECKPOINT' }; return; }
    if (++normal === 1) {
      assert.ok(!allText(request.messages).includes('<context-summary>'));
      yield { type: 'toolCallComplete', id: 'crossing-tool', name: 'fixture', args: {} };
      yield { type: 'usage', usage: { inputTokens: 25599, outputTokens: 10 } };
      yield { type: 'done', stopReason: 'toolUse' };
    } else {
      assert.match(allText(request.messages), /MID_RUN_CHECKPOINT/);
      assert.match(allText(request.messages), /latest exact request/);
      assert.ok(request.messages.at(-1).parts.some(p => p.type === 'toolResult' && p.id === 'crossing-tool'));
      paired(request.messages);
      yield { type: 'textDelta', text: 'continued after mid-run compaction' };
      yield { type: 'done', stopReason: 'endTurn' };
    }
  });
  f.loop.agentHistory = history(4);
  await f.loop.run('latest exact request', [], f.callbacks);
  assert.equal(normal, 2);
  assert.equal(f.requests.filter(isSummary).length, 1);
  assert.equal(f.events.tools, 1);
  assert.equal(f.events.done, 1);
  assert.deepEqual(f.events.errors, []);
});

test('cancellation during overflow recovery is terminal and never retries the agent', { timeout: 2000 }, async () => {
  const f = loopFixture(async function* (request) {
    if (!isSummary(request)) throw new Error('context window exceeded');
    setImmediate(() => f.loop.cancel());
    await new Promise(() => {});
  });
  f.loop.agentHistory = history(4);
  await f.loop.run('latest', [], f.callbacks);
  assert.equal(f.events.cancelled, 1);
  assert.equal(f.events.retries.length, 0);
  assert.equal(f.events.done, 0);
  assert.deepEqual(f.events.errors, []);
  assert.equal(f.requests.length, 2);
});

test('oversized restored checkpoint compacts even when the latest user is the only message', async () => {
  const f = loopFixture(async function* (request) {
    if (isSummary(request)) {
      assert.match(allText(request.messages), /RESTORED_LARGE_CHECKPOINT/);
      yield { type: 'textDelta', text: 'BOUNDED_RESTORED_CHECKPOINT' };
      return;
    }
    assert.match(allText(request.messages), /BOUNDED_RESTORED_CHECKPOINT/);
    assert.ok(request.messages[0].parts.some(p => p.type === 'text' && p.text === 'latest exact request'));
    yield { type: 'done', stopReason: 'endTurn' };
  });
  f.loop.setCompactorSummary('RESTORED_LARGE_CHECKPOINT ' + 's'.repeat(150000));
  await f.loop.run('latest exact request', [], f.callbacks);
  assert.deepEqual(f.events.errors, []);
  assert.equal(f.events.done, 1);
  assert.equal(f.loop.getCompactorSummary(), 'BOUNDED_RESTORED_CHECKPOINT');
  assert.equal(f.requests.length, 2);
});

test('fresh compactor recovers embedded checkpoint content rather than silently dropping it', async () => {
  const messages = history();
  messages[0].parts.unshift({ type: 'text', text: '<context-summary>\nEMBEDDED_DURABLE_STATE\n</context-summary>\n\nRetained recent context:' });
  const f = compactor(async function* (request) {
    assert.match(allText(request.messages), /EMBEDDED_DURABLE_STATE/);
    yield { type: 'textDelta', text: 'new summary of embedded durable state' };
  });
  const result = await f.compactor.compactIfNeeded(messages, noop);
  assert.equal(allText(result).split('<context-summary>').length - 1, 1);
  paired(result);
});
