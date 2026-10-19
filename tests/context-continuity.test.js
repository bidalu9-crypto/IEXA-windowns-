// A reopened conversation must continue its context, not restart it.
//
// The request size used to live only in the running compactor: after a restart
// the meter fell back to the rehydrated working set, and the rehydrated working
// set itself was a fixed 24K slice. Both halves of that are pinned here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ContextCompactor,
  compactThresholdForWindow,
  rehydrateBudgetForWindow,
  estimateMessageTokens,
  MIN_REHYDRATED_TOKENS,
} = require('../dist/main/agent/ContextCompactor');
const { AgentLoop } = require('../dist/main/agent/AgentLoop');
const {
  contextUsageStatus,
  normalizeContextUsage,
  readContextUsage,
  shouldPersistContextUsage,
  writeContextUsage,
} = require('../dist/main/session/ContextUsageStore');

const text = (role, value) => ({ role, parts: [{ type: 'text', text: value }] });
const user = (value) => text('user', value);
const assistant = (value) => text('assistant', value);
const noop = () => {};

/** Provider stub: answers the summary prompt with one short checkpoint. */
function summaryProvider() {
  const requests = [];
  const provider = {
    name: 'fixture',
    model: 'fixture',
    defaultMaxTokens: 512,
    async *streamMessage(messages, system, tools, maxTokens, signal) {
      requests.push({ messages, system, tools, maxTokens, signal });
      yield { type: 'textDelta', text: 'CHECKPOINT: earlier work retained.' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  return { provider, requests };
}

test('a restored size is carried forward instead of re-estimated from zero', () => {
  const { provider } = summaryProvider();
  const compactor = new ContextCompactor(provider, 1_000_000, [], '', 0);
  compactor.restoreUsage(242_000);

  const history = [user('carry on')];
  const first = compactor.status(history);
  assert.ok(first.usedTokens >= 242_000, 'the carried size was dropped: ' + JSON.stringify(first));
  assert.equal(first.estimated, true, 'a carried value is still an estimate until a receipt arrives');
  assert.equal(first.state, 'ok');

  // Growth after the restore still adds on top of the carried size.
  const grown = compactor.status([...history, assistant('y'.repeat(70_000))]);
  assert.ok(grown.usedTokens > first.usedTokens, 'appends after a restore must still count');

  // A provider receipt supersedes the carried value and clears the estimate flag.
  compactor.recordProviderUsage(250_000, history);
  const measured = compactor.status(history);
  assert.equal(measured.estimated, false);
  assert.equal(measured.usedTokens, 250_000);
});

test('a session restored above the threshold compacts on its next turn', async () => {
  const { provider, requests } = summaryProvider();
  const window = 100_000;
  const compactor = new ContextCompactor(provider, window, [], '', 0);
  const threshold = compactThresholdForWindow(window);
  compactor.restoreUsage(threshold + 5_000);

  const history = [];
  for (let index = 0; index < 6; index++) {
    history.push(user(`older request ${index} ` + 'u'.repeat(4_000)));
    history.push(assistant(`older answer ${index} ` + 'a'.repeat(4_000)));
  }
  history.push(user('LATEST'));
  const before = compactor.status(history);
  assert.ok(before.usedTokens >= before.compactThreshold, 'restored size must sit above the threshold');

  const compacted = await compactor.compactIfNeeded(history, noop);
  assert.equal(requests.length, 1, 'compaction must run without a new measurement');
  const textOf = (messages) => messages.flatMap((message) => message.parts)
    .filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.doesNotMatch(textOf(compacted), /older request 0/, 'the oldest span must leave the request');
  assert.match(textOf(compacted), /CHECKPOINT/, 'the checkpoint must be model-visible');
  assert.ok(textOf(compacted).includes('LATEST'), 'the latest request must survive');
});

test('the replay budget follows the model window instead of a fixed slice', () => {
  assert.equal(rehydrateBudgetForWindow(1_000_000), 600_000);
  assert.equal(rehydrateBudgetForWindow(128_000), 76_800);
  // Tiny windows keep the historical floor so a small model still recalls the last turn.
  assert.equal(rehydrateBudgetForWindow(1_000), MIN_REHYDRATED_TOKENS);
  assert.ok(rehydrateBudgetForWindow(1_000_000) < compactThresholdForWindow(1_000_000));
});

test('seeding replays what the window can hold', () => {
  const saved = [];
  for (let index = 0; index < 24; index++) {
    saved.push({ role: 'user', content: `request ${index} ` + 'u'.repeat(3_500) });
    saved.push({ role: 'assistant', content: `answer ${index} ` + 'a'.repeat(3_500) });
  }
  const perTurn = Math.ceil(3_500 / 3.5) * 2;
  assert.ok(saved.length === 48 && perTurn > 1_000);

  const makeLoop = () => new AgentLoop({
    sessionId: 'seed-budget',
    workspaceDir: process.cwd(),
    memoryDir: process.cwd(),
    memoryEnabled: false,
    provider: summaryProvider().provider,
    toolRuntime: { initialize: async () => {}, beginTurn: () => {}, getBudget: () => ({ maxTurns: 1 }), recordInputTokens: noop, execute: async () => ({ success: true, output: '' }) },
    contextWindow: 1_000_000,
    maxTokens: 512,
    getAbortSignal: () => undefined,
  });

  const wide = makeLoop();
  wide.seedHistoryFromChat(saved, { budgetTokens: 400_000 });
  const narrow = makeLoop();
  narrow.seedHistoryFromChat(saved);

  assert.equal(wide.getHistoryLength(), 48, 'a large window must replay the whole saved conversation');
  assert.ok(narrow.getHistoryLength() < wide.getHistoryLength(), 'the default floor must stay bounded');
  // The floor still replays at least one complete turn.
  assert.ok(narrow.getHistoryLength() >= 2);
  assert.ok(estimateMessageTokens(saved.map((m) => text(m.role, m.content))) > MIN_REHYDRATED_TOKENS);
});

test('the usage record survives a rewrite that only touches the durable index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-usage-'));
  const file = path.join(dir, 'session.json');
  try {
    const snapshot = { usedTokens: 242_000, contextWindow: 1_000_000, compactThreshold: 800_000, estimated: false, updatedAt: 1 };
    fs.writeFileSync(file, JSON.stringify({ version: 2, sessionId: 's', content: 'index', summary: 'checkpoint' }));
    writeContextUsage(file, snapshot);

    const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(stored.content, 'index', 'the durable index must not be erased');
    assert.equal(stored.summary, 'checkpoint', 'the compaction checkpoint must not be erased');
    assert.equal(stored.usage.usedTokens, 242_000);

    const loaded = readContextUsage(file);
    assert.equal(loaded.usedTokens, 242_000);
    const status = contextUsageStatus(loaded);
    assert.equal(status.contextWindow, 1_000_000);
    assert.equal(status.state, 'ok');
    assert.equal(contextUsageStatus({ ...loaded, usedTokens: 900_000 }).state, 'near-limit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged usage record is ignored instead of poisoning the meter', () => {
  assert.equal(normalizeContextUsage(null), null);
  assert.equal(normalizeContextUsage({ usedTokens: 0, contextWindow: 1000 }), null);
  assert.equal(normalizeContextUsage({ usedTokens: 'abc', contextWindow: 1000 }), null);
  assert.equal(normalizeContextUsage({ usedTokens: 10 }), null);
  const repaired = normalizeContextUsage({ usedTokens: '1200', contextWindow: '4000' });
  assert.equal(repaired.usedTokens, 1200);
  assert.equal(repaired.compactThreshold, 3200);
  assert.equal(repaired.estimated, true);
});

test('streaming statuses only hit the disk when the size actually moved', () => {
  const previous = { usedTokens: 100_000, contextWindow: 1_000_000, compactThreshold: 800_000, estimated: true, updatedAt: 1 };
  assert.equal(shouldPersistContextUsage(previous, { ...previous, usedTokens: 101_000 }), false, 'noise must not write');
  assert.equal(shouldPersistContextUsage(previous, { ...previous, usedTokens: 130_000 }), true);
  assert.equal(shouldPersistContextUsage(previous, { ...previous, contextWindow: 200_000 }), true, 'a window change must be recorded');
  assert.equal(shouldPersistContextUsage(null, previous), true, 'the first measurement must be recorded');
});
