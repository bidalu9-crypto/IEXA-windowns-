'use strict';
// The model could not previously create or delete Bots or scheduled tasks: both
// existed only as HTTP routes the UI called. These tools close that gap, and the
// checks here are about the *limits* on it, not just the happy path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-workspace-tools-'));
process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
const backend = require('../dist/main/server');
let server, upstream, base, token; const requests = [];

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => (data += c)); req.on('end', () => {
      const request = JSON.parse(data || '{}'); requests.push(request);
      const content = request.messages?.filter((m) => m.role === 'user').at(-1)?.content || '';
      const last = Array.isArray(content) ? content.map((p) => p.text || '').join('\n') : content;

      // Drive one tool call per prompt keyword, then answer once the tool result
      // comes back so the loop terminates like a real turn.
      const alreadyRan = request.messages?.some((m) => m.role === 'tool');
      let payload;
      if (!alreadyRan && typeof last === 'string' && last.includes('CREATE_BOT_LEGAL')) {
        payload = { tool_calls: [{ index: 0, id: 'c_create', type: 'function', function: { name: 'bot_create', arguments: JSON.stringify({ tool_title: '创建 Bot', name: '资料员', description: '整理资料', persona: '负责归纳事实', allowedTools: ['file_read', 'grep'] }) } }] };
      } else if (!alreadyRan && typeof last === 'string' && last.includes('CREATE_BOT_ESCALATE')) {
        payload = { tool_calls: [{ index: 0, id: 'c_esc', type: 'function', function: { name: 'bot_create', arguments: JSON.stringify({ tool_title: '越权创建', name: '危险 Bot', allowedTools: ['shell_execute'] }) } }] };
      } else if (!alreadyRan && typeof last === 'string' && last.includes('LIST_BOTS')) {
        payload = { tool_calls: [{ index: 0, id: 'c_list', type: 'function', function: { name: 'bot_list', arguments: JSON.stringify({ tool_title: '列出 Bot' }) } }] };
      } else if (!alreadyRan && typeof last === 'string' && last.includes('DELETE_BOT_NO_CONFIRM')) {
        payload = { tool_calls: [{ index: 0, id: 'c_del', type: 'function', function: { name: 'bot_delete', arguments: JSON.stringify({ tool_title: '删除 Bot', name: '资料员' }) } }] };
      } else if (!alreadyRan && typeof last === 'string' && last.includes('SCHEDULE_CREATE')) {
        payload = { tool_calls: [{ index: 0, id: 'c_sched', type: 'function', function: { name: 'schedule_create', arguments: JSON.stringify({ tool_title: '创建定时任务', prompt: '每天汇总一次新闻', title: '每日汇总', schedule: { frequency: 'daily', time: '09:00' } }) } }] };
      } else if (!alreadyRan && typeof last === 'string' && last.includes('SCHEDULE_ENABLE_NO_CONFIRM')) {
        const taskMatch = last.match(/TASKID=(\S+)/);
        payload = { tool_calls: [{ index: 0, id: 'c_en', type: 'function', function: { name: 'schedule_manage', arguments: JSON.stringify({ tool_title: '启用任务', taskId: taskMatch ? taskMatch[1].trim() : '', action: 'enable' }) } }] };
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (payload) {
        res.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: payload, finish_reason: null }] }) + '\n\n'
          + 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
      } else {
        res.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'DONE' }, finish_reason: null }] }) + '\n\n'
          + 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  server = await backend.startServer(0, false);
  base = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
  await api('/api/profiles', 'POST', {
    name: 'fixture', provider: 'openai', model: 'bot-model', apiKey: 'k',
    baseURL: 'http://127.0.0.1:' + upstream.address().port, apiMode: 'chat_completions',
  });
  // bot_delete and schedule_manage are honest about being destructive (risk
  // high), so they ask for approval. A headless test cannot click that dialog;
  // full-access mode is the documented way to run without the broker.
  // bot_delete and schedule_manage are honest about being destructive (risk
  // high), so they ask for approval. A headless test cannot click that dialog;
  // full-access mode is the documented way to run without the broker. The route
  // is PUT, not POST.
  await api('/api/permissions/mode', 'PUT', { mode: 'full' });
});
test.after(async () => {
  for (const s of [server, upstream]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function api(route, method = 'GET', data) {
  const res = await fetch(base + route, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  return { status: res.status, data: await res.json() };
}

/** Runs one chat turn and returns the tool results the loop actually executed. */
async function turn(message) {
  const session = await api('/api/sessions', 'POST', { title: 'tools' });
  const id = session.data.session.id;
  const res = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, message }),
  });
  assert.equal(res.status, 200);
  await res.text();
  // The tool result only shows up in the *next* request the loop sends, so look
  // for the request that actually carries a tool message rather than the last one.
  const withTools = requests.filter((r) => (r.messages || []).some((m) => m.role === 'tool'));
  const toolMessage = (withTools.at(-1)?.messages || []).filter((m) => m.role === 'tool').at(-1);
  return { text: String(toolMessage?.content ?? ''), sessionId: id };
}

test('the roster and schedule tools are advertised to the model', async () => {
  const { data } = await api('/api/bots/tools');
  const names = data.tools.map((tool) => tool.name);
  for (const name of ['bot_list', 'bot_create', 'bot_delete', 'schedule_list', 'schedule_create', 'schedule_manage']) {
    assert.ok(names.includes(name), 'advertised: ' + name);
  }
});

test('a Bot can be created through the tool, and it lands in the roster', async () => {
  const { text } = await turn('CREATE_BOT_LEGAL');
  assert.match(text, /已创建 Bot「资料员」/);
  const { data } = await api('/api/bots');
  const created = data.bots.find((bot) => bot.name === '资料员');
  assert.ok(created, 'the Bot exists after the tool call');
  assert.deepEqual(created.allowedTools, ['file_read', 'grep'], 'granted exactly what was asked');
  assert.ok(created.profileId, 'the current model was reused');
});

test('the grant ceiling is the caller allowlist, not the whole build', () => {
  // A restricted Bot must not be able to widen the fence by minting a more
  // powerful Bot. Checked on the executor directly, because on a normal session
  // the caller really does hold every tool and granting them is legitimate.
  const { BotStore } = require('../dist/main/bots/BotStore');
  const { BotTools } = require('../dist/main/tools/WorkspaceTools');
  const store = new BotStore(path.join(dir, 'ceiling'));
  const restricted = new BotTools(store, () => ['file_read'], () => 'p1');

  const refused = restricted.create({ name: '越权 Bot', allowedTools: ['shell_execute'] });
  assert.equal(refused.success, false);
  assert.match(refused.output, /当前不可授予：shell_execute/);
  assert.equal(store.list().length, 0, 'nothing was written');

  const allowed = restricted.create({ name: '合规 Bot', allowedTools: ['file_read'] });
  assert.equal(allowed.success, true, allowed.output);
  assert.deepEqual(store.list()[0].allowedTools, ['file_read']);
});

test('bot_list reports what exists without dumping personas', async () => {
  const { text } = await turn('LIST_BOTS');
  assert.match(text, /资料员/);
  assert.doesNotMatch(text, /负责归纳事实/, 'the persona body stays out of the transcript');
});

test('bot_delete refuses to act without confirm', async () => {
  const { text } = await turn('DELETE_BOT_NO_CONFIRM');
  assert.match(text, /确认请传 confirm: true/);
  const { data } = await api('/api/bots');
  assert.ok(data.bots.some((bot) => bot.name === '资料员'), 'still present');
});

test('a scheduled task is created disabled and needs a second call to enable', async () => {
  const created = await turn('SCHEDULE_CREATE');
  assert.match(created.text, /已创建定时任务/);
  assert.match(created.text, /未启用/, 'the tool says it is off: ' + created.text);

  const list = await api('/api/scheduled-tasks');
  const task = list.data.tasks.find((item) => item.title === '每日汇总');
  assert.ok(task, 'the task exists');
  assert.equal(task.enabled, false, 'disabled by default');
  assert.equal(task.schedule.frequency, 'daily');
  assert.equal(task.schedule.time, '09:00');

  const enabled = await turn('SCHEDULE_ENABLE_NO_CONFIRM TASKID=' + task.id);
  console.log('ENABLE_TEXT', JSON.stringify(enabled.text.slice(0, 300)), 'TASKID', task.id);
  assert.match(enabled.text, /确认请传 confirm: true/);
  const after = await api('/api/scheduled-tasks');
  assert.equal(after.data.tasks.find((item) => item.id === task.id).enabled, false, 'still disabled');
});
