const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateCostUsd } = require('../dist/main/observability/CostTracker');

test('cost estimator uses built-in model rates and returns null for unpriced aliases', () => {
  assert.equal(estimateCostUsd('openai', 'gpt-4o', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 12.5);
  assert.equal(estimateCostUsd('openai', 'gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), null);
});

test('profile rates price gateway aliases with distinct cache read/write rates', () => {
  const result = estimateCostUsd('custom', 'private-model-alias', {
    inputTokens: 1_000_000, outputTokens: 500_000,
    cacheReadInputTokens: 200_000, cacheCreationInputTokens: 100_000,
  }, { input: 2, output: 8, cacheRead: 0.2, cacheCreation: 2.5 });
  assert.equal(result, 6.29);
});

test('zero rates remain a real free price rather than an unknown price', () => {
  assert.equal(estimateCostUsd('custom', 'free', { inputTokens: 9000, outputTokens: 1000 }, { input: 0, output: 0 }), 0);
});

