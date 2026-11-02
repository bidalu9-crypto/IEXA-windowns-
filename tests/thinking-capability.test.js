'use strict';
// The level a user picks must match what the provider actually serialises.
//
// Two defects motivated this file:
//   1. `maxThinkingLevel` capped every DeepSeek id at `high`, but the V4 gateway
//      accepts `high` and `max`, so the only setting that changed behaviour was
//      unreachable from the slider;
//   2. pre-V4 DeepSeek sends no level at all, yet the UI still offered seven
//      steps as if the choice mattered.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { maxThinkingLevel, thinkingWire, clampThinkingLevel } = require('../dist/main/providers/ModelCapabilities');

test('DeepSeek V4 exposes max, because its gateway accepts high and max', () => {
  assert.equal(maxThinkingLevel('openai', 'BLANK-deepseek-v4.1-flash'), 'max');
  assert.equal(maxThinkingLevel('openai', 'deepseek-v4-pro'), 'max');
  // The cap is a ceiling, not a rewrite: lower levels stay where they are.
  assert.equal(clampThinkingLevel('medium', 'openai', 'deepseek-v4.1-flash'), 'medium');
  assert.equal(clampThinkingLevel('ultra', 'openai', 'deepseek-v4.1-flash'), 'max');
});

test('pre-V4 DeepSeek is reported as model-decides rather than a selectable level', () => {
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1', 'deepseek-ai/deepseek-v3']) {
    assert.equal(thinkingWire('openai', model), 'model-decides', model + ' sends no level');
  }
  // V4 is the exception that does take a level.
  assert.equal(thinkingWire('openai', 'deepseek-v4.1-flash'), 'levels');
});

test('models without a reasoning mode are unsupported, reasoning models are not', () => {
  assert.equal(thinkingWire('openai', 'gpt-4o'), 'unsupported');
  assert.equal(thinkingWire('openai', 'gpt-4o-mini'), 'unsupported');
  assert.equal(thinkingWire('openai', 'gpt-5'), 'levels');
  assert.equal(thinkingWire('openai', 'o3'), 'levels');
  assert.equal(thinkingWire('xai', 'grok-4'), 'levels');
  assert.equal(thinkingWire('anthropic', 'claude-opus-5'), 'levels');
  assert.equal(thinkingWire('gemini', 'gemini-3-pro'), 'levels');
});

test('the GLM flash cap stays at high, matching the one level it forwards', () => {
  assert.equal(maxThinkingLevel('openai', 'glm-5-3-flash'), 'high');
  assert.equal(thinkingWire('openai', 'glm-5-3-flash'), 'levels');
});

test('the renderer reads the wire field and never shows a dead level as active', () => {
  const view = fs.readFileSync(path.resolve('src/renderer/services/ModelProfiles.js'), 'utf8');
  assert.match(view, /function thinkingWireForModel/);
  assert.match(view, /profile\.thinkingWire/);
  assert.match(view, /btn\.disabled = wire !== 'levels' \|\| maxLevel === 'off'/,
    'the button is inert when the level never reaches the provider');
  assert.match(view, /slider\.disabled = maxIndex === 0 \|\| wire !== 'levels'/);
  assert.match(view, /const levelLabel = wire === 'model-decides'/, 'the chip must name the real state');
  assert.match(view, /getElementById\('thinkingSliderNote'\)/, 'the menu must state what will be sent');
  assert.match(view, /if \(model\.includes\('deepseek-v4'\)\) return 'max'/,
    'an older backend must not hide the top steps');
  assert.match(view, /const activeProfile = modelSelectorProfiles/);
});
