const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const renderer = path.join(ROOT, 'src/renderer');
const read = (...parts) => fs.readFileSync(path.join(renderer, ...parts), 'utf8');
const app = read('app.js');
const workbench = read('workbench.css');
const shell = read('styles/shell.css');
const html = read('index.html');

test('the pane never fades in from empty space', () => {
  // Measured before the fix: a switch sampled opacity 0 on the first two
  // frames, then the entry class was removed and a second 150ms fade started
  // from 0.6 - two fades and a visible dip per click.
  assert.ok(!workbench.includes('shell-view-in'), 'the old second fade is back');
  const keyframes = /@keyframes ds-view-settle \{([^}]*)\}/.exec(workbench);
  assert.ok(keyframes, 'ds-view-settle is missing');
  const from = /from \{ opacity: ([\d.]+)/.exec(keyframes[1]);
  assert.ok(from, 'the settle keyframes has no explicit start opacity');
  assert.ok(Number(from[1]) >= 0.9, `the pane starts at opacity ${from[1]}, which reads as a flash`);
});

test('only the entry class animates the pane', () => {
  // `.view.active` used to carry its own animation, so removing the entry class
  // re-triggered it. Exactly one rule may declare an animation on a view.
  const rules = shell.split('\n').filter((line) => /\.view[^{]*\{[^}]*animation\s*:/.test(line));
  assert.deepEqual(rules, [], `the pane animates outside .is-entering: ${rules.join(' | ')}`);
  assert.match(workbench, /\.workbench-shell \.view\.active\.is-entering \{\s*animation: ds-view-settle/);
});

test('the entry class is only applied when it can animate', () => {
  // With motion off, leaving the class on for 400ms made the next switch force
  // a synchronous layout of the whole pane to restart an animation nobody sees.
  assert.match(app, /function viewAnimationsEnabled\(\)/);
  assert.match(app, /if \(viewAnimationsEnabled\(\)\) \{/);
  assert.match(app, /if \(restart\) void panel\.offsetWidth;/, 'the unconditional reflow is back');
});

test('every sidebar destination refreshes its data', () => {
  const views = [...html.matchAll(/data-view="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(views.length >= 8, `expected the sidebar destinations, found ${views.join(', ')}`);
  const block = /const VIEW_REFRESH = \{([\s\S]*?)\n\};/.exec(app);
  assert.ok(block, 'VIEW_REFRESH is missing');
  // chat renders itself; appearance is filled at startup by
  // loadAppearanceSettings(); about is static markup with the version injected
  // at boot. Everything else must reload when it is opened.
  const SELF_LOADING = new Set(['chat', 'appearance', 'about']);
  for (const view of views) {
    if (SELF_LOADING.has(view)) continue;
    assert.match(block[1], new RegExp(`['"]?${view}['"]?\\s*:`), `${view} has no refresh entry and would open empty`);
  }
  assert.match(app, /const refresh = VIEW_REFRESH\[view\];\s*\n\s*if \(refresh\) refresh\(\);/);
});
