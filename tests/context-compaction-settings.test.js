// The compaction ceiling used to be a five-value whitelist and the trigger point
// was hard-coded at 80%. Both are now user settings: any window >= 128K and a
// trigger anywhere from 50% to 100%. These tests pin the contracts, including
// the clamps that stop a typo from collapsing the threshold to zero.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_CONTEXT_COMPACTION_LIMIT,
  MAX_CONTEXT_COMPACTION_LIMIT,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  normalizeContextCompactionLimit,
  normalizeContextCompactionThreshold,
} = require('../dist/main/session/ContextCompactionSettings');
const { compactThresholdForWindow, rehydrateBudgetForWindow } = require('../dist/main/agent/ContextCompactor');

test('a custom window is any safe integer from 128K up', () => {
  assert.equal(normalizeContextCompactionLimit(128000), 128000);
  assert.equal(normalizeContextCompactionLimit(200000), 200000);
  assert.equal(normalizeContextCompactionLimit(500000), 500000);
  assert.equal(normalizeContextCompactionLimit('1234567'), 1234567);
  assert.equal(normalizeContextCompactionLimit(MAX_CONTEXT_COMPACTION_LIMIT), MAX_CONTEXT_COMPACTION_LIMIT);
  // Below the floor, above the ceiling, fractional, or not a number: rejected.
  assert.equal(normalizeContextCompactionLimit(127999), undefined);
  assert.equal(normalizeContextCompactionLimit(100000), undefined);
  assert.equal(normalizeContextCompactionLimit(MAX_CONTEXT_COMPACTION_LIMIT + 1), undefined);
  assert.equal(normalizeContextCompactionLimit(128000.5), undefined);
  assert.equal(normalizeContextCompactionLimit('abc'), undefined);
  assert.equal(normalizeContextCompactionLimit(NaN), undefined);
  // Clearing: auto / empty / zero.
  assert.equal(normalizeContextCompactionLimit('auto'), undefined);
  assert.equal(normalizeContextCompactionLimit(''), undefined);
  assert.equal(normalizeContextCompactionLimit(0), undefined);
  assert.equal(normalizeContextCompactionLimit(null), undefined);
});

test('the trigger point accepts 50-100 as either a ratio or a percentage', () => {
  assert.equal(normalizeContextCompactionThreshold(0.5), 0.5);
  assert.equal(normalizeContextCompactionThreshold(0.85), 0.85);
  assert.equal(normalizeContextCompactionThreshold(1), 1);
  assert.equal(normalizeContextCompactionThreshold(85), 0.85);
  assert.equal(normalizeContextCompactionThreshold('70'), 0.7);
  assert.equal(normalizeContextCompactionThreshold('100'), 1);
  // Out of range is rejected rather than silently clamped.
  assert.equal(normalizeContextCompactionThreshold(0.49), undefined);
  assert.equal(normalizeContextCompactionThreshold(49), undefined);
  assert.equal(normalizeContextCompactionThreshold(101), undefined);
  assert.equal(normalizeContextCompactionThreshold('abc'), undefined);
  assert.equal(normalizeContextCompactionThreshold('auto'), undefined);
  assert.equal(normalizeContextCompactionThreshold(null), undefined);
  // Rounding keeps the stored value readable.
  assert.equal(normalizeContextCompactionThreshold(0.834), 0.83);
});

test('the threshold follows the ratio and still reserves the output budget', () => {
  assert.equal(DEFAULT_COMPACTION_THRESHOLD_RATIO, 0.8);
  assert.equal(compactThresholdForWindow(200000), 160000, 'default stays at 80%');
  assert.equal(compactThresholdForWindow(200000, 0, 0.5), 100000);
  assert.equal(compactThresholdForWindow(200000, 0, 1), 200000);
  // A huge completion budget still caps the threshold: input + output must fit.
  assert.equal(compactThresholdForWindow(200000, 64000, 1), 136000);
  assert.equal(compactThresholdForWindow(200000, 64000, 0.5), 100000);
  // Nonsense ratios are clamped into range instead of producing a zero threshold.
  assert.equal(compactThresholdForWindow(200000, 0, 0), 160000, '0 falls back to the default');
  assert.equal(compactThresholdForWindow(200000, 0, 0.1), 100000, 'below 0.5 clamps to 0.5');
  assert.equal(compactThresholdForWindow(200000, 0, 5), 200000, 'above 1 clamps to 1');
});

test('a custom window changes replay size proportionally', () => {
  const narrow = rehydrateBudgetForWindow(128000);
  const wide = rehydrateBudgetForWindow(1000000);
  assert.ok(wide > narrow, `a wider window must replay more: ${wide} vs ${narrow}`);
  assert.equal(narrow, Math.max(24000, Math.floor(compactThresholdForWindow(128000) * 0.75)));
});
