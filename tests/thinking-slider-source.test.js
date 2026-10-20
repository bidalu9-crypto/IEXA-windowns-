'use strict';
// Guards for the reasoning slider: one source of truth for the fill colour and
// the two top-step motions must survive later edits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workbench = fs.readFileSync(path.resolve('src/renderer/workbench.css'), 'utf8');
const base = fs.readFileSync(path.resolve('src/renderer/styles/base.css'), 'utf8');
const view = fs.readFileSync(path.resolve('src/renderer/services/ModelProfiles.js'), 'utf8');

test('the rail fill has no hard-coded accent and reuses the action token', () => {
  assert.doesNotMatch(workbench, /#5ca5fb/i, 'a fixed blue survived the theme pass');
  assert.match(workbench, /\.thinking-slider-fill \{[^}]*background: var\(--action-bg\)/,
    'the fill is not tied to the theme action colour');
});

test('both themes define the top-step material', () => {
  assert.match(base, /--thinking-max-a: #6d4aff/);
  assert.match(base, /--thinking-track: #e4e4e7/);
  assert.match(base, /\[data-theme="dark"\][\s\S]{0,4000}--thinking-max-a: #7c5cff/);
  assert.match(base, /--thinking-track: #3a3a3f/);
});

test('the sheen and the spark stream are separate motions on the compositor', () => {
  assert.match(workbench, /@keyframes thinking-max-sheen \{[^}]*transform: translateX/);
  assert.match(workbench, /@keyframes thinking-max-flow \{[^}]*transform: translateX/);
  assert.match(workbench, /\.thinking-slider-track\[data-at-max="true"\] \.thinking-slider-sheen \{[^}]*animation: thinking-max-sheen/);
  assert.match(workbench, /\.thinking-slider-track\[data-at-max="true"\] \.thinking-slider-flow::before \{[^}]*animation: thinking-max-flow/);
  assert.doesNotMatch(workbench, /@keyframes thinking-max-(?:sheen|flow) \{[^}]*background-position/,
    'animating background-position repaints the bar every frame');
});

test('the top step is decided from the model ceiling, not a fixed index', () => {
  assert.match(view, /const atMax = maxIndex > 0 && selected === maxIndex/);
  assert.match(view, /track\.dataset\.atMax = String\(atMax\)/);
  assert.match(view, /track\.style\.setProperty\('--thinking-fill'/,
    'the fill ratio must live on the track that paints it');
});
