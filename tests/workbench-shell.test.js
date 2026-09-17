const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../src/renderer');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'services/WorkbenchShell.js'), 'utf8');
const skin = fs.readFileSync(path.join(root, 'workbench.css'), 'utf8');
function fixture(t) { const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' }); t.after(() => dom.window.close()); dom.window.eval(shell); return dom.window; }
const tick = () => new Promise(r => setImmediate(r));
test('unique IDs, sprite references and original navigation destinations', t => {
  const w = fixture(t); const d = w.document; const ids = [...d.querySelectorAll('[id]')].map(el => el.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const use of d.querySelectorAll('use')) { const id = use.getAttribute('href'); if (id?.startsWith('#')) assert.ok(d.getElementById(id.slice(1)), id); }
  for (const b of d.querySelectorAll('.nav-btn')) assert.ok(d.getElementById(`view-${b.dataset.view}`));
  assert.equal(d.querySelectorAll('.nav-btn').length, 11);
});
test('new controls forward exactly once to existing handlers', t => {
  const w = fixture(t); const d = w.document;
  for (const [from, to] of [['shellNewThread','newSessionBtn'],['shellProjectBtn','filesOpenBtn'],['shellAddProject','filesOpenBtn'],['shellOpenProject','filesOpenBtn'],['shellFocusBtn','chatFocusToggle']]) {
    let count = 0; const onClick = () => count++; d.getElementById(to).addEventListener('click', onClick);
    d.getElementById(from).click(); assert.equal(count, 1); d.getElementById(to).removeEventListener('click', onClick);
  }
});
test('keyboard shortcut respects composition and repeat', t => {
  const w = fixture(t); let calls = 0; w.document.getElementById('newSessionBtn').onclick = () => calls++;
  for (const props of [{ctrlKey:true},{ctrlKey:true,repeat:true},{ctrlKey:true,isComposing:true}]) w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'n', cancelable: true, ...props }));
  assert.equal(calls, 1);
});
test('active view, project title and focus state synchronize without HTML injection', async t => {
  const w = fixture(t); const d = w.document;
  d.querySelector('.nav-btn.active').classList.remove('active');
  const settings = d.querySelector('[data-view="settings"]'); settings.classList.add('active');
  d.getElementById('filesPanelTitle').textContent = '<img src=x onerror=alert(1)>';
  d.body.classList.add('chat-focus-mode'); await tick();
  assert.equal(d.getElementById('shellViewTitle').textContent, '配置');
  assert.equal(settings.getAttribute('aria-current'), 'page'); assert.equal(d.getElementById('sidebarMore').open, true);
  assert.equal(d.getElementById('shellProjectName').children.length, 0);
  assert.equal(d.getElementById('shellFocusBtn').getAttribute('aria-pressed'), 'true');
});
test('skin is last, honors reduced motion and locks send icon transform', () => {
  assert.ok(html.indexOf('workbench.css') > html.indexOf('styles.css'));
  assert.match(skin, /prefers-reduced-motion: reduce/);
  assert.match(skin, /#sendBtn:active \.send-icon[^}]+translate\(-58%, -50%\)/);
});
