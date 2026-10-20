'use strict';
// One real turn through the real server: a steer posted while the first model
// completion is still streaming must reach the same turn, produce a second
// model call, and persist in the user's original position.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-steer-route-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, upstream, endpoint, token;

let firstCallStarted;
const firstCallReached = new Promise((resolve) => { firstCallStarted = resolve; });
let releaseFirst;
const firstCallRelease = new Promise((resolve) => { releaseFirst = resolve; });
let streamCalls = 0;
let steerCalls = 0;

function sse(content, finish) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: finish ? {} : { content }, finish_reason: finish ? 'stop' : null }] }) + '\n\n';
}

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      if (!request.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture title' } }] }));
        return;
      }
      streamCalls++;
      const hasSteer = JSON.stringify(request.messages || []).includes('STEER_MARK');
      if (hasSteer) steerCalls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (hasSteer) {
        res.end(sse('STEERED_RESPONSE', false) + sse('', true) + 'data: [DONE]\n\n');
        return;
      }
      res.write(sse('FIRST_RESPONSE', false));
      firstCallStarted();
      firstCallRelease.then(() => {
        res.end(sse('', true) + 'data: [DONE]\n\n');
      });
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseURL = 'http://127.0.0.1:' + upstream.address().port;
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;

  const profile = await fetch(endpoint + '/api/profiles', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'steer-profile', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-KEY',
      baseURL, contextWindow: 200000, maxOutputTokens: 1024,
    }),
  });
  assert.equal(profile.status, 200, await profile.text());
});

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
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

test('a steer joins the in-flight turn and survives a reload', async () => {
  const { session } = await api('/api/sessions', 'POST', {});

  const chat = fetch(endpoint + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, message: 'ORIGINAL_PROMPT' }),
  });

  // Wait until the first completion is genuinely in flight, then steer.
  await firstCallReached;
  const steerResponse = await fetch(endpoint + '/api/steer', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, steerId: 'steer-test-1', message: 'STEER_MARK go left' }),
  });
  assert.equal(steerResponse.status, 202, await steerResponse.text());

  releaseFirst();
  const streamed = await (await chat).text();
  assert.match(streamed, /FIRST_RESPONSE/, streamed);
  assert.match(streamed, /steer_applied/, 'the renderer must learn the steer landed');
  assert.match(streamed, /STEERED_RESPONSE/, 'the same turn must answer the steer');

  const payload = await api('/api/sessions/' + session.id);
  const messages = Array.isArray(payload) ? payload : payload.messages;
  const steered = messages.find((message) => message.role === 'user' && message.content === 'STEER_MARK go left');
  assert.ok(steered, 'the steer is persisted: ' + JSON.stringify(messages).slice(0, 400));
  assert.equal(steered.steered, true);
  assert.ok(
    messages.indexOf(steered) > messages.findIndex((message) => message.content === 'ORIGINAL_PROMPT'),
    'the steer stays after the opening prompt',
  );
  assert.equal(steerCalls, 1, 'exactly one extra model step carried the steer');
});

test('a steer without a live turn is rejected instead of buffered', async () => {
  const { session } = await api('/api/sessions', 'POST', {});
  const response = await fetch(endpoint + '/api/steer', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, steerId: 'steer-idle', message: 'IDLE_STEER' }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'turn_not_running' });
});
