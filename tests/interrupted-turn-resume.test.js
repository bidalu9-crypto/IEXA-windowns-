'use strict';
// A turn that was paused and then killed by a restart must survive on disk and
// continue from the exact step it stopped at — not restart from the user message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-interrupted-'));
const workspace = path.join(directory, 'workspace');
const sessionId = 'sess_interrupted';
const startedAt = Date.now() - 60_000;

fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
  sessions: [{
    id: sessionId, title: '修登录页', titleSource: 'message',
    created: startedAt, updated: startedAt, messageCount: 2, projectRoot: '', projectName: '无项目',
  }],
}, null, 2), 'utf8');
// Exactly what a pause writes: the user message plus a partial assistant turn
// carrying the finished tool call and its result.
fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${sessionId}.json`), JSON.stringify([
  { role: 'user', content: '修一下登录页', timestamp: startedAt },
  {
    role: 'assistant',
    content: '我先看一下文件。',
    thinking: '需要先读登录页。',
    status: 'running',
    timestamp: startedAt + 1000,
    toolCalls: [{
      id: 'call_1', name: 'file_read', args: { path: 'login.html' },
      result: { output: 'LOGIN_PAGE_BODY', success: true },
    }],
    usage: { inputTokens: 1200, outputTokens: 40 },
  },
], null, 2), 'utf8');
process.env.IEXA_WORKSPACE = workspace;

const backend = require('../dist/main/server');
let server, upstream, endpoint, token;
const seen = [];

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
        res.end(JSON.stringify({ choices: [{ message: { content: '标题' } }] }));
        return;
      }
      seen.push(request);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse('继续完成。', false));
      setTimeout(() => { try { res.end(sse('', true) + 'data: [DONE]\n\n'); } catch { /* closed */ } }, 30);
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
      id: 'resume-profile', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-KEY',
      baseURL: 'http://127.0.0.1:' + upstream.address().port + '/v1', contextWindow: 200000, maxOutputTokens: 512,
    }),
  });
  assert.equal(profile.status, 200, await profile.text());
  await fetch(endpoint + `/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelBinding: { profileId: 'resume-profile', provider: 'custom', model: 'fixture-model', contextWindow: 200000 } }),
  });
});

test.after(async () => {
  for (const target of [server, upstream]) if (target) { target.closeAllConnections(); await new Promise((r) => target.close(r)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a turn left running by a killed process is marked interrupted on boot', async () => {
  const response = await fetch(endpoint + `/api/sessions/${sessionId}`, { headers: { Authorization: 'Bearer ' + token } });
  const payload = await response.json();
  const messages = Array.isArray(payload) ? payload : payload.messages;
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.status, 'interrupted', JSON.stringify(assistant).slice(0, 300));
  assert.equal(assistant.toolCalls.length, 1, 'the finished tool call survives the restart');
});

test('continuing replays the tool result and replaces the partial reply', async () => {
  const response = await fetch(endpoint + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, continueTurn: true }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const streamed = await response.text();
  assert.match(streamed, /继续完成。/, streamed.slice(0, 400));

  // Title generation also streams; the turn request is the one that replays the
  // conversation.
  // Title generation also streams (with the user message), so the turn request
  // is the one that carries the tool schema.
  const turnCalls = seen.filter((request) => Array.isArray(request.tools) && request.tools.length > 0);
  assert.equal(turnCalls.length, 1, 'exactly one turn call: ' + seen.length + ' stream(s) total');
  const turnBody = JSON.stringify(turnCalls[0].messages || []);
  assert.match(turnBody, /LOGIN_PAGE_BODY/, 'the model sees the completed tool result');
  assert.match(turnBody, /我先看一下文件。/, 'and the prose it already wrote');

  const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.iexa-sessions', `${sessionId}.json`), 'utf8'));
  const assistants = saved.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, 'the continuation replaces the partial turn, it does not append a second one');
  assert.equal(assistants[0].content, '我先看一下文件。继续完成。', 'the reply keeps what was already streamed');
  assert.equal(assistants[0].toolCalls.length, 1, 'the finished tool call is preserved');
  assert.equal(assistants[0].status, undefined, 'the finished turn is no longer marked unfinished');
  assert.equal(saved.filter((m) => m.role === 'user').length, 1, 'no duplicate user message');
});
