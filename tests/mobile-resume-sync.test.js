'use strict';
// A phone that leaves the foreground loses the SSE stream, so the terminal
// `done` frame never arrives and isProcessing stays true forever. Every later
// rebuild is then skipped and the transcript freezes. The session list carries
// the server's own run flag; these tests pin the reconciliation against it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { functions } = require('./helpers/transcript-harness.cjs');

function setup(t, sessionPayload) {
  const dom = new JSDOM('<body><div id="messages"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const calls = { setProcessing: [], pendingAtCall: [], refresh: 0 };

  Object.assign(w, {
    API_BASE: '',
    currentSessionId: 'live-1',
    visibleSessionId: 'live-1',
    isProcessing: true,
    sessionsCache: [],
    sessionRuntimes: new Map([['live-1', { isProcessing: true, isMirroredTurn: true }]]),
    sessionSyncInFlight: false,
    queuedSessionSync: false,
    queuedSessionSyncSessionId: '',
    pendingCurrentSessionSync: false,
    sessionSyncSnapshot: new Map(),
    sessionVersion: () => 'v1',
    rememberSessionVersions: () => {},
    renderSessionList: () => {},
    countRenderedMessages: () => 0,
    scrollHistoryToLatest: () => {},
    setProcessing: (value) => {
      calls.setProcessing.push(value);
      // The real implementation consumes this flag and schedules the forced
      // reload; record what it was handed so the test can prove the wiring.
      calls.pendingAtCall.push(w.pendingCurrentSessionSync === true);
      w.isProcessing = value;
      const runtime = w.sessionRuntimes.get('live-1');
      if (runtime) runtime.isProcessing = value;
    },
    refreshCurrentSessionHistory: async () => { calls.refresh += 1; },
    fetch: async () => ({ ok: true, json: async () => sessionPayload }),
  });

  w.eval(functions(['syncConversationMetadata']));
  return { w, calls };
}

test('a session the server reports as finished clears a stuck isProcessing and queues the reload', async (t) => {
  const { w, calls } = setup(t, {
    sessions: [{ id: 'live-1', title: 'x', messageCount: 3, updated: 2, running: false }],
    activeSessionId: 'live-1',
  });

  await w.syncConversationMetadata(false);

  assert.deepEqual(calls.setProcessing, [false], 'isProcessing must be released');
  // The reload is scheduled through setProcessing, which the real code wires to
  // a forced sync. Proving the flag was set is the closest a mock can get.
  assert.deepEqual(calls.pendingAtCall, [true], 'the reload must be queued before releasing');
  assert.equal(w.isProcessing, false);
});

test('a session the server reports as running keeps its mirror state', async (t) => {
  const { w, calls } = setup(t, {
    sessions: [{ id: 'live-1', title: 'x', messageCount: 3, updated: 2, running: true }],
    activeSessionId: 'live-1',
  });

  await w.syncConversationMetadata(false);

  assert.deepEqual(calls.setProcessing, [], 'a running turn must not be touched');
  assert.equal(w.isProcessing, true);
});

test('an older server without the flag is not mistaken for a finished turn', async (t) => {
  const { w, calls } = setup(t, {
    sessions: [{ id: 'live-1', title: 'x', messageCount: 3, updated: 2 }],
    activeSessionId: 'live-1',
  });

  await w.syncConversationMetadata(false);

  assert.deepEqual(calls.setProcessing, [], 'a missing flag must never reset a live turn');
  assert.equal(w.isProcessing, true);
});
