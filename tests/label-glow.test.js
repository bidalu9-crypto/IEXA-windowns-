// The running label's band must lift the glyphs toward the primary label
// colour. It used to reuse --thinking-sheen, which is black in the dark theme:
// the band then erased the characters it crossed, and the cut edge read as a
// broken, doubled glyph. Pinned here so the token cannot come back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = (...parts) => fs.readFileSync(path.join(ROOT, 'src/renderer', ...parts), 'utf8');

test('the running label lifts its glyphs instead of painting over them', () => {
  const sheet = css('workbench.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.label-glow \{[^}]*\}/.exec(sheet);
  assert.ok(rule, '.label-glow rule is gone');
  assert.doesNotMatch(rule[0], /--thinking-sheen/,
    '--thinking-sheen is black in the dark theme; the band would erase the glyphs');
  assert.match(rule[0], /var\(--label-glow-tint, var\(--text-primary\)\)/,
    'the band tint must follow the theme primary label colour');

  // The mask has to reach full transparency inside the sweep box: at 105deg the
  // gradient ends on a diagonal, so a stop at 100% leaves the clipped edge lit
  // and that clip cuts straight through whatever glyph sits on it.
  const sweep = /\.label-glow__sweep \{[^}]*\}/.exec(sheet);
  assert.ok(sweep, '.label-glow__sweep rule is gone');
  const stops = [...sweep[0].matchAll(/transparent (\d+)%/g)].map((m) => Number(m[1]));
  assert.ok(stops.length >= 2, 'the sweep mask must fade out on both sides');
  assert.ok(Math.max(...stops) <= 85, 'the mask must be clear before the clip edge, got ' + stops.join('/'));
});
