// The task strip and the composer beneath it must share one width at every
// breakpoint. They used to compute it separately: the composer narrows to 28px
// at ≤1050 and 20px at ≤760, while the strip kept a flat 48px, so the banner hung
// past the input on both sides (visible in the reported screenshot).
//
// One custom property now owns that inset. Because a media query does not raise
// specificity, every override also has to come *after* the base declaration in
// source order — that ordering bug is why the narrow breakpoint silently did
// nothing on the first attempt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const workbench = fs.readFileSync(path.join(RENDERER, 'workbench.css'), 'utf8');
const dock = fs.readFileSync(path.join(RENDERER, 'styles', 'dock.css'), 'utf8');

const baseAt = workbench.indexOf('--composer-inset: 48px');
const midAt = workbench.indexOf('--composer-inset: 28px');
const narrowAt = workbench.indexOf('--composer-inset: 20px');

test('one property owns the inset, and every override follows the base', () => {
  assert.ok(baseAt > 0, 'the base inset is declared');
  assert.ok(midAt > baseAt, 'the ≤1050 override comes after the base');
  assert.ok(narrowAt > baseAt, 'the ≤760 override comes after the base');
  // A media query does not win on specificity: an earlier declaration loses to
  // the later unconditional one. That is the bug this asserts against.
  assert.ok(narrowAt > midAt, 'the narrow override is the last one');
});

test('both surfaces read that property instead of hard-coding a number', () => {
  assert.match(dock, /\.composer-dock \{[^}]*width: calc\(100% - var\(--composer-inset, 48px\)\)/,
    'the strip reads the property');
  assert.doesNotMatch(dock, /width: calc\(100% - 48px\)/, 'the strip no longer hard-codes 48px');
  for (const fallback of ['48px', '28px', '20px']) {
    assert.match(workbench, new RegExp('width: calc\\(100% - var\\(--composer-inset, ' + fallback + '\\)\\)'),
      'the composer reads the property at ' + fallback);
  }
});

test('the composer only ever narrows through the variable', () => {
  const composerWidths = [...workbench.matchAll(/\.workbench-shell \.chat-input-area \{[^}]*width: ([^;]+);/g)]
    .map((match) => match[1].trim());
  assert.ok(composerWidths.length >= 3, 'all breakpoints are present');
  for (const width of composerWidths) {
    assert.match(width, /^calc\(100% - var\(--composer-inset/, 'literal width found: ' + width);
  }
});

test('the landing screen caps both surfaces at one measure', () => {
  // The hero centres the composer at 780px; a sibling strip without its own cap
  // stretched the full column and hung past the input on both sides.
  assert.match(workbench, /--composer-max: 780px/, 'the cap is declared once');
  assert.match(workbench, /#view-chat\.is-welcome \.chat-input-area \{ max-width: var\(--composer-max, 780px\)/,
    'the composer reads it');
  assert.match(workbench, /#view-chat\.is-welcome \.composer-dock \{ max-width: var\(--composer-max, 780px\)/,
    'the strip reads the same measure');
  assert.doesNotMatch(workbench, /#view-chat\.is-welcome \.chat-input-area \{ max-width: 780px/,
    'no literal 780px alongside the variable');
});
