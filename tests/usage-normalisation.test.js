const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodeRollbacks } = require('../dist/main/session/RollbackStore.js');

test('legacy usage records lose the double-counted cache span on read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-usage-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions'), { recursive: true });
  const sessionId = 'legacy-usage';
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, title: 'legacy', created: 1, updated: 2, messageCount: 4 }],
  }));
  // Exactly what the old adapters wrote: prompt inclusive of the cached span.
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions', `${sessionId}.json`), JSON.stringify([
    { role: 'user', content: 'q', timestamp: 1 },
    { role: 'assistant', content: 'a', timestamp: 2, usage: { inputTokens: 659747, outputTokens: 737, cacheReadInputTokens: 659456 } },
    { role: 'assistant', content: 'b', timestamp: 3, usage: { inputTokens: 1200, outputTokens: 40 } },
    { role: 'assistant', content: 'c', timestamp: 4, usage: { inputTokens: 900, outputTokens: 8, cacheReadInputTokens: 300, inputTokensAreFresh: true } },
  ]));

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const port = server.address().port;
  const creds = backend.getServerCredentials(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
    headers: { cookie: `${creds.cookieName}=${creds.token}` },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  const usage = data.messages.filter((m) => m.usage).map((m) => m.usage);

  // 659,747 prompt with 659,456 cached leaves 291 fresh -> share is 100%, not 50%.
  assert.equal(usage[0].inputTokens, 291);
  assert.equal(usage[0].cacheReadInputTokens, 659456);
  assert.equal(Math.round(100 * usage[0].cacheReadInputTokens / (usage[0].inputTokens + usage[0].cacheReadInputTokens)), 100);

  // No cache figure: nothing to subtract, but the record is marked so it is
  // never re-examined.
  assert.equal(usage[1].inputTokens, 1200);
  assert.equal(usage[1].inputTokensAreFresh, true);

  // Already-normalised records are left untouched.
  assert.equal(usage[2].inputTokens, 900);
});
