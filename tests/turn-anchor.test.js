// Sending pins the prompt to the top of the viewport and the reply starts
// directly beneath it — the Codex desktop behaviour.
//
// The room needed to scroll the last message up comes from the transcript's own
// padding-bottom. An earlier attempt inserted a spacer element instead; because
// the assistant message is appended afterwards, the spacer ended up *between*
// prompt and reply and left a half-screen hole. Padding is on the container, so
// append order cannot break the adjacency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const helpers = fs.readFileSync(path.join(RENDERER, 'services', 'UiHelpers.js'), 'utf8');
const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(RENDERER, 'styles', 'transcript.css'), 'utf8');

const bodyOf = (name) => {
  const start = helpers.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' exists');
  return helpers.slice(start, helpers.indexOf('\n}', start));
};

test('sending pins the prompt, and the anchor helpers are declared before use', () => {
  assert.match(app, /anchorTurnAtTop\(sentMessage\)/, 'sendMessage pins the prompt');
  const anchorAt = helpers.indexOf('function anchorTurnAtTop(');
  const scrollAt = helpers.indexOf('function scrollToBottom(');
  assert.ok(anchorAt < scrollAt, 'declared above scrollToBottom');
});

test('the room comes from container padding, never from a spacer between messages', () => {
  const body = bodyOf('anchorTurnAtTop');
  assert.match(body, /const room = box\.height - 16 - rect\.height - 24/, 'room is measured');
  assert.match(body, /if \(room < 80\) return;/, 'a prompt that fills the viewport is not pinned');
  assert.match(body, /container\.style\.paddingBottom = \(base \+ room\) \+ 'px'/, 'padding lends the room');
  assert.match(body, /container\.scrollTop = Math\.max\(0, top - 16\)/, 'the prompt lands at the top');
  assert.doesNotMatch(body, /createElement\('div'\)/, 'no element is inserted into the flow');
  assert.doesNotMatch(css, /turn-anchor-spacer/, 'the spacer style is gone');
});

test('the padding is handed back frame by frame and restored at zero', () => {
  const body = bodyOf('shrinkTurnAnchor');
  assert.match(body, /const grown = \(container\.scrollHeight - padded\) - turnAnchor\.contentHeight/);
  assert.match(body, /const next = Math\.max\(0, turnAnchor\.room - grown\)/);
  assert.match(body, /if \(next <= 0\) \{[\s\S]*?restoreTurnAnchorPadding\(\)/, 'retires at zero');
  assert.match(body, /container\.style\.paddingBottom = \(turnAnchor\.base \+ next\) \+ 'px'/);
  assert.match(bodyOf('restoreTurnAnchorPadding'), /container\.style\.paddingBottom = basePadding/);
  assert.match(helpers, /if \(force\) clearTurnAnchor\(\);\s*else shrinkTurnAnchor\(\);/, 'scrollToBottom drives it');
});

test('a manual scroll takes the viewport back', () => {
  assert.match(helpers, /addEventListener\('wheel', function \(event\) \{\s*clearTurnAnchor\(\);/, 'wheel clears it');
  assert.match(helpers, /pointerdown', \(\) => \{ clearTurnAnchor\(\);/, 'pointer clears it');
});
