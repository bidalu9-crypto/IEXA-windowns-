'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { functions } = require('./helpers/transcript-harness.cjs');
const root = path.resolve(__dirname, '..');

function setup(t) {
  const dom = new JSDOM('<body><div id="sessionsList"></div></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, {
    API_BASE: '', sessionsList: w.document.getElementById('sessionsList'), currentSessionId: 'a-new', projectRoot: 'C:\\work\\alpha',
    sessionsCache: [], sessionRuntimes: new Map(), escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    uiIcon: name => `<svg data-icon="${name}"></svg>`, formatTime: value => String(value),
    IexaDialogs: { alert: async () => {} },
  });
  w.eval(functions(['renderSessionList', 'toggleSessionPin']));
  return w;
}

test('session list groups projects and sorts pinned conversations first', t => {
  const w = setup(t);
  w.sessionsCache = [
    { id: 'a-new', title: 'Alpha latest', updated: 30, projectRoot: 'C:\\work\\alpha', projectName: 'alpha' },
    { id: 'b-old', title: 'Beta', updated: 5, projectRoot: 'D:\\work\\beta', projectName: 'beta' },
    { id: 'a-pin', title: 'Alpha pinned', updated: 10, pinned: true, pinnedAt: 40, projectRoot: 'C:\\work\\alpha', projectName: 'alpha' },
  ];
  w.renderSessionList();
  const groups = [...w.document.querySelectorAll('.session-project-group')];
  assert.equal(groups.length, 2);
  assert.match(groups[0].querySelector('.session-project-heading').textContent, /alpha2/);
  assert.deepEqual([...groups[0].querySelectorAll('.session-item')].map(item => item.dataset.id), ['a-pin', 'a-new']);
  assert.equal(groups[0].querySelector('.session-item-pin').getAttribute('aria-label'), '取消置顶');
  assert.match(groups[1].querySelector('.session-project-heading').textContent, /beta1/);
});

test('pin mutation updates local metadata only after server success', async t => {
  const w = setup(t); const requests = [];
  w.sessionsCache = [{ id: 's', title: 'Session', updated: 1, projectRoot: '', projectName: '无项目', pinned: false }];
  w.fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => ({ session: { ...w.sessionsCache[0], pinned: true, pinnedAt: 9 } }) }; };
  assert.equal(await w.toggleSessionPin('s'), true);
  assert.equal(w.sessionsCache[0].pinned, true);
  assert.deepEqual(JSON.parse(requests[0].init.body), { pinned: true });
  w.fetch = async () => ({ ok: false, json: async () => ({ error: 'failure' }) });
  assert.equal(await w.toggleSessionPin('s'), false);
  assert.equal(w.sessionsCache[0].pinned, true);
});

test('startup batch launches direct server entry without password arguments', () => {
  const bat = fs.readFileSync(path.join(root, 'start.bat'), 'utf8');
  assert.match(bat, /node dist\\main\\server\.js/i);
  assert.doesNotMatch(bat, /password|passwd|login[_-]?code|--token/i);
  const server = fs.readFileSync(path.join(root, 'src/main/server.ts'), 'utf8');
  assert.match(server, /startServer\(PORT, true, '127\.0\.0\.1', \{ trustLoopback: true \}\)/);
});
