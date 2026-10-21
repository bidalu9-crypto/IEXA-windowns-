// The HTTP surface of /api/usage/insights. The workspace has to be pointed at a
// throwaway directory *before* the server module is required: the module resolves
// its paths once at load time, and a later assignment would leave runtime state
// in the repository root.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-insights-route-'));
process.env.IEXA_WORKSPACE = root;

const dir = path.join(root, '.iexa-sessions');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'sess_route.json'), JSON.stringify({
  messages: [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant', content: 'done', timestamp: Date.now(),
      usage: { inputTokens: 2000, outputTokens: 200, cacheReadInputTokens: 1500 },
      durationMs: 5000, generationMs: 2000, firstTokenMs: 1000, toolCalls: [],
    },
  ],
}, null, 2));
fs.writeFileSync(path.join(root, '.iexa-sessions.json'), JSON.stringify({
  sessions: [{ id: 'sess_route', title: 'Route fixture', created: Date.now(), updated: Date.now(), messageCount: 2 }],
  activeSessionId: 'sess_route',
}, null, 2));

const backend = require('../dist/main/server');

test('GET /api/usage/insights serves the payload', async (t) => {
  const server = await backend.startServer(0, false);
  const base = 'http://127.0.0.1:' + server.address().port;
  const token = backend.getServerCredentials(server).token;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ok = await fetch(base + '/api/usage/insights?range=7d', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.equal(payload.range, '7d');
  assert.equal(payload.totals.turns, 1);
  assert.equal(payload.totals.inputTokens, 2000);
  assert.equal(payload.sessions[0].title, 'Route fixture');

  const fallback = await fetch(base + '/api/usage/insights?range=forever', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal((await fallback.json()).range, '7d', 'an unknown range falls back instead of erroring');

  const post = await fetch(base + '/api/usage/insights', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(post.status, 405);
  assert.deepEqual(await post.json(), { error: 'method_not_allowed' });
});
