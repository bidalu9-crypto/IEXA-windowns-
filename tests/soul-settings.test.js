const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { JSDOM } = require('jsdom');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-soul-settings-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, endpoint, token;
const body = '人格正文 English 日本語 한글 🧠\n'.repeat(3000) + 'END-OF-PERSONA';
test.before(async () => {
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(path.dirname(directory), os.tmpdir());
  fs.rmSync(directory, { recursive: true, force: true });
});
async function api(route, method = 'GET', data) {
  const response = await fetch(endpoint + route, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal(response.status, 200);
  return response.json();
}
test('SOUL API saves and reloads long bodies without a persona cap, restore reports null', async () => {
  assert.ok(body.length > 24000);
  for (const method of ['PUT', 'POST']) {
    const saved = await api('/api/soul', method, { metadata: { name: '长正文测试' }, body });
    assert.equal(saved.body, body);
    assert.equal(saved.tokenLimit, null);
    assert.ok(saved.tokenCount > 2000);
    const loaded = await api('/api/soul');
    assert.equal(loaded.body, body);
    assert.equal(loaded.tokenLimit, null);
    assert.equal(loaded.tokenCount, saved.tokenCount);
  }
  const restored = await api('/api/soul/restore', 'POST');
  assert.equal(restored.tokenLimit, null);
  assert.equal(restored.body, '');
});
test('actual SOUL editor submits long text, keeps in-flight lock and recovers after errors', async t => {
  const dom = new JSDOM(fs.readFileSync('src/renderer/index.html', 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, source = fs.readFileSync('src/renderer/app.js', 'utf8');
  const fn = name => {
    const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0);
    return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end);
  };
  w.eval(`const API_BASE='';let soulSaving=false;
    function setSoulSaveFeedback(){}function showSoulResult(text,error){window.lastError=error;}
    function populateSoulForm(){updateSoulPreview();}
    ${['estimateSoulTokens', 'soulFormValue', 'updateSoulPreview', 'saveSoul'].map(fn).join('\n')}
    window.fixture={updateSoulPreview,saveSoul};`);
  const input = w.document.getElementById('soulBody'), button = w.document.getElementById('soulSaveBtn');
  assert.equal(input.hasAttribute('maxlength'), false);
  input.value = body;
  w.fixture.updateSoulPreview();
  assert.equal(button.disabled, false);
  assert.doesNotMatch(w.document.getElementById('soulTokenCount').textContent, /\//);
  let complete, sent, calls = 0;
  w.fetch = (_url, options) => { calls++; sent = JSON.parse(options.body); return new Promise(resolve => { complete = resolve; }); };
  const saving = w.fixture.saveSoul();
  assert.equal(sent.body, body);
  assert.equal(button.disabled, true);
  w.fixture.updateSoulPreview();
  assert.equal(button.disabled, true);
  await w.fixture.saveSoul();
  assert.equal(calls, 1);
  complete({ ok: true, json: async () => sent });
  await saving;
  assert.equal(button.disabled, false);
  w.fetch = async () => ({ ok: false, json: async () => ({ error: 'fixture error' }) });
  await w.fixture.saveSoul();
  assert.equal(w.lastError, true);
  assert.equal(button.disabled, false);
  assert.equal(input.value, body);
});
