const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

// Both modules are classic scripts that only read/write the DOM, so a JSDOM of
// the real index.html is enough to exercise them without a server.
function boot() {
  const dom = new JSDOM(fs.readFileSync('src/renderer/index.html', 'utf8'), { runScripts: 'outside-only', url: 'http://127.0.0.1:19840/' });
  const w = dom.window;
require('./helpers/install-i18n')(w);
  w.console = console;
  w.eval(`var API_BASE = ''; var currentSessionId = 's1';`);
  w.eval(fs.readFileSync('src/renderer/services/GoalBanner.js', 'utf8'));
  return { dom, w };
}

test('the goal bar shows the objective, its status and the exact notes tooltip', async () => {
  const { dom, w } = boot();
  const goal = {
    sessionId: 's1',
    objective: '把 app.js 拆成功能模块，并保持共享作用域不变',
    doneWhen: '全量测试通过',
    status: 'active',
    notes: ['第 1 步', '第 2 步', '第 3 步', '第 4 步'],
    createdAt: 1,
    updatedAt: 2,
  };
  w.fetch = async () => ({ ok: true, json: async () => ({ goal }) });

  await w.refreshGoalBanner();

  const bar = w.document.getElementById('goalBar');
  assert.equal(bar.hidden, false);
  assert.equal(w.document.getElementById('goalBarText').textContent, goal.objective);
  assert.equal(w.document.getElementById('goalBarStatus').textContent, '进行中 · 4 条进度');
  assert.equal(bar.dataset.status, 'active');
  // The tooltip keeps the full objective and only the last three notes; the
  // bar itself is one line and ellipsises.
  assert.match(bar.title, /完成标准：全量测试通过/);
  assert.doesNotMatch(bar.title, /第 1 步/);
  assert.match(bar.title, /第 4 步/);
  dom.window.close();
});

test('a done goal stays visible but is marked done; no goal hides the bar', async () => {
  const { dom, w } = boot();
  w.fetch = async () => ({ ok: true, json: async () => ({ goal: { objective: 'done thing', status: 'done', notes: [] } }) });
  await w.refreshGoalBanner();
  assert.equal(w.document.getElementById('goalBar').hidden, false);
  assert.equal(w.document.getElementById('goalBar').dataset.status, 'done');
  assert.equal(w.document.getElementById('goalBarStatus').textContent, '已完成');

  w.fetch = async () => ({ ok: true, json: async () => ({ goal: null }) });
  await w.refreshGoalBanner();
  assert.equal(w.document.getElementById('goalBar').hidden, true);
  assert.equal(w.document.getElementById('goalBar').dataset.status, '');
  dom.window.close();
});

test('a slow reply for the previous session cannot paint over the current one', async () => {
  const { dom, w } = boot();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  w.fetch = () => pending;
  const first = w.refreshGoalBanner();
  // The user switches before the response arrives.
  w.eval("currentSessionId = 's2'");
  w.fetch = async () => ({ ok: true, json: async () => ({ goal: { objective: 'newer session', status: 'active', notes: [] } }) });
  await w.refreshGoalBanner();
  release({ ok: true, json: async () => ({ goal: { objective: 'stale session', status: 'active', notes: [] } }) });
  await first;
  assert.equal(w.document.getElementById('goalBarText').textContent, 'newer session');
  dom.window.close();
});

test('clearing from the bar sends DELETE and hides the row', async () => {
  const { dom, w } = boot();
  const calls = [];
  w.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (options.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({ goal: { objective: 'clear me', status: 'active', notes: [] } }) };
  };
  await w.refreshGoalBanner();
  assert.equal(w.document.getElementById('goalBar').hidden, false);

  await w.clearGoalFromBanner();
  assert.equal(w.document.getElementById('goalBar').hidden, true);
  const del = calls.find((call) => call.method === 'DELETE');
  assert.ok(del, 'clear must be a DELETE');
  assert.match(del.url, /\/api\/goal\?sessionId=s1/);
  dom.window.close();
});
