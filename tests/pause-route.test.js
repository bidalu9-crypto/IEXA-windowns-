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
      streamCalls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (streamCalls === 1) {
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

test('pause parks the turn and resume continues it', async () => {
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

  const chatResponse = await chat;
  assert.equal(chatResponse.status, 200);
  const reader = chatResponse.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let sawPaused = false;
  let sawDone = false;
  // Read until paused arrives; the response must stay open afterwards.
  while (!sawPaused) {
    const step = await reader.read();
    if (step.done) break;
    text += decoder.decode(step.value, { stream: true });
    sawPaused = text.includes('event: paused');
  }
  assert.equal(sawPaused, true, 'the renderer is told the turn is parked: ' + text.slice(0, 400));
  assert.equal(sawDone, false, 'a paused turn is not finished');

  const resumed = await fetch(endpoint + '/api/resume?sessionId=' + encodeURIComponent(session.id), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(resumed.status, 202, await resumed.text());

  while (!sawDone) {
    const step = await reader.read();
    if (step.done) break;
    text += decoder.decode(step.value, { stream: true });
    sawDone = text.includes('event: done');
  }
  assert.equal(sawDone, true, 'the resumed turn completed: ' + text.slice(-400));
  assert.equal(streamCalls, 2, 'resume made exactly one more model call');

  const payload = await api('/api/sessions/' + session.id);
  const messages = Array.isArray(payload) ? payload : payload.messages;
  const assistant = messages.filter((message) => message.role === 'assistant').pop();
  assert.ok(assistant, 'the turn was persisted');
  assert.match(assistant.content || '', /SECOND_HALF/, 'the resumed answer is what got saved');
  assert.equal(messages.filter((message) => message.role === 'user').length, 1,
    'resuming does not append a second user message');
});
