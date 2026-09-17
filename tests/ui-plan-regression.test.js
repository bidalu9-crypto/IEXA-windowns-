const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { functions } = require('./helpers/transcript-harness.cjs');
const root = path.resolve(__dirname, '..');
function setup(t, html = '') {
  const dom = new JSDOM(`<html data-motion="full"><body>${html}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' });
  t.after(() => dom.window.close());
  const w = dom.window;
  for (const name of ['ChatPresentation', 'PanelVisibility']) w.eval(fs.readFileSync(path.join(root, `src/renderer/services/${name}.js`), 'utf8'));
  return w;
}

test('user folding counts Unicode characters at 500/501 and preserves full text across repeated toggles', t => {
  const w = setup(t), p = w.IexaChatPresentation, content = w.document.createElement('div');
  for (const text of ['a'.repeat(500), '😀'.repeat(500), '中'.repeat(500)]) { p.foldUser(content, text); assert.equal(content.textContent, text); assert.equal(content.querySelector('button'), null); }
  for (const text of ['😀'.repeat(501), '<script>not html</script>' + '中文\n'.repeat(400)]) {
    p.foldUser(content, text); const button = content.querySelector('button'); assert.ok(button); assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(content.querySelector('script'), null);
    for (let i = 0; i < 3; i++) {
      button.click(); assert.equal(button.getAttribute('aria-expanded'), 'true'); assert.equal(content.firstChild.textContent, text);
      button.click(); assert.equal(content.getAttribute('data-original'), null); assert.equal(content.firstChild.textContent, Array.from(text).slice(0, 500).join('') + '…');
    }
  }
});

test('stream reconciliation keeps settled block nodes, reveals only additions, and handles rewritten text', t => {
  const w = setup(t, '<div id="content"></div>'), content = w.document.getElementById('content'), p = w.IexaChatPresentation;
  p.renderStream(content, '<p>First.</p><p>Hello</p>');
  const first = content.firstChild, tail = content.lastChild, group = tail.firstChild;
  p.renderStream(content, '<p>First.</p><p>Hello world</p>');
  assert.equal(content.firstChild, first); assert.equal(content.lastChild, tail); assert.equal(tail.firstChild, group);
  assert.equal(group.lastChild.textContent, ' world'); assert.equal(group.lastChild.className, 'stream-reveal');
  assert.equal(content.textContent, 'First.Hello world');
  p.renderStream(content, '<h2>Changed</h2><pre><code class="language-js">const x = 1;</code></pre>');
  assert.equal(content.textContent, 'Changedconst x = 1;'); assert.equal(content.querySelectorAll('p').length, 0);
  const code = content.querySelector('code'); p.renderStream(content, '<h2>Changed</h2><pre><code class="language-js">const x = 1;\nnext();</code></pre>');
  assert.equal(content.querySelector('code'), code);
});

test('reduced motion does not create reveal or send animations; full motion uses composer-to-bubble transform', async t => {
  const w = setup(t, '<div id="message"></div>'), message = w.document.getElementById('message'), calls = [];
  message.getBoundingClientRect = () => ({ right: 600, top: 200, width: 200, height: 80 }); message.animate = (...args) => calls.push(args);
  w.document.documentElement.dataset.motion = 'reduced';
  w.IexaChatPresentation.renderStream(message, '<p>静态</p>'); assert.equal(message.querySelector('.stream-reveal'), null);
  w.IexaChatPresentation.animateSend(message, { right: 650, top: 700, width: 400 });
  await new Promise(r => setTimeout(r, 30)); assert.equal(calls.length, 0);
  w.document.documentElement.dataset.motion = 'full'; w.IexaChatPresentation.animateSend(message, { right: 650, top: 700, width: 400 });
  await new Promise(r => setTimeout(r, 30)); assert.equal(calls.length, 1); assert.match(calls[0][0][0].transform, /translate\(50px, 500px\)/); assert.equal(calls[0][0][1].transform, 'translate(0, 0) scale(1)');
});

test('sidebars toggle independently, persist all four combinations, and expand one side from focus mode', t => {
  const w = setup(t, '<button id="leftPanelToggle"></button><button id="rightPanelToggle"></button><button id="chatFocusToggle"></button>');
  const left = w.document.getElementById('leftPanelToggle'), right = w.document.getElementById('rightPanelToggle'), body = w.document.body;
  w.document.getElementById('chatFocusToggle').onclick = () => body.classList.toggle('chat-focus-mode');
  w.IexaPanelVisibility.init();
  left.click(); assert.equal(left.getAttribute('aria-expanded'), 'false'); assert.equal(right.getAttribute('aria-expanded'), 'true');
  right.click(); assert.equal(left.getAttribute('aria-expanded'), 'false'); assert.equal(right.getAttribute('aria-expanded'), 'false');
  left.click(); assert.equal(right.getAttribute('aria-expanded'), 'false'); assert.equal(left.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('iexa-panel-visibility')), { left: true, right: false });
  right.click(); assert.deepEqual(JSON.parse(w.localStorage.getItem('iexa-panel-visibility')), { left: true, right: true });
  body.classList.add('chat-focus-mode'); left.click(); assert.equal(left.getAttribute('aria-expanded'), 'true'); assert.equal(right.getAttribute('aria-expanded'), 'false');
});

test('sidebar state hydrates independently and works when local storage throws', t => {
  const w = setup(t, '<button id="leftPanelToggle"></button><button id="rightPanelToggle"></button>');
  w.localStorage.setItem('iexa-panel-visibility', '{"left":false,"right":true}'); w.IexaPanelVisibility.init();
  assert.equal(w.document.getElementById('leftPanelToggle').getAttribute('aria-expanded'), 'false'); assert.equal(w.document.getElementById('rightPanelToggle').getAttribute('aria-expanded'), 'true');
  Object.defineProperty(w, 'localStorage', { get() { throw new Error('blocked'); } });
  w.document.getElementById('rightPanelToggle').click(); assert.equal(w.document.getElementById('rightPanelToggle').getAttribute('aria-expanded'), 'false');
});

test('archive mutation sends the boolean flag, updates local list only on success', async t => {
  const w = setup(t); let fail = false; const requests = [];
  Object.assign(w, { API_BASE: '', sessionsCache: [{ id: 's', title: 'old' }], renderSessionList: () => {}, IexaDialogs: { alert: async () => {} },
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: !fail, json: async () => fail ? { error: 'failure' } : { session: { id: 's', title: 'old', archived: true } } }; } });
  w.eval(functions(['setSessionArchived']));
  assert.equal(await w.setSessionArchived('s', true), true); assert.equal(w.sessionsCache[0].archived, true); assert.equal(requests[0].init.method, 'PATCH'); assert.deepEqual(JSON.parse(requests[0].init.body), { archived: true });
  fail = true; assert.equal(await w.setSessionArchived('s', false), false); assert.equal(w.sessionsCache[0].archived, true);
});
