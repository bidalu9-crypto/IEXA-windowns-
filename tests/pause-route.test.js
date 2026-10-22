'use strict';
// One real turn through the real server: pausing mid-stream must park the turn
// (no done, no cancel, response still open) and resuming must continue the same
// turn with a second model call, then persist a single finished answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-pause-route-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, upstream, endpoint, token;

let releaseFirst;
const firstInFlight = new Promise((resolve) => { releaseFirst = resolve; });
let streamCalls = 0;

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
      // Title generation also streams; only the agent turn carries tools.
      const isTurn = Array.isArray(request.tools) && request.tools.length > 0;
      if (isTurn) streamCalls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isTurn && streamCalls === 1) {
        // A long step: the user pauses while this is still open.
        res.write(sse('FIRST_HALF', false));
        releaseFirst();
        return; // deliberately never ends; the pause must break it
      }
      res.write(sse('SECOND_HALF', false));
      setTimeout(() => {
        try { res.end(sse('', true) + 'data: [DONE]\n\n'); } catch { /* closed */ }
      }, 30);
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
      id: 'pause-profile', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-KEY',
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

test('pause ends the turn on disk and continueTurn resumes it', async () => {
  const { session } = await api('/api/sessions', 'POST', {});

  const chat = fetch(endpoint + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, message: 'LONG_TASK' }),
  });

  await firstInFlight;
  const paused = await fetch(endpoint + '/api/pause?sessionId=' + encodeURIComponent(session.id), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(paused.status, 202, await paused.text());

  // Pause is terminal: the stream reports the pause and then closes. Keeping it
  // open was what stranded a parked turn whenever the window reloaded.
  const chatResponse = await chat;
  assert.equal(chatResponse.status, 200);
  const streamed = await chatResponse.text();
  assert.match(streamed, /event: paused/, 'the renderer learns the turn stopped: ' + streamed.slice(0, 300));
  assert.doesNotMatch(streamed, /event: done/, 'a paused turn is not finished');

  const afterPause = await api('/api/sessions/' + session.id);
  const pausedMessages = Array.isArray(afterPause) ? afterPause : afterPause.messages;
  const partial = pausedMessages.filter((message) => message.role === 'assistant').pop();
  assert.ok(partial, 'the partial turn is on disk');
  assert.equal(partial.status, 'paused', 'and it is marked paused');

  // Continuing is a new turn over that saved history, not a parked stream.
  const continued = await fetch(endpoint + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, message: '', continueTurn: true }),
  });
  assert.equal(continued.status, 200);
  const continuedText = await continued.text();
  assert.match(continuedText, /SECOND_HALF/, 'the model carried on: ' + continuedText.slice(-300));
  assert.match(continuedText, /event: done/);
  assert.equal(streamCalls, 2, 'continuing made exactly one more model call');

  const payload = await api('/api/sessions/' + session.id);
  const messages = Array.isArray(payload) ? payload : payload.messages;
  const assistant = messages.filter((message) => message.role === 'assistant').pop();
  assert.ok(assistant, 'the turn was persisted');
  assert.match(assistant.content || '', /SECOND_HALF/, 'the continued answer is what got saved');
  assert.equal(assistant.status, undefined, 'finishing clears the paused marker');
  assert.equal(messages.filter((message) => message.role === 'user').length, 1,
    'continuing does not append a second user message');
});
