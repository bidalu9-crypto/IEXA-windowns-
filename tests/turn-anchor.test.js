// Sending pins the prompt to the top of the viewport and the reply starts
// directly beneath it — the Codex desktop behaviour.
//
// The room needed comes from the transcript's own padding-bottom, which is set
// once on send. Nothing is adjusted while the reply streams: the prompt sits
// above the growing content, so its screen position is already constant. The
// first implementation rewrote that padding every frame to mirror the growth,
// which forced a layout read and two writes per token and made the message
// wobble by a pixel. `tests/browser-stream-jitter.test.js` measures the result.
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

test('the room comes from container padding, set exactly once', () => {
  const body = bodyOf('anchorTurnAtTop');
  assert.match(body, /const room = box\.height - 16 - rect\.height - 24/, 'room is measured');
  assert.match(body, /if \(room < 80\) return;/, 'a prompt that fills the viewport is not pinned');
  assert.match(body, /container\.style\.paddingBottom = \(base \+ room\) \+ 'px'/, 'padding lends the room');
  assert.match(body, /container\.scrollTop = Math\.max\(0, top - 16\)/, 'the prompt lands at the top');
  assert.doesNotMatch(body, /createElement\('div'\)/, 'no element is inserted into the flow');
  assert.doesNotMatch(css, /turn-anchor-spacer/, 'the spacer style is gone');
});

test('streaming performs no layout writes at all', () => {
  // The wobble was three passes per token: read scrollHeight, write padding,
  // clamp scrollTop. Any of those inside the per-frame path brings it back.
  assert.equal((helpers.match(/function shrinkTurnAnchor\(/g) || []).length, 0, 'the per-frame shrink is gone');
  const scroll = helpers.slice(helpers.indexOf('function scrollToBottom('));
  const head = scroll.slice(0, scroll.indexOf('requestAnimationFrame'));
  assert.match(head, /if \(turnAnchorHolds\(\)\) return;/, 'anchored frames return before writing');
  assert.match(head, /releaseTurnAnchorIfFull\(\);/, 'the single release point is explicit');

  // The only per-frame work while anchored is a single read.
  const holds = bodyOf('turnAnchorHolds');
  assert.match(holds, /return \(last\.getBoundingClientRect\(\)\.bottom - promptTop\) < turnAnchor\.room;/,
    'read-only comparison of the tail against the borrowed room');
  assert.doesNotMatch(holds, /paddingBottom\s*=|scrollTop\s*=/, 'the check never writes');
});

test('the padding is restored when the reply outgrows the room', () => {
  const restore = bodyOf('restoreTurnAnchorPadding');
  assert.match(restore, /container\.style\.paddingBottom = basePadding/, 'the base padding comes back');
  assert.match(helpers, /if \(!turnAnchor\.el\.isConnected \|\| !chatViewIsActive\(\)\) \{ restoreTurnAnchorPadding\(\); return false; \}/,
    'a detached prompt releases the anchor');
});

test('a manual scroll takes the viewport back', () => {
  assert.match(helpers, /addEventListener\('wheel', function \(event\) \{\s*clearTurnAnchor\(\);/, 'wheel clears it');
  assert.match(helpers, /pointerdown', \(\) => \{ clearTurnAnchor\(\);/, 'pointer clears it');
  assert.match(css, /overflow-anchor: none;/, 'the browser is told not to re-anchor behind our back');
});

test('the release path is wired to the same read the frame uses', () => {
  // releaseTurnAnchorIfFull must exist and force a real follow after releasing,
  // otherwise the transcript would stop scrolling once the reply fills the fold.
  assert.match(helpers, /function releaseTurnAnchorIfFull\(\)/, 'release helper exists');
  const release = bodyOf('releaseTurnAnchorIfFull');
  assert.match(release, /restoreTurnAnchorPadding\(\)/, 'returns the padding');
  assert.match(release, /isNearChatBottom = true/, 'hands the viewport back to follow-latest');
});
