// The insights endpoint and the aggregation behind it. Fixtures are written to a
// throwaway workspace so the numbers are known exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { estimateTokens, collectUsageInsights } = require('../dist/main/usage/UsageInsights');

const DAY = 24 * 60 * 60 * 1000;

function fixture(t, sessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-insights-'));
  const dir = path.join(root, '.iexa-sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, messages] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ messages }, null, 2));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assistant(overrides = {}) {
  return {
    role: 'assistant',
    content: 'done',
    timestamp: Date.now(),
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800 },
    durationMs: 4000,
    generationMs: 1200,
    firstTokenMs: 900,
    toolCalls: [],
    ...overrides,
  };
}

test('token estimates land in the documented band', () => {
  // Pure ASCII: ~4 characters per token.
  assert.ok(Math.abs(estimateTokens('a'.repeat(400)) - 104) <= 12);
  // CJK: closer to one token per character.
  assert.ok(Math.abs(estimateTokens('中'.repeat(100)) - 140) <= 12);
  assert.equal(estimateTokens(''), 0);
});

test('totals, cache rate and the daily buckets come from reported usage', (t) => {
  const now = Date.now();
  const root = fixture(t, {
    s1: [
      { role: 'user', content: 'hello' },
      assistant({ timestamp: now, toolCalls: [{ result: { durationMs: 300, output: 'ok' } }] }),
      assistant({ timestamp: now - DAY, usage: { inputTokens: 500, outputTokens: 50 } }),
    ],
  });

  const insights = collectUsageInsights({
    workspaceDir: root,
    range: 'all',
    priceFor: () => ({ input: 1, output: 2 }),
    meta: new Map([['s1', { title: 'Fixture', model: 'm', provider: 'p' }]]),
  });

  assert.equal(insights.totals.sessions, 1);
  assert.equal(insights.totals.turns, 2);
  assert.equal(insights.totals.inputTokens, 1500);
  assert.equal(insights.totals.outputTokens, 150);
  assert.equal(insights.totals.cacheReadTokens, 800);
  assert.equal(insights.totals.cacheHitRate, 800 / 1500);
  assert.equal(insights.totals.toolCalls, 1);
  assert.equal(insights.totals.toolMs, 300);
  assert.equal(insights.daily.length, 2, 'two local days were touched');
  assert.equal(insights.sessions[0].title, 'Fixture');
});

test('the range filter drops turns before the cutoff', (t) => {
  const now = Date.now();
  const root = fixture(t, {
    s1: [
      assistant({ timestamp: now }),
      assistant({ timestamp: now - 10 * DAY }),
    ],
  });
  const week = collectUsageInsights({ workspaceDir: root, range: '7d', priceFor: () => null });
  assert.equal(week.totals.turns, 1);
  const all = collectUsageInsights({ workspaceDir: root, range: 'all', priceFor: () => null });
  assert.equal(all.totals.turns, 2);
});

test('cost stays null when no price is configured, and is summed when it is', (t) => {
  const root = fixture(t, { s1: [assistant()] });
  const unpriced = collectUsageInsights({ workspaceDir: root, range: 'all', priceFor: () => null });
  assert.equal(unpriced.totals.costUsd, null);
  assert.equal(unpriced.costIncomplete, true);
  assert.equal(unpriced.daily[0].costUsd, null);

  // 1000 prompt tokens (800 cached at 0.1x) + 100 output at $2/M.
  const priced = collectUsageInsights({
    workspaceDir: root, range: 'all',
    priceFor: () => ({ input: 1, output: 2, cacheRead: 0.1 }),
  });
  const expected = (200 * 1 + 800 * 0.1 + 100 * 2) / 1_000_000;
  assert.ok(Math.abs(priced.totals.costUsd - expected) < 1e-9, String(priced.totals.costUsd));
});

test('the token split attributes the unseen prompt to system and tools', (t) => {
  const root = fixture(t, { s1: [assistant({ usage: { inputTokens: 10000, outputTokens: 200 } })] });
  const insights = collectUsageInsights({ workspaceDir: root, range: 'all', priceFor: () => null });
  const byKey = Object.fromEntries(insights.tokenBreakdown.map((part) => [part.key, part]));
  assert.ok(byKey.system.tokens > 0);
  assert.ok(byKey.tools.tokens > byKey.system.tokens, 'tool schemas are the larger fixed cost');
  assert.equal(byKey.output.tokens, 200, 'output is reported, never estimated');
  assert.equal(insights.tokenBreakdownEstimated, true);
  const total = insights.tokenBreakdown.reduce((sum, part) => sum + part.ratio, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'ratios sum to one');
});

test('the time split never exceeds the measured turn duration', (t) => {
  const root = fixture(t, {
    s1: [assistant({
      durationMs: 5000, generationMs: 2000, firstTokenMs: 1000,
      content: 'a'.repeat(100), thinking: 'b'.repeat(100),
      toolCalls: [{ result: { durationMs: 500, output: 'x' } }],
    })],
  });
  const insights = collectUsageInsights({ workspaceDir: root, range: 'all', priceFor: () => null });
  const byKey = Object.fromEntries(insights.timeBreakdown.map((part) => [part.key, part.ms]));
  assert.equal(byKey.wait, 1000);
  assert.equal(byKey.tool, 500);
  assert.equal(byKey.think + byKey.output, 2000, 'thinking and answer share the decode window');
  assert.equal(byKey.other, 1500, 'the remainder is measured, not invented');
});

test('an empty workspace returns zeroed totals instead of throwing', (t) => {
  const root = fixture(t, {});
  const insights = collectUsageInsights({ workspaceDir: root, range: '7d', priceFor: () => null });
  assert.equal(insights.totals.turns, 0);
  // The axis is still continuous so the chart draws empty days instead of
  // collapsing to a single column.
  assert.equal(insights.daily.length, 7, 'seven day buckets');
  assert.ok(insights.daily.every((day) => day.inputTokens === 0 && day.outputTokens === 0));
  assert.equal(insights.tokenBreakdownEstimated, false);
});
