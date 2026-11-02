// The prompt used to jump out of sight on send. It is now pinned to the top of
// the viewport (Codex behaviour): a spacer lends the missing room, and each
// frame of the reply gives that room back, so the prompt stays put while the
// text grows underneath.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const helpers = fs.readFileSync(path.join(RENDERER, 'services', 'UiHelpers.js'), 'utf8');
const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(RENDERER, 'styles', 'transcript.css'), 'utf8');

test('sending pins the prompt, and the helpers are declared before use', () => {
  assert.match(app, /anchorTurnAtTop\(sentMessage\)/, 'sendMessage pins the prompt');
  const anchorAt = helpers.indexOf('function anchorTurnAtTop(');
  const scrollAt = helpers.indexOf('function scrollToBottom(');
  assert.ok(anchorAt > 0, 'anchorTurnAtTop exists');
  assert.ok(anchorAt < scrollAt, 'declared above scrollToBottom');
});

test('the spacer lends the missing room and is always cleaned up', () => {
  const start = helpers.indexOf('function anchorTurnAtTop(');
  const body = helpers.slice(start, helpers.indexOf('\n}', start));
  assert.match(body, /room = box\.height - 16 - rect\.height - 24/, 'room is measured, not guessed');
  assert.match(body, /if \(room < 80\) return;/, 'a prompt that fills the viewport is not pinned');
  assert.match(body, /chatMessages\.appendChild\(spacer\)/, 'the spacer joins the transcript');
  assert.match(body, /container\.scrollTop = Math\.max\(0, top - 16\)/, 'the prompt lands at the top');
  assert.match(helpers, /function removeTurnAnchorSpacer\(\)/, 'one place removes it');
});

test('every scroll frame gives room back, and the anchor retires when it is gone', () => {
  const start = helpers.indexOf('function shrinkTurnAnchor(');
  const body = helpers.slice(start, helpers.indexOf('\n}', start));
  assert.match(body, /const next = Math\.max\(0, turnAnchor\.room - grown\)/, 'the give-back is measured');
  assert.match(body, /if \(next <= 0\) \{[\s\S]*?removeTurnAnchorSpacer\(\)/, 'it retires at zero');
  assert.match(body, /spacer\.style\.height = next \+ 'px'/, 'otherwise it shrinks by exactly that much');
  const scroll = helpers.slice(helpers.indexOf('function scrollToBottom('));
  assert.match(scroll, /if \(force\) clearTurnAnchor\(\);\s*else shrinkTurnAnchor\(\);/, 'scrollToBottom drives it');
});

test('a manual scroll takes the viewport back', () => {
  assert.match(helpers, /addEventListener\('wheel', function \(event\) \{\s*clearTurnAnchor\(\);/, 'wheel clears it');
  assert.match(helpers, /pointerdown', \(\) => \{ clearTurnAnchor\(\);/, 'pointer clears it');
  assert.match(css, /\.turn-anchor-spacer \{/, 'the spacer has a style');
});
