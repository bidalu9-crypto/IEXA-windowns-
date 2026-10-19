const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The server reads IEXA_WORKSPACE once at import time, so this case lives in its
// own file: node --test gives every file a fresh module registry.
test('the token usage aggregate is corrected once and only once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-usage-agg-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-token-usage.json'), JSON.stringify([{
    key: 'openai:m:p', provider: 'openai', model: 'm', profileName: 'p',
    inputTokens: 481608890, outputTokens: 12, cacheCreationInputTokens: 0, cacheReadInputTokens: 398963456,
    requests: 9, estimatedCostUsd: null, updatedAt: 1,
  }]));

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const port = server.address().port;
  const creds = backend.getServerCredentials(server);
  const read = async () => (await (await fetch(`http://127.0.0.1:${port}/api/token-usage`, {
    headers: { cookie: `${creds.cookieName}=${creds.token}` },
  })).json()).records[0];

  const first = await read();
  assert.equal(first.inputTokens, 481608890 - 398963456);
  assert.equal(first.cacheReadInputTokens, 398963456);

  const second = await read();
  assert.equal(second.inputTokens, first.inputTokens, 'a second read must not subtract again');
});
