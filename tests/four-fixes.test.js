'use strict';
// Regression cover for four fixes that are each a one-line behaviour change and
// therefore easy to undo without noticing:
//
//   1. a fresh profile starts dark, full motion, graphite
//   2. the composer's default context ceiling is 1M with an 80% trigger
//   3. the add buttons are glyphs, and the session list is ordered and stamped
//      by creation time so merely opening a chat cannot reshuffle it
//   4. the dynamic island exists, caps at six steps and honours reduced motion
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

test('the dynamic island is a real surface with a capped, motion-aware list', () => {
  const html = read('src', 'renderer', 'island.html');
  const js = read('src', 'renderer', 'island.js');
  const css = read('src', 'renderer', 'island.css');
  const entry = read('electron-entry.js');
  const preload = read('preload.js');

  assert.match(html, /id="islandSteps"/, 'the list host exists');
  assert.match(js, /const MAX_STEPS = 6;/, 'at most six steps');
  assert.match(js, /steps\.slice\(0, MAX_STEPS\)/, 'the snapshot is truncated, not just styled');
  assert.match(js, /setExpanded/, 'the pill toggles');
  assert.match(css, /backdrop-filter: blur\(26px\) saturate\(190%\)/, 'it is glass, not a flat box');
  assert.match(css, /prefers-reduced-motion/, 'motion settings are honoured');

  assert.match(entry, /preload: path\.join\(__dirname, 'resources', 'island-preload\.js'\)/, 'sandboxed preload');
  assert.match(entry, /transparent: true/, 'the window is transparent');
  assert.match(entry, /skipTaskbar: true/, 'it does not clutter the taskbar');
  assert.match(entry, /if \(readIslandConfig\(\)\.enabled\) createIslandWindow\(\)/, 'it starts only when enabled');
  assert.match(preload, /islandSetEnabled/, 'the appearance toggle has a verb');

  // Compact, frameless, and chevron-free. The old pill was 340×70 with a 30px
  // drop shadow that the window clipped into a solid dark frame — it read as a
  // second black layer around the pill. Both are now asserted against.
  assert.doesNotMatch(html, /island-chevron/, 'no expand arrow in the markup');
  assert.doesNotMatch(css, /island-chevron/, 'no expand arrow in the stylesheet');
  assert.match(css, /inset: 6px/, 'the pill is inset by one small margin on all sides');
  assert.match(css, /box-shadow: none/, 'no clipped drop shadow painting a frame');
  assert.match(entry, /const ISLAND_WIDTH = 248;/, 'compact window width');
  assert.match(entry, /const ISLAND_COMPACT_HEIGHT = 44;/, 'compact window height');
  assert.match(js, /const COMPACT_HEIGHT = 44;/, 'the renderer agrees with the window');
  assert.match(js, /44 \+ 40 \+ steps \* 28/, 'expanded height is derived, not guessed');
});
