const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/renderer/services/MobileBridge.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(t, enabled = false) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1:4000/' });
  t.after(() => dom.window.close());
  const w = dom.window, requests = [];
  w.API_BASE = '';
  w.escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  w.uiIcon = () => '';
  w.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
  w.eval(source);
  const state = { enabled, defaultCapability: 'chat', addresses: ['192.0.2.1'], port: 4000, devices: [] };
  w.renderMobileBridge(state);
  w.initMobileBridge();
  return { w, requests, state };
}

test('real bridge checkbox saves on and off after DOM event dispatch has ended', async t => {
  const { w, requests, state } = setup(t);
  const checkbox = w.document.getElementById('mobileBridgeEnabled');
  const result = w.document.getElementById('mobileBridgeResult');
  assert.equal(checkbox.type, 'checkbox');
  assert.equal(w.document.getElementById('mobileBridgeRequirePair'), null, 'use the current production settings DOM');
  let dispatched;
  checkbox.addEventListener('change', event => { dispatched = event; });
  for (const enabled of [true, false]) {
    checkbox.click();
    assert.equal(dispatched.currentTarget, null, 'the request resolves after currentTarget is cleared');
    const request = requests.shift();
    assert.equal(request.url, '/api/mobile-bridge/config');
    assert.equal(request.options.method, 'PUT');
    assert.deepEqual(JSON.parse(request.options.body), { enabled });
    request.resolve({ ok: true, json: async () => ({ ...state, enabled }) });
    await flush();
    assert.equal(checkbox.checked, enabled);
    assert.equal(w.document.getElementById('mobileBridgeLive').hidden, !enabled);
    assert.equal(w.document.getElementById('mobileBridgeOffline').hidden, enabled);
    assert.equal(result.hidden, false);
    assert.equal(result.classList.contains('sync-error'), false);
    assert.match(result.textContent, enabled ? /手机桥接已开启/ : /手机桥接已关闭/);
  }
});

test('rejected real bridge toggle restores the recorded server state and shows the error', async t => {
  for (const previous of [false, true]) {
    const { w, requests } = setup(t, previous);
    const checkbox = w.document.getElementById('mobileBridgeEnabled');
    checkbox.click();
    const request = requests.shift();
    assert.deepEqual(JSON.parse(request.options.body), { enabled: !previous });
    request.resolve({ ok: false, json: async () => ({ error: 'Fixture bridge configuration rejected' }) });
    await flush();
    assert.equal(checkbox.checked, previous);
    assert.equal(w.document.getElementById('mobileBridgeLive').hidden, !previous);
    const result = w.document.getElementById('mobileBridgeResult');
    assert.equal(result.classList.contains('sync-error'), true);
    assert.equal(result.textContent, 'Fixture bridge configuration rejected');
  }
});

test('real capability select persists defaultCapability and renders the returned setting', async t => {
  const { w, requests, state } = setup(t, true);
  const select = w.document.getElementById('mobileBridgeCapability');
  select.value = 'files';
  select.dispatchEvent(new w.Event('change', { bubbles: true }));
  const request = requests.shift();
  assert.deepEqual(JSON.parse(request.options.body), { defaultCapability: 'files' });
  request.resolve({ ok: true, json: async () => ({ ...state, defaultCapability: 'files' }) });
  await flush();
  assert.equal(select.value, 'files');
  assert.equal(w.document.getElementById('mobileBridgeEnabled').checked, true);
});
