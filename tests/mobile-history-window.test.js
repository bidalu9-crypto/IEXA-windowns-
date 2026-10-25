// Guards for the mobile-only transcript window. The risk this protects against
// is scope creep: the phone fix must never change what the desktop path renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const sessionList = read('src/renderer/services/SessionList.js');

test('the window is gated on the paired mobile client, not on viewport width', () => {
  assert.match(sessionList, /const MOBILE_HISTORY_INITIAL = 60;/);
  assert.match(sessionList, /const MOBILE_HISTORY_CHUNK = 40;/);
  assert.match(sessionList, /document\.body\.dataset\.mobileClient === 'paired'/,
    'a narrow desktop window must not opt into the mobile transcript');
  assert.doesNotMatch(sessionList, /matchMedia\('\(max-width/,
    'width is not the mobile signal');
});

test('desktop still starts at message zero and renders the whole history', () => {
  assert.match(sessionList, /const startIndex = windowed \? Math\.max\(0, msgs\.length - MOBILE_HISTORY_INITIAL\) : 0;/);
  assert.match(sessionList, /for \(let messageIndex = startIndex; messageIndex < msgs\.length; messageIndex\+\+\)/);
  // The rendered count must describe the DOM, not the payload.
  assert.match(sessionList, /targetRuntime\.historyRenderedCount = msgs\.length - startIndex;/);
});

test('the per-message layout exists exactly once', () => {
  const definitions = sessionList.match(/function renderHistoryMessage\(/g) || [];
  assert.equal(definitions.length, 1, 'the window must not fork the message layout');
  // Both the initial loop and the prepend path go through it.
  const calls = sessionList.match(/renderHistoryMessage\(/g) || [];
  assert.ok(calls.length >= 3, 'definition plus both call sites, saw ' + calls.length);
});

test('prepending keeps the reader in place and never follows the newest message', () => {
  assert.match(sessionList, /stopFollowingLatestMessage\(\);/, 'the follow-bottom request is cancelled first');
  assert.match(sessionList, /live\.scrollTop = previousTop \+ \(live\.scrollHeight - previousHeight\);/,
    'the position is restored by the height that was added above');
  assert.match(sessionList, /if \(sessionId !== visibleSessionId \|\| sessionId !== currentSessionId\) return;/,
    'a conversation switch aborts the graft');
  assert.match(sessionList, /const staging = document\.createElement\('div'\);/,
    'the chunk is built off-screen so addMessage cannot scroll the live transcript');
});

test('the affordance is mobile-only and carries no history it cannot show', () => {
  assert.match(sessionList, /if \(!mobileHistoryWindow\(\) \|\| !runtime \|\| runtime\.historyStartIndex <= 0\) return;/);
  assert.match(sessionList, /chatMessages\.insertBefore\(button, chatMessages\.firstChild\);/);
  const css = read('src/renderer/styles/transcript.css');
  const block = css.slice(css.indexOf('.load-earlier-messages'));
  assert.match(block, /^body\[data-mobile-client="paired"\]/m, 'the style is scoped to the phone client');
  assert.doesNotMatch(css, /^\.load-earlier-messages/m, 'no unscoped rule can leak into the desktop cascade');
});

test('the fix does not reload or re-navigate the page', () => {
  assert.doesNotMatch(sessionList, /location\.reload\(/);
  // The pairing retry is the only reload in the renderer, and it is user-driven.
  const bridges = read('src/renderer/services/MobileBridge.js');
  assert.match(bridges, /retry\.onclick = \(\) => location\.reload\(\);/);
});
