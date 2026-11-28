// Sending pins the prompt to the top of the viewport and the reply starts
// directly beneath it — the Codex desktop behaviour.
//
// The room needed comes from the transcript's own padding-bottom. It is given
// back in step with the reply rather than held at full size: holding it let
// scrollHeight grow with the text and then drop a whole viewport in a single
// step, which left the browser clamping scrollTop onto the first message the
// moment the reply filled the room - or the moment the reader touched the wheel.
// Giving it back as the text lands keeps scrollHeight constant, so scrollTop is
// never clamped and the prompt does not move. `tests/browser-stream-jitter.test.js`
// measures the painted result; `tests/browser-turn-anchor.test.js` measures the
// release.
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
  assert.ok(anchorAt > 0 && anchorAt < scrollAt, 'declared above scrollToBottom');
});

test('the room comes from container padding, measured off the prompt itself', () => {
  const body = bodyOf('anchorTurnAtTop');
  assert.match(body, /const room = box\.height - 16 - rect\.height - 24/, 'room is measured');
  assert.match(body, /if \(room < 80\) return;/, 'a prompt that fills the viewport is not pinned');
  assert.match(body, /container\.style\.paddingBottom = \(base \+ room\) \+ 'px'/, 'padding lends the room');
  assert.match(body, /container\.scrollTop = Math\.max\(0, top - 16\)/, 'the prompt lands at the top');
  assert.match(body, /turnAnchor = \{ el: messageEl, container, room, base, basePadding \}/, 'the base padding is kept for the return');
  assert.doesNotMatch(body, /createElement\('div'\)/, 'no element is inserted into the flow');
  assert.doesNotMatch(css, /turn-anchor-spacer/, 'the spacer style is gone');

  // `room` is the space below the prompt inside the viewport, so the amount the
  // reply has claimed has to be measured from the prompt's bottom. Measuring
  // from its top double-counts the prompt and hands back a slice of the room on
  // the very first frame.
  const below = bodyOf('turnAnchorContentBelow');
  assert.match(below, /return last\.getBoundingClientRect\(\)\.bottom - prompt\.bottom;/, 'measured from the prompt bottom');
});

test('the room is given back without ever writing scrollTop', () => {
  // Three passes per token - read scrollHeight, write padding, clamp scrollTop -
  // is what made the message wobble. The sync may write padding, never position:
  // scrollHeight stays constant, so there is nothing to clamp.
  const sync = bodyOf('syncTurnAnchorPadding');
  assert.match(sync, /Math\.max\(0, turnAnchor\.room - turnAnchorContentBelow\(\)\)/, 'give back exactly what landed');
  assert.match(sync, /if \(turnAnchor\.container\.style\.paddingBottom !== target\) turnAnchor\.container\.style\.paddingBottom = target;/, 'one write, and only when the value moves');
  assert.doesNotMatch(sync, /scrollTop/, 'the sync never touches the scroll offset');
  assert.equal((helpers.match(/function shrinkTurnAnchor\(/g) || []).length, 0, 'no separate per-frame shrink');

  const scroll = helpers.slice(helpers.indexOf('function scrollToBottom('));
  const head = scroll.slice(0, scroll.indexOf('requestAnimationFrame'));
  assert.match(head, /syncTurnAnchorPadding\(\);\s*if \(turnAnchorHolds\(\)\) return;/, 'the sync runs before the anchored frame returns');
  assert.match(head, /releaseTurnAnchorIfFull\(\);/, 'the single release point is explicit');
});

test('the room is returned continuously, so the release cannot move anything', () => {
  const restore = bodyOf('restoreTurnAnchorPadding');
  assert.match(restore, /container\.style\.paddingBottom = basePadding/, 'the base padding comes back');
  // If a growth path never called scrollToBottom the padding can still be ahead
  // of the text. Carry the offset across so that return, too, leaves the reader
  // where they were instead of letting the browser clamp them to the top.
  assert.match(restore, /const heightBefore = container\.scrollHeight;/, 'the shrink is measured');
  assert.match(restore, /container\.scrollTop = Math\.max\(0, topBefore - \(heightBefore - heightAfter\)\)/, 'the offset is carried across');
  assert.match(helpers, /if \(!turnAnchor\.el\.isConnected \|\| !chatViewIsActive\(\)\) \{ restoreTurnAnchorPadding\(\); return false; \}/,
    'a detached prompt releases the anchor');
});

test('a manual scroll takes the viewport back', () => {
  assert.match(helpers, /addEventListener\('wheel', function \(event\) \{\s*clearTurnAnchor\(\);/, 'wheel clears it');
  assert.match(helpers, /pointerdown', \(\) => \{ clearTurnAnchor\(\);/, 'pointer clears it');
  assert.match(css, /overflow-anchor: none;/, 'the browser is told not to re-anchor behind our back');
  assert.match(helpers, /function isChatGestureScrolling\(\) \{\s*return chatWheelScrollActive \|\| chatTouchScrollActive;/, 'wheel/touch is distinguishable from a click');
});

test('the cold-start jump yields to a running turn and to a wheel', () => {
  // The regression: a freshly created conversation starts scrollHistoryToLatest,
  // whose pin() runs for seconds. It was still alive when the first turn began,
  // so it dragged the transcript to the bottom of the borrowed room on every
  // streamed token; the release then clamped the reader onto the first message.
  const pinAt = app.indexOf('  const pin = () => {');
  assert.ok(pinAt > 0, 'pin() exists');
  const pin = app.slice(pinAt, app.indexOf('\n  };', pinAt));
  assert.match(pin, /if \(cancelled \|\|/, 'a cancelled positioning run stops pinning');
  assert.match(pin, /if \(turnAnchor \|\| isChatGestureScrolling\(\)\) \{ abandon\(\); return false; \}/,
    'a live turn anchor or a wheel gesture ends the jump instead of fighting it');
  const abandonAt = app.indexOf('  const abandon = () => {');
  assert.ok(abandonAt > 0 && abandonAt < pinAt, 'abandon() is declared before pin()');
});
