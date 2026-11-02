'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-native-bots-'));
process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
const backend = require('../dist/main/server');
const { BotStore, botSoul } = require('../dist/main/bots/BotStore');
let server, upstream, base, token, url; const requests = [];
test.before(async () => {
  upstream = http.createServer((req, res) => {
    let data = ''; req.on('data', c => data += c); req.on('end', () => {
      const request = JSON.parse(data || '{}'); requests.push(request);
      const content = request.messages?.filter(m => m.role === 'user').at(-1)?.content || '';
      const last = Array.isArray(content) ? content.map(p => p.text || '').join('\n') : content;
      let answer = 'BOT_NATIVE_OK';
      if (typeof last === 'string' && last.includes('选定 Bot：')) {
        const bots = JSON.parse(last.split('选定 Bot：\n')[1]);
        answer = JSON.stringify({ tasks: bots.map((bot, i) => ({ botId: bot.botId, instruction: '任务' + i })) });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  url = 'http://127.0.0.1:' + upstream.address().port;
  server = await backend.startServer(0, false); base = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
});
test.after(async () => { for (const s of [server, upstream]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function api(route, method = 'GET', data) {
  const res = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { status: res.status, data: await res.json() };
}
test('Bot store validates, persists and separates memory paths', () => {
  const store = new BotStore(path.join(dir, 'unit'));
  const a = store.save({ name: 'A', profileId: 'p', persona: 'A-PERSONA', memory: 'A-MEMORY' });
  const b = store.save({ name: 'B', profileId: 'p', persona: 'B-PERSONA' });
  assert.equal(new BotStore(store.root).get(a.id).name, 'A');
  assert.notEqual(store.memoryDir(a.id), store.memoryDir(b.id));
  assert.throws(() => store.memoryDir('../x'));
  const soul = botSoul({ metadata: { name: 'IEXA', style: '', lang: 'auto' }, body: 'BASE' }, a);
  assert.equal(soul.metadata.name, 'A'); assert.match(soul.body, /A-MEMORY/); assert.doesNotMatch(soul.body, /B-PERSONA/);
});
test('native API creates Bot chat and actual provider request carries its identity', async () => {
  assert.equal((await fetch(base + '/api/bots')).status, 401);
  const p = await api('/api/profiles', 'POST', { id: 'bot-model', name: 'Fixture', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE', baseURL: url });
  assert.equal(p.status, 200);
  assert.equal((await api('/api/bots', 'POST', { name: 'bad', profileId: 'missing' })).status, 400);
  const made = await api('/api/bots', 'POST', { name: '研究员', profileId: 'bot-model', persona: 'NATIVE_PERSONA_SENTINEL', memory: 'NATIVE_MEMORY_SENTINEL' });
  assert.equal(made.status, 200); const bot = made.data.bot;
  const opened = await api('/api/bots/' + bot.id + '/chat', 'POST', {});
  assert.equal(opened.status, 200); const session = opened.data.session;
  assert.equal(session.botId, bot.id); assert.equal(session.modelBinding.profileId, 'bot-model');
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, message: 'Hello' }) });
  const stream = await res.text(); assert.equal(res.status, 200); assert.match(stream, /BOT_NATIVE_OK/);
  const sent = requests.find(r => Array.isArray(r.messages)); assert.ok(sent, 'real provider HTTP request observed');
  const prompt = JSON.stringify(sent.messages.filter(m => m.role === 'system' || m.role === 'developer'));
  assert.match(prompt, /NATIVE_PERSONA_SENTINEL/); assert.match(prompt, /NATIVE_MEMORY_SENTINEL/);
  assert.match(prompt, /研究员/);
  const update = await api('/api/bots/' + bot.id, 'PUT', { name: '研究员二', memory: 'NEW_MEMORY' }); assert.equal(update.status, 200);
  assert.equal((await api('/api/bots')).data.bots[0].memory, 'NEW_MEMORY');
  const other = (await api('/api/bots', 'POST', { name: '另一个Bot', profileId: 'bot-model', persona: 'OTHER_PERSONA' })).data.bot;
  const otherSession = (await api('/api/bots/' + other.id + '/chat', 'POST', {})).data.session;
  const otherRes = await fetch(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: otherSession.id, message: 'Hello second bot' }) });
  assert.match(await otherRes.text(), /BOT_NATIVE_OK/);
  const otherPrompt = JSON.stringify(requests.at(-1).messages.filter(m => m.role === 'system' || m.role === 'developer'));
  assert.match(otherPrompt, /OTHER_PERSONA/); assert.doesNotMatch(otherPrompt, /NATIVE_PERSONA_SENTINEL|NATIVE_MEMORY_SENTINEL|NEW_MEMORY/);
  assert.equal((await api('/api/bots/' + bot.id, 'DELETE')).status, 200);
  assert.equal((await api('/api/sessions/' + session.id)).status, 200, 'history retained after deleting Bot');
  const deletedRes = await fetch(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, message: 'Must not execute' }) });
  assert.equal(deletedRes.status, 409); await deletedRes.text();
});

test('native catalog/import/export and model-planned team complete via actual AgentRuntime', async () => {
  const catalog = await api('/api/bots/catalog'); assert.equal(catalog.status, 200);
  const converted = await api('/api/bots/convert-tobs', 'POST', { descriptor: { name: 'Tobs 转换', bio: '市场描述', tags: ['research'] }, persona: '来自明确提供的SOUL文本' });
  assert.equal(converted.status, 200); assert.equal(converted.data.package.bot.persona, '来自明确提供的SOUL文本');
  assert.deepEqual(converted.data.package.bot.allowedTools, []); assert.equal(converted.data.package.bot.memory, undefined);
  assert.equal((await api('/api/bots/import', 'POST', { package: { format: 'dsh', version: 1 }, profileId: 'bot-model' })).status, 400);
  const bots = [];
  for (const pkg of catalog.data.packages) {
    const imported = await api('/api/bots/import', 'POST', { package: pkg, profileId: 'bot-model' });
    assert.equal(imported.status, 200); bots.push(imported.data.bot);
  }
  const exported = await api('/api/bots/' + bots[0].id + '/export');
  assert.equal(exported.data.format, 'iexa-bot'); assert.equal(exported.data.bot.profileId, undefined); assert.equal(exported.data.bot.memory, undefined);
  const before = requests.length;
  const started = await api('/api/bot-teams', 'POST', { goal: '整理并审核测试资料', botIds: bots.map(b => b.id) });
  assert.equal(started.status, 200); const id = started.data.team.id;
  let team;
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 20));
    team = (await api('/api/bot-teams')).data.teams.find(t => t.id === id);
    if (!['planning', 'running', 'cancelling'].includes(team.status)) break;
  }
  assert.equal(team.status, 'completed', team.error);
  assert.equal(team.tasks.length, 2); assert.ok(team.tasks.every(t => t.result === 'BOT_NATIVE_OK' && t.sessionId));
  const calls = requests.slice(before); assert.equal(calls.length, 3, 'one planner call plus two worker calls');
  assert.ok(calls.every(c => !c.tools || c.tools.length === 0), 'chat-only Bots and planner publish no tools');
  assert.match(JSON.stringify(calls[2].messages), /BOT_NATIVE_OK/, 'second worker receives first result');
});

test('disallowed file tool is denied at executor boundary, not just hidden in definitions', async () => {
  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
  const runtime = new ToolRuntime({ workspaceDir: process.env.IEXA_WORKSPACE, memoryDir: path.join(dir, 'tool-memory'), permissionMode: 'full' });
  runtime.registerDefaults(); await runtime.initialize(); runtime.beginRun(['file_read']);
  const output = await runtime.execute('file_write', { path: path.join(process.env.IEXA_WORKSPACE, 'forbidden.txt'), content: 'blocked', tool_title: 'Attempt forbidden write' }, { sessionId: 'test', toolCallId: 'blocked', signal: new AbortController().signal });
  assert.equal(output.success, false);
  assert.match(output.output, /not available/);
  assert.equal(fs.existsSync(path.join(process.env.IEXA_WORKSPACE, 'forbidden.txt')), false);
});
