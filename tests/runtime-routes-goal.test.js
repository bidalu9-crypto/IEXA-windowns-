const test = require('node:test');
const assert = require('node:assert/strict');
const { handleRuntimeRoute } = require('../dist/main/api/RuntimeRoutes');

// The route layer only touches writeHead/end plus writableEnded/destroyed, so a
// recording stub is enough and keeps this test independent of a live server.
function fakeResponse() {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    destroyed: false,
    writeHead(status) { this.status = status; return this; },
    end(chunk) { this.body += chunk || ''; this.writableEnded = true; return this; },
  };
}

function context(overrides = {}) {
  return {
    agents: new Map(),
    permissionBroker: { list: () => [], resolve: () => false, cancelSession() {} },
    permissionPayload: (item) => item,
    questionBroker: { list: () => [], resolve: () => false, cancelSession() {} },
    questionPayload: (item) => item,
    getPermissionMode: () => 'risk',
    setPermissionMode() {},
    normalizePermissionMode: (value) => value,
    loadJobs: () => [],
    clearJobs: () => ({ removed: 0, remaining: 0 }),
    jobsRetention: { days: 7, perSession: 200, total: 500 },
    readTraces: () => [],
    cancelSession() {},
    clearRunningSession() {},
    cancelLiveJobs() {},
    getGoal: () => null,
    clearGoal: () => false,
    listShellSessions: () => [],
    closeShellSession: async () => ({ success: true, output: 'closed' }),
    ...overrides,
  };
}

async function route(method, path, ctx) {
  const url = new URL(`http://127.0.0.1:19840${path}`);
  const res = fakeResponse();
  const handled = await handleRuntimeRoute({ method, url }, res, url, ctx || context());
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test('goal route returns the stored objective and hides it for an empty session', async () => {
  const goal = { sessionId: 's1', objective: 'ship the split', doneWhen: 'tests green', status: 'active', notes: ['one'], createdAt: 1, updatedAt: 2 };
  const found = await route('GET', '/api/goal?sessionId=s1', context({ getGoal: (id) => (id === 's1' ? goal : null) }));
  assert.equal(found.handled, true);
  assert.equal(found.body.goal.objective, 'ship the split');
  assert.equal(found.body.goal.notes.length, 1);

  const empty = await route('GET', '/api/goal');
  assert.equal(empty.body.goal, null, 'no session id must not return a random goal');
});

test('goal delete reports whether a record existed', async () => {
  const removed = await route('DELETE', '/api/goal?sessionId=s1', context({ clearGoal: () => true }));
  assert.deepEqual(removed.body, { ok: true });

  const missing = await route('DELETE', '/api/goal?sessionId=ghost', context({ clearGoal: () => false }));
  assert.deepEqual(missing.body, { ok: false });
});

test('shell session routes list by conversation and require both ids to close', async () => {
  const sessions = [{ id: 'abc', shell: 'cmd', cwd: 'C:\\work', running: true, createdAt: 1 }];
  const listed = await route('GET', '/api/shell-sessions?sessionId=s1', context({ listShellSessions: (id) => (id === 's1' ? sessions : []) }));
  assert.equal(listed.body.sessions.length, 1);
  assert.equal(listed.body.sessions[0].shell, 'cmd');

  const noId = await route('DELETE', '/api/shell-sessions?sessionId=s1');
  assert.equal(noId.status, 400, 'a close without an id must not guess which tty to kill');

  let closed = null;
  const ok = await route('DELETE', '/api/shell-sessions?sessionId=s1&id=abc', context({
    closeShellSession: async (id, sessionId) => { closed = { id, sessionId }; return { success: true, output: 'closed' }; },
  }));
  assert.deepEqual(closed, { id: 'abc', sessionId: 's1' });
  assert.deepEqual(ok.body, { ok: true, message: 'closed' });

  const failed = await route('DELETE', '/api/shell-sessions?sessionId=s1&id=other', context({
    closeShellSession: async () => ({ success: false, output: '属于另一个对话' }),
  }));
  assert.equal(failed.status, 404);
  assert.equal(failed.body.ok, false);
});

test('unknown routes stay unhandled so the dispatcher can continue', async () => {
  const result = await route('GET', '/api/not-a-route');
  assert.equal(result.handled, false);
});
