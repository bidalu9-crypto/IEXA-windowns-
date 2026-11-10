'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { make, remove } = require('./helpers/temp-dir');
const directory = make('iexa-stop-endpoint-');
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const { AgentRuntime } = require('../dist/main/runtime/AgentRuntime');
const backend = require('../dist/main/server');
let server, upstream, endpoint, token;

async function api(route, method = 'GET', data) {
  const response = await fetch(endpoint + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
}
function chat(sessionId, message) {
  return fetch(endpoint + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, message }) }).then(async response => ({ status: response.status, text: await response.text() }));
}
test.before(async () => {
  upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      const input = JSON.parse(body || '{}');
      if (!input.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture title' } }] })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'NEXT_AFTER_PREPARE_CANCEL' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  server = await backend.startServer(0, false); endpoint = 'http://127.0.0.1:' + server.address().port; token = backend.getServerCredentials(server).token;
  await api('/api/profiles', 'POST', { id: 'stop-endpoint', provider: 'custom', model: 'fixture', apiKey: 'LOCAL-FIXTURE', baseURL: 'http://127.0.0.1:' + upstream.address().port, contextWindow: 200000, maxOutputTokens: 512 });
});
test.after(async () => {
  for (const target of [server, upstream]) if (target) { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
  remove(directory);
});

test('real HTTP cancellation during stalled initialize retains the fence, then cancels without resurrecting the old request', { timeout: 8000 }, async () => {
  const original = AgentRuntime.prototype.initialize; let enteredResolve, release, calls = 0;
  const entered = new Promise(resolve => enteredResolve = resolve), gate = new Promise(resolve => release = resolve);
  AgentRuntime.prototype.initialize = async function () { if (++calls === 1) { enteredResolve(); await gate; } return original.call(this); };
  try {
    const { session } = await api('/api/sessions', 'POST', {}), pending = chat(session.id, 'OLD_PREPARATION_REQUEST');
    await entered;
    const preparing = await api('/api/agent/state?sessionId=' + session.id);
    assert.equal(preparing.running, true); assert.equal(preparing.state.status, 'idle', 'runtime has not entered run yet; HTTP fence is the authority');
    const started = Date.now(), cancel = await api('/api/cancel?sessionId=' + session.id, 'POST', {});
    assert.equal(cancel.ok, true); assert.equal(cancel.settled, false, 'ACK does not prematurely free the request lock');
    const cancelled = await pending;
    assert.equal(cancelled.status, 200); assert.match(cancelled.text, /event: cancelled/); assert.ok(Date.now() - started < 500);
    assert.equal((await api('/api/agent/state?sessionId=' + session.id)).running, false);
    const next = await chat(session.id, 'NEW_REQUEST_AFTER_STOP');
    assert.equal(next.status, 200); assert.match(next.text, /NEXT_AFTER_PREPARE_CANCEL/); assert.match(next.text, /event: done/);
    release(); await new Promise(resolve => setImmediate(resolve));
    const state = await api('/api/agent/state?sessionId=' + session.id); assert.equal(state.running, false); assert.equal(state.state.status, 'completed');
    const saved = await api('/api/sessions/' + session.id);
    assert.doesNotMatch(JSON.stringify(saved), /OLD_PREPARATION_REQUEST/); assert.match(JSON.stringify(saved), /NEW_REQUEST_AFTER_STOP/);
  } finally { release(); AgentRuntime.prototype.initialize = original; }
});
