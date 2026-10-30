// Guards for the transcript window. It used to be a mobile-only concession;
// a 200-message desktop history then painted itself top-to-bottom on every
// cold start, so every client now mounts one window and grafts older chunks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const sessionList = read('src/renderer/services/SessionList.js');

test('every client mounts one window of history', () => {
  assert.match(sessionList, /const MOBILE_HISTORY_INITIAL = 60;/);
  assert.match(sessionList, /const MOBILE_HISTORY_CHUNK = 40;/);
  assert.match(sessionList, /function mobileHistoryWindow\(\) \{\r?\n  return true;/,
    'the window is not gated on the mobile client any more');
});

test('a short history still starts at message zero', () => {
  assert.match(sessionList, /const startIndex = windowed \? Math\.max\(0, msgs\.length - MOBILE_HISTORY_INITIAL\) : 0;/);
  assert.match(sessionList, /for \(let messageIndex = startIndex; messageIndex < msgs\.length; messageIndex\+\+\)/);
  assert.match(sessionList, /targetRuntime\.historyRenderedCount = msgs\.length - startIndex;/);
});

test('the surface is hidden while a long window hydrates', () => {
  assert.match(sessionList, /const hydrating = windowed && startIndex > 0;/);
  assert.match(sessionList, /chatMessages\.classList\.add\('is-hydrating'\)/);
  assert.match(sessionList, /chatMessages\.classList\.remove\('is-hydrating'\)/);
  const css = read('src/renderer/styles/windowing.css');
  assert.match(css, /\.chat-messages\.is-hydrating \{ visibility: hidden; \}/);
});

test('the unmounted tail is reserved by a spacer', () => {
  assert.match(sessionList, /function updateHistorySpacer\(runtime\)/);
  assert.match(sessionList, /spacer\.style\.height = \(runtime\.historyStartIndex \* HISTORY_SPACER_ESTIMATE\) \+ "px";/);
  assert.match(sessionList, /updateHistorySpacer\(targetRuntime\);/);
  assert.match(sessionList, /updateHistorySpacer\(runtime\);/);
});

test('the per-message layout exists exactly once', () => {
  const definitions = sessionList.match(/function renderHistoryMessage\(/g) || [];
  assert.equal(definitions.length, 1, 'the window must not fork the message layout');
  const calls = sessionList.match(/renderHistoryMessage\(/g) || [];
  assert.ok(calls.length >= 3, 'definition plus both call sites, saw ' + calls.length);
});

test('prepending keeps the reader on the message they were reading', () => {
  assert.match(sessionList, /stopFollowingLatestMessage\(\);/, 'the follow-bottom request is cancelled first');
  assert.match(sessionList, /const anchorEl = live\.querySelector\('\.message'\);/,
    'the graft anchors on a real element, not an estimated height');
  assert.match(sessionList, /live\.scrollTop = previousTop \+ Math\.max\(0, anchorAfter - anchorTop\);/);
  assert.match(sessionList, /if \(sessionId !== visibleSessionId \|\| sessionId !== currentSessionId\) return;/,
    'a conversation switch aborts the graft');
  assert.match(sessionList, /const staging = document\.createElement\('div'\);/,
    'the chunk is built off-screen so addMessage cannot scroll the live transcript');
});

test('the affordance appears whenever earlier history exists', () => {
  assert.match(sessionList, /if \(!runtime \|\| runtime\.historyStartIndex <= 0\) return;/);
  const css = read('src/renderer/styles/transcript.css');
  assert.match(css, /^\.load-earlier-messages \{/m, 'the style is shared, not phone-scoped');
  assert.doesNotMatch(css, /body\[data-mobile-client="paired"\] \.load-earlier-messages/);
});

test('a new message keeps the conversation index, not the window length', () => {
  const helpers = read('src/renderer/services/UiHelpers.js');
  assert.match(helpers, /function transcriptNextIndex\(consume\)/);
  assert.match(helpers, /: transcriptNextIndex\(true\);/);
  assert.match(sessionList, /targetRuntime\.historyTotal = msgs\.length;/);
});

test('the fix does not reload or re-navigate the page', () => {
  assert.doesNotMatch(sessionList, /location\.reload\(/);
  // The pairing retry is the only reload in the renderer, and it is user-driven.
  const bridges = read('src/renderer/services/MobileBridge.js');
  assert.match(bridges, /retry\.onclick = \(\) => location\.reload\(\);/);
});
