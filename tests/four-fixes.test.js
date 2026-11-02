'use strict';
// Regression cover for four fixes that are each a one-line behaviour change and
// therefore easy to undo without noticing:
//
//   1. a fresh profile starts dark, full motion, graphite
//   2. the composer's default context ceiling is 1M with an 80% trigger
//   3. the add buttons are glyphs, and the session list is ordered and stamped
//      by creation time so merely opening a chat cannot reshuffle it
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('a fresh profile is dark with full motion and the graphite skin', () => {
  const { normalizeAppearance } = require('../dist/main/appearance/AppearanceSchema');
  const fresh = normalizeAppearance({});
  assert.equal(fresh.theme, 'dark');
  assert.equal(fresh.motion, 'full');
  assert.equal(fresh.skinPreset, 'graphite');
  assert.equal(fresh.accent, 'mono', 'the accent matches graphite rather than a violet default');

  // An explicit choice still wins, in both directions.
  assert.equal(normalizeAppearance({ theme: 'light' }).theme, 'light');
  assert.equal(normalizeAppearance({ motion: 'reduced' }).motion, 'reduced');
  assert.equal(normalizeAppearance({ skinPreset: 'amber' }).skinPreset, 'amber');
});

test('the context ceiling defaults to 1M and the trigger to 80%', () => {
  const src = read('src', 'renderer', 'services', 'ModelProfiles.js');
  assert.match(src, /const DEFAULT_CONTEXT_COMPACTION_LIMIT = 1000000;/, 'the 1M constant exists');
  assert.match(src, /const DEFAULT_CONTEXT_COMPACTION_THRESHOLD = 80;/, 'the 80% default is still there');
  assert.match(src, /if \(!currentContextCompactionLimit\) currentContextCompactionLimit = DEFAULT_CONTEXT_COMPACTION_LIMIT;/,
    'the default is applied when nothing is stored');
  const uses = (src.match(/DEFAULT_CONTEXT_COMPACTION_LIMIT/g) || []).length;
  assert.ok(uses >= 2, 'the constant is declared and used, not just declared');
});

test('the compaction number is centred rather than left-aligned', () => {
  const css = read('src', 'renderer', 'components', 'ContextCompaction.css');
  const block = css.slice(css.indexOf('.cc-inline .cc-stepper input {'));
  const rule = block.slice(0, block.indexOf('}'));
  assert.match(rule, /text-align: center;/, 'the value is centred');
  assert.doesNotMatch(rule, /text-align: left;/, 'the old left alignment is gone');
});

test('the three add buttons are glyphs, not plus characters', () => {
  const html = read('src', 'renderer', 'index.html');
  const iconOf = (id) => {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > 0, id + ' exists');
    const hit = html.slice(at, at + 360).match(/ui-(folder|edit|plus)/);
    return hit ? hit[0] : 'NONE';
  };
  assert.equal(iconOf('shellAddProject'), 'ui-folder');
  assert.equal(iconOf('filesOpenBtn'), 'ui-folder');
  assert.equal(iconOf('newSessionBtn'), 'ui-edit', 'a new conversation reads as compose, not as "+"');
});

test('the session list orders and stamps by creation time', () => {
  const src = read('src', 'renderer', 'services', 'SessionList.js');
  assert.match(src, /\(Number\(b\.created\) \|\| Number\(b\.updated\) \|\| 0\) - \(Number\(a\.created\) \|\| Number\(a\.updated\) \|\| 0\)/,
    'created descends, with updated only as a legacy fallback');
  assert.doesNotMatch(src, /Number\(b\.updated\) - Number\(a\.updated\)/,
    'the old updated-only comparison is gone');
  assert.match(src, /formatTime\(s\.created \|\| s\.updated\)/, 'the stamp reads the creation time');
  // Pinning still outranks the date, otherwise the feature would silently die.
  assert.match(src, /Number\(b\.pinned === true\) - Number\(a\.pinned === true\)/);
});
