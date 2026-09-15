const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { JSDOM } = require('jsdom');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-project-settings-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, upstream, endpoint, token, baseURL;
const calls = [];
let a = path.join(directory, 'project-a'), b = path.join(directory, 'project-b');
const scope = { targets: ['http://127.0.0.1:3000'], operations: ['只读检查'], notes: 'SCOPE_A_MARKER' };
test.before(async () => {
  fs.mkdirSync(a); fs.mkdirSync(b);
  a = fs.realpathSync.native(a); b = fs.realpathSync.native(b);
  upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const request = JSON.parse(body); calls.push(request);
      if (!request.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture title' } }] })); return; }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Fixture response' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + upstream.address().port;
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
});
test.after(async () => {
  // Server job writes are debounced by 150 ms; let this fixture finish them before removing its workspace.
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const s of [server, upstream]) if (s) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true });
});
async function api(route, method = 'GET', data, status = 200) {
  const response = await fetch(endpoint + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
}
async function chat(sessionId) {
  const response = await fetch(endpoint + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, message: 'NORMAL_TASK FIXTURE-PRIVATE-KEY' }) });
  assert.equal(response.status, 200);
  const result = await response.text(); assert.match(result, /Fixture response/); return result;
}
test('authenticated scope API isolates projects and rejects stale writes; preview requires an existing session', async () => {
  assert.equal((await fetch(endpoint + '/api/project/scope')).status, 401);
  assert.equal((await fetch(endpoint + '/api/prompt-preview?sessionId=x')).status, 401);
  await api('/api/project/scope', 'GET', undefined, 409);
  await api('/api/project', 'POST', { root: a });
  await api('/api/project/scope', 'PUT', { projectRoot: a, scope });
  assert.deepEqual((await api('/api/project/scope')).scope, scope);
  await api('/api/project', 'POST', { root: b });
  assert.deepEqual((await api('/api/project/scope')).scope.targets, []);
  await api('/api/project/scope', 'PUT', { projectRoot: a, scope }, 409);
  await api('/api/project', 'POST', { root: a });
  assert.deepEqual((await api('/api/project/scope')).scope, scope);
  await api('/api/project/scope', 'PUT', { projectRoot: a, scope: { ...scope, operations: [] } }, 400);
  await api('/api/prompt-preview?sessionId=missing', 'POST', undefined, 404);
});
test('real server chat uses saved scope; next turn refreshes cached agent and captures redacted application input', async () => {
  await api('/api/profiles', 'POST', { id: 'fixture-profile', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-PRIVATE-KEY', baseURL, contextWindow: 200000, maxOutputTokens: 1024 });
  await api('/api/soul', 'PUT', { body: 'UNIQUE_PERSONA_MARKER' });
  const { session } = await api('/api/sessions', 'POST', {});
  const route = '/api/prompt-preview?sessionId=' + session.id;
  await chat(session.id);
  assert.equal((await api(route)).preview, null);
  assert.ok(calls.some(call => call.stream && call.messages[0].content.includes('SCOPE_A_MARKER')));
  await api('/api/project/scope', 'PUT', { projectRoot: a, scope: { ...scope, notes: 'UPDATED_SCOPE_MARKER' } });
  await api(route, 'POST');
  await chat(session.id);
  const { preview } = await api(route);
  assert.ok(preview); assert.match(preview.text, /UPDATED_SCOPE_MARKER/);
  assert.doesNotMatch(preview.text, /FIXTURE-PRIVATE-KEY/);
  assert.match(preview.text, /NORMAL_TASK/);
  assert.equal(JSON.parse(preview.text).systemPrompt.split('UNIQUE_PERSONA_MARKER').length - 1, 1);
  assert.equal(preview.truncated, false);
  const lastCall = calls.filter(call => call.stream).at(-1);
  assert.equal(JSON.parse(preview.text).systemPrompt, lastCall.messages[0].content.replaceAll('FIXTURE-PRIVATE-KEY', '[REDACTED]'));
  await api(route, 'DELETE'); assert.equal((await api(route)).preview, null);
  // Changing the project never inherits the prior project's range.
  await api('/api/project', 'POST', { root: b });
  await api(route, 'POST'); await chat(session.id);
  const nextPrompt = JSON.parse((await api(route)).preview.text).systemPrompt;
  assert.doesNotMatch(nextPrompt, /<project-test-scope>/);
  await api(route, 'DELETE');
});
test('actual settings UI persists explicit scope, keeps failed drafts and renders preview as text', async t => {
  const dom = new JSDOM(fs.readFileSync('src/renderer/index.html', 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close()); const w = dom.window;
  w.eval(fs.readFileSync('src/renderer/services/PromptSettings.js', 'utf8'));
  let sent;
  w.fetch = async (_url, options) => { if (options?.body) sent = JSON.parse(options.body); return { ok: true, json: async () => ({ projectRoot: a, scope }) }; };
  const panel = new w.IexaPromptSettings({ getSessionId: () => 'fixture-session' });
  await panel.loadScope(); assert.equal(panel.el('scopeTargets').value, scope.targets[0]);
  panel.el('scopeNotes').value = 'user draft'; await panel.saveScope();
  assert.equal(sent.projectRoot, a); assert.equal(sent.scope.notes, 'user draft');
  w.fetch = async () => ({ ok: false, json: async () => ({ error: '项目已切换' }) });
  await panel.saveScope(); assert.equal(panel.el('scopeNotes').value, 'user draft'); assert.equal(panel.el('scopeFeedback').textContent, '项目已切换');
  w.fetch = async () => ({ ok: true, json: async () => ({ preview: { text: '<img src=x onerror=alert(1)>', warning: 'privacy warning', provider: 'fixture', model: 'fixture', capturedAt: Date.now(), expiresAt: Date.now() + 300000 } }) });
  await panel.preview('GET'); assert.equal(panel.el('promptPreviewText').querySelector('img'), null); assert.match(panel.el('promptPreviewText').textContent, /<img/);
  w.fetch = async () => ({ ok: true, json: async () => ({ armed: false, preview: null }) });
  await panel.preview('DELETE'); assert.equal(panel.el('promptPreviewText').textContent, '');
});

test('settings UI ignores late project reads and preview responses for a previously selected session', async t => {
  const dom = new JSDOM(fs.readFileSync('src/renderer/index.html', 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close()); const w = dom.window;
  w.eval(fs.readFileSync('src/renderer/services/PromptSettings.js', 'utf8'));
  let sessionId = 'session-a';
  const panel = new w.IexaPromptSettings({ getSessionId: () => sessionId });
  const pending = [];
  w.fetch = () => new Promise(resolve => pending.push(data => resolve({ ok: true, json: async () => data })));
  const first = panel.loadScope(), second = panel.loadScope();
  pending[1]({ projectRoot: b, scope: { ...scope, notes: 'project-b' } }); await second;
  pending[0]({ projectRoot: a, scope }); await first;
  assert.equal(panel.projectRoot, b); assert.equal(panel.el('scopeNotes').value, 'project-b');
  const preview = panel.preview('GET'); sessionId = 'session-b';
  pending[2]({ preview: { text: 'PRIVATE-SESSION-A', capturedAt: Date.now(), expiresAt: Date.now() + 300000 } }); await preview;
  assert.equal(panel.el('promptPreviewText').textContent, '');
});
