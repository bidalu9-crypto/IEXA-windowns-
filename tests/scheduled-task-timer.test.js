'use strict';
// The real timer, not runNow: a saved task whose slot arrives while the app is
// running must fire by itself, deliver its prompt and roll to the next day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-scheduled-timer-'));
const workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const dueAt = Date.now() + 1500;
fs.writeFileSync(path.join(workspace, '.iexa-scheduled-tasks.json'), JSON.stringify({
  version: 1,
  tasks: [{
    id: 'task_timer', title: '到点自检', customTitle: true,
    prompt: 'TIMER_PROMPT 到点后自动执行',
    profileId: 'timer-profile', sessionMode: 'new',
    schedule: { frequency: 'daily', time: '09:00' },
    enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: dueAt, runCount: 0,
  }],
}, null, 2), 'utf8');
process.env.IEXA_WORKSPACE = workspace;
process.env.IEXA_SCHEDULER_TICK_MS = '100';

const backend = require('../dist/main/server');
let server, upstream, endpoint, token;
const prompts = [];

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
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'TIMER_DONE' }, finish_reason: null }] }) + '\n\n');
      setTimeout(() => {
        try {
          res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        } catch { /* closed */ }
      }, 20);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
  // The task is already loaded with a near-future slot; give it a model before
  // that slot arrives so the run can actually reach a provider.
  const profile = await fetch(endpoint + '/api/profiles', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'timer-profile', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-KEY',
      baseURL: 'http://127.0.0.1:' + upstream.address().port, contextWindow: 200000, maxOutputTokens: 512,
    }),
  });
  assert.equal(profile.status, 200, await profile.text());
});

test.after(async () => {
  for (const target of [server, upstream]) if (target) { target.closeAllConnections(); await new Promise((r) => target.close(r)); }
  delete process.env.IEXA_SCHEDULER_TICK_MS;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a due task fires on the timer, delivers its prompt and rolls forward', async () => {
  const deadline = Date.now() + 12000;
  let task = null;
  while (Date.now() < deadline) {
    const response = await fetch(endpoint + '/api/scheduled-tasks', { headers: { Authorization: 'Bearer ' + token } });
    const data = await response.json();
    task = data.tasks.find((item) => item.id === 'task_timer');
    if (task?.lastStatus === 'ok') break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  assert.equal(prompts.length, 1, 'the timer made exactly one model call');
  assert.match(prompts[0], /TIMER_PROMPT/, 'the saved prompt is what reached the provider');
  assert.ok(task, 'the task is still listed');
  assert.equal(task.lastStatus, 'ok', JSON.stringify(task));
  assert.equal(task.runCount, 1);
  assert.ok(task.lastSessionId, 'the run opened a conversation');
  assert.ok(task.nextRunAt > Date.now() + 60_000, 'the next slot rolled forward instead of repeating');

  const stored = JSON.parse(fs.readFileSync(path.join(workspace, '.iexa-scheduled-tasks.json'), 'utf8'));
  const saved = stored.tasks.find((item) => item.id === 'task_timer');
  assert.equal(saved.lastStatus, 'ok');
  assert.equal(saved.runCount, 1, 'the result is durable, not only in memory');
});
