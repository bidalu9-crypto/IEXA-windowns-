'use strict';
// One real scheduled run: the saved prompt must reach the provider through the
// ordinary chat path, create its conversation, bind the chosen model and
// persist both sides of the exchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-scheduled-run-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, upstream, endpoint, token, baseURL;
const prompts = [];

function sse(content, finish) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: finish ? {} : { content }, finish_reason: finish ? 'stop' : null }], usage: finish ? { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } : undefined }) + '\n\n';
}

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      if (!request.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '定时任务' } }] }));
        return;
      }
      prompts.push(JSON.stringify(request.messages || []));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse('SCHEDULED_REPLY', false));
      setTimeout(() => { try { res.end(sse('', true) + 'data: [DONE]\n\n'); } catch { /* closed */ } }, 30);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + upstream.address().port;
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
  const profile = await fetch(endpoint + '/api/profiles', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'scheduled-profile', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-KEY',
      baseURL, contextWindow: 200000, maxOutputTokens: 1024, name: '定时模型',
    }),
  });
  assert.equal(profile.status, 200, await profile.text());
});

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const target of [server, upstream]) if (target) { target.closeAllConnections(); await new Promise((r) => target.close(r)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

const api = async (route, method = 'GET', data) => {
  const response = await fetch(endpoint + route, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const body = await response.json();
  return { status: response.status, body };
};

test('running a task creates its conversation and delivers the saved prompt', async () => {
  const created = await api('/api/scheduled-tasks', 'POST', {
    title: '每日巡检',
    prompt: 'SCHEDULED_PROMPT 检查未提交的改动',
    profileId: 'scheduled-profile',
    sessionMode: 'new',
    schedule: { frequency: 'daily', time: '09:00' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const task = created.body.task;
  assert.equal(task.title, '每日巡检');
  assert.equal(task.customTitle, true);
  assert.equal(task.scheduleLabel, '每天 09:00');
  assert.ok(task.nextRunAt > Date.now(), 'the next slot is in the future');

  const run = await api(`/api/scheduled-tasks/${task.id}/run`, 'POST', {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.task.lastStatus, 'ok', JSON.stringify(run.body.task));
  assert.equal(run.body.task.runCount, 1);
  assert.ok(run.body.task.lastSessionId, 'the run is attached to a conversation');

  assert.equal(prompts.length, 1, 'exactly one model call');
  assert.match(prompts[0], /SCHEDULED_PROMPT/, 'the saved prompt is what the model receives');

  const session = await api('/api/sessions/' + run.body.task.lastSessionId);
  const messages = Array.isArray(session.body) ? session.body : session.body.messages;
  const user = messages.find((message) => message.role === 'user');
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.match(user.content, /SCHEDULED_PROMPT/);
  assert.match(assistant.content, /SCHEDULED_REPLY/);

  const sessions = await api('/api/sessions');
  const stored = sessions.body.sessions.find((item) => item.id === run.body.task.lastSessionId);
  assert.equal(stored.title, '每日巡检', 'the new conversation is named after the task');
  assert.equal(stored.modelBinding.model, 'fixture-model');
});

test('an existing conversation is reused and rebound to the task model', async () => {
  const other = await api('/api/profiles', 'POST', {
    id: 'other-profile', provider: 'custom', model: 'other-model', apiKey: 'FIXTURE-KEY',
    baseURL, contextWindow: 200000, maxOutputTokens: 1024, name: '另一个模型',
  });
  assert.equal(other.status, 200, await other.status);
  const session = await api('/api/sessions', 'POST', {});
  const sessionId = session.body.session.id;

  const created = await api('/api/scheduled-tasks', 'POST', {
    prompt: 'REUSED_PROMPT 继续这个会话',
    profileId: 'scheduled-profile',
    sessionMode: 'existing',
    sessionId,
    schedule: { frequency: 'weekly', time: '18:30', weekday: 5 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const run = await api(`/api/scheduled-tasks/${created.body.task.id}/run`, 'POST', {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.task.lastSessionId, sessionId, 'the chosen conversation is reused');

  const sessions = await api('/api/sessions');
  const stored = sessions.body.sessions.find((item) => item.id === sessionId);
  assert.equal(stored.modelBinding.model, 'fixture-model', 'the conversation follows the task model');
  assert.notEqual(stored.title, '每日巡检', 'an existing conversation is not renamed after the task');
});

test('invalid schedules and unknown targets are rejected with a readable message', async () => {
  const badTime = await api('/api/scheduled-tasks', 'POST', {
    prompt: 'x', profileId: 'scheduled-profile', schedule: { frequency: 'daily', time: '99:99' },
  });
  assert.equal(badTime.status, 400);
  assert.match(badTime.body.error, /HH:mm/);

  const badProfile = await api('/api/scheduled-tasks', 'POST', {
    prompt: 'x', profileId: 'missing', schedule: { frequency: 'daily', time: '09:00' },
  });
  assert.equal(badProfile.status, 400);
  assert.match(badProfile.body.error, /模型/);

  const badSession = await api('/api/scheduled-tasks', 'POST', {
    prompt: 'x', profileId: 'scheduled-profile', sessionMode: 'existing', sessionId: 'sess_missing',
    schedule: { frequency: 'daily', time: '09:00' },
  });
  assert.equal(badSession.status, 400);
  assert.match(badSession.body.error, /会话/);
});

test('the schedule survives a restart and keeps its next slot', async () => {
  const created = await api('/api/scheduled-tasks', 'POST', {
    prompt: 'PERSIST_ME', profileId: 'scheduled-profile',
    schedule: { frequency: 'monthly', time: '07:15', dayOfMonth: 31 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const file = path.join(process.env.IEXA_WORKSPACE, '.iexa-scheduled-tasks.json');
  assert.ok(fs.existsSync(file), 'the schedule is written to disk');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const row = saved.tasks.find((task) => task.id === created.body.task.id);
  assert.equal(row.schedule.dayOfMonth, 31);
  assert.equal(row.nextRunAt, created.body.task.nextRunAt, 'restart math is deterministic');
});
