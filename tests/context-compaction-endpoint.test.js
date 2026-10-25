// The ring prints the threshold the server reports. Saving a new trigger must
// reach the *running* session's loop, not just the settings file: a live
// conversation keeps its AgentLoop, so a ratio captured at construction would
// keep the ring at 80% forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-compaction-endpoint-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, upstream, endpoint, token;

function sse(content, finish) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: finish ? {} : { content }, finish_reason: finish ? 'stop' : null }] }) + '\n\n';
}

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      if (!request.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'fixture' } }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse('ok', false));
      res.end(sse('', true) + 'data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
  const profile = await fetch(endpoint + '/api/profiles', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'compaction-endpoint', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-KEY',
      baseURL: 'http://127.0.0.1:' + upstream.address().port, contextWindow: 200000, maxOutputTokens: 512,
    }),
  });
  assert.equal(profile.status, 200, await profile.text());
});

test.after(async () => {
  for (const target of [server, upstream]) if (target) { target.closeAllConnections(); await new Promise((r) => target.close(r)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function api(route, method = 'GET', data) {
  const response = await fetch(endpoint + route, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

/** Run one turn and return the last context payload the server announced. */
async function thresholdOfTurn(sessionId) {
  const response = await fetch(endpoint + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message: 'measure the threshold' }),
  });
  const streamed = await response.text();
  const contexts = [...streamed.matchAll(/event: context\ndata: (\{[^\n]*\})/g)].map((match) => JSON.parse(match[1]));
  assert.ok(contexts.length > 0, 'the turn announced its context: ' + streamed.slice(0, 400));
  return contexts.at(-1);
}

test('a saved trigger reaches the session that is already open', async () => {
  const { session } = await api('/api/sessions', 'POST', {});

  // First turn builds the AgentLoop with the default 80%.
  const first = await thresholdOfTurn(session.id);
  assert.equal(first.contextWindow, 200000);
  assert.equal(first.compactThreshold, 160000, 'default 80% of the window');

  // The user saves 90% while that session's loop is still cached.
  const saved = await api('/api/context-compaction', 'PUT', { contextCompactionThreshold: 0.9 });
  assert.equal(saved.contextCompactionThreshold, 0.9);

  // The next turn must report 90%, not the ratio the loop was built with.
  const second = await thresholdOfTurn(session.id);
  assert.equal(second.compactThreshold, 180000,
    'the ring reads this number; a stale 160000 is exactly the "still 80%" bug');

  // And clearing it returns to the default.
  await api('/api/context-compaction', 'PUT', { contextCompactionThreshold: null });
  const third = await thresholdOfTurn(session.id);
  assert.equal(third.compactThreshold, 160000, 'clearing restores 80%');
});
