'use strict';
// The scheduled-task surface in a real browser: clock entry, empty state, the
// frequency-dependent fields, a saved card, the enable switch and persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: scheduled tasks can be created, paused and restored', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-scheduled-ui-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const creds = backend.getServerCredentials(server);

  const profile = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'ui-profile', provider: 'custom', model: 'gpt-5.1', apiKey: 'FIXTURE',
      baseURL: 'http://127.0.0.1:9/v1', contextWindow: 200000, maxOutputTokens: 2048, name: '主力模型',
    }),
  });
  assert.equal(profile.status, 200, await profile.text());

  const proc = spawn(browser, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', (data) => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let sequence = 0;
  const waiting = new Map();
  const exceptions = [];
  let loadResolve = null;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails?.exception?.description || 'exception');
    if (message.method === 'Page.loadEventFired' && loadResolve) { loadResolve(); loadResolve = null; }
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 8000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 500));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 120; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${creds.loginCode}` });
  await wait("typeof currentSessionId !== 'undefined' && !!currentSessionId");

  // The entry is a clock, not the old terminal glyph, and nothing of the job
  // history survives in the sidebar.
  assert.equal(await evaluate("document.querySelector('.nav-btn[data-view=\"scheduled\"] use').getAttribute('href')"), '#ui-clock');
  assert.equal(await evaluate("document.querySelector('.nav-btn[data-view=\"jobs\"]') === null"), true);
  await evaluate("document.querySelector('.nav-btn[data-view=\"scheduled\"]').click(); true");
  await wait("document.getElementById('view-scheduled').classList.contains('active') && scheduledTasksLoaded");
  assert.equal(await evaluate("!!document.querySelector('.scheduled-empty')"), true);
  assert.equal(await evaluate("document.getElementById('scheduledSummary').hidden"), true,
    'an empty list has no summary strip');

  // The editor only shows the fields the chosen frequency needs.
  await evaluate("document.getElementById('scheduledNewBtn').click(); true");
  await wait("document.getElementById('scheduledEditor').classList.contains('is-open')");
  assert.equal(await evaluate("document.getElementById('scheduledWeekdayRow').hidden"), true);
  assert.equal(await evaluate("document.getElementById('scheduledDayRow').hidden"), true);
  assert.equal(await evaluate("document.getElementById('scheduledSessionField').hidden"), true);
  await evaluate("document.querySelector('#scheduledFrequency [data-freq=\"weekly\"]').click(); true");
  assert.equal(await evaluate("document.getElementById('scheduledWeekdayRow').hidden"), false);
  assert.equal(await evaluate("document.getElementById('scheduledDayRow').hidden"), true);
  await evaluate("document.querySelector('#scheduledFrequency [data-freq=\"monthly\"]').click(); true");
  assert.equal(await evaluate("document.getElementById('scheduledDayRow').hidden"), false);
  await evaluate("document.querySelector('#scheduledTarget [data-target=\"existing\"]').click(); true");
  assert.equal(await evaluate("document.getElementById('scheduledSessionField').hidden"), false);
  await evaluate("document.querySelector('#scheduledTarget [data-target=\"new\"]').click(); true");

  await evaluate(String.raw`(() => {
    document.querySelector('#scheduledFrequency [data-freq="daily"]').click();
    const name = document.getElementById('scheduledTitle');
    name.value = '每日仓库巡检';
    const prompt = document.getElementById('scheduledPrompt');
    prompt.value = '汇总今天仓库里所有未提交的改动，按风险排序，并指出需要补测试的模块。';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    const time = document.getElementById('scheduledTime');
    time.value = '09:30';
    time.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('scheduledForm').requestSubmit();
    return true;
  })()`);
  await wait("!document.getElementById('scheduledEditor').classList.contains('is-open') && document.querySelectorAll('.scheduled-card').length === 1");

  const card = await evaluate(`(() => {
    const el = document.querySelector('.scheduled-card');
    return {
      title: el.querySelector('.scheduled-card-title').textContent,
      prompt: el.querySelector('.scheduled-card-prompt')?.textContent || '',
      chips: Array.from(el.querySelectorAll('.scheduled-chip')).map((chip) => chip.textContent.trim()),
      status: el.querySelector('.scheduled-state').textContent.trim(),
      next: el.querySelector('.scheduled-next').textContent.replace(/\\s+/g, ' ').trim(),
      badge: document.getElementById('navScheduledBadge').textContent,
    };
  })()`);
  assert.equal(card.title, '每日仓库巡检');
  assert.match(card.prompt, /汇总今天仓库/, 'a named task still shows its prompt');
  assert.ok(card.chips.some((chip) => chip.includes('每天 09:30')), JSON.stringify(card.chips));
  assert.ok(card.chips.some((chip) => chip.includes('主力模型')), JSON.stringify(card.chips));
  assert.ok(card.chips.some((chip) => chip.includes('每次新建会话')), JSON.stringify(card.chips));
  assert.equal(card.status, '已启用');
  assert.match(card.next, /下次/);
  assert.equal(card.badge, '1');

  // Pause: the card keeps its place but stops advertising a next run.
  await evaluate("document.querySelector('.scheduled-switch').click(); true");
  await wait("document.querySelector('.scheduled-switch')?.getAttribute('aria-checked') === 'false'");
  const paused = await evaluate(`(() => {
    const el = document.querySelector('.scheduled-card');
    return { status: el.querySelector('.scheduled-state').textContent.trim(),
      next: el.querySelector('.scheduled-next').textContent.trim(),
      summary: document.getElementById('scheduledSummary').textContent.replace(/\\s+/g, ' ').trim(),
      badgeHidden: document.getElementById('navScheduledBadge').hidden };
  })()`);
  assert.equal(paused.status, '已关闭');
  assert.match(paused.next, /已暂停/);
  assert.match(paused.summary, /0 个已启用/);
  assert.equal(paused.badgeHidden, true);

  // A reload must restore the task from disk, paused.
  const reloaded = new Promise((resolve) => { loadResolve = resolve; });
  await cdp('Page.reload');
  await reloaded;
  await wait("document.readyState === 'complete' && typeof loadScheduledTasks === 'function' && typeof currentSessionId !== 'undefined' && !!document.querySelector('.nav-btn[data-view=\"scheduled\"]')");
  await evaluate("document.querySelector('.nav-btn[data-view=\"scheduled\"]').click(); true");
  await wait("document.getElementById('view-scheduled').classList.contains('active') && scheduledTasksLoaded");
  await wait("document.querySelectorAll('.scheduled-card').length === 1");
  assert.equal(await evaluate("document.querySelector('.scheduled-switch').getAttribute('aria-checked')"), 'false');
  assert.equal(await evaluate("document.querySelector('.scheduled-card-title').textContent"), '每日仓库巡检');

  // Editing prefills the name and the schedule, and saving keeps one card.
  await evaluate("document.querySelector('.scheduled-card [data-action=\"edit\"]').click(); true");
  await wait("document.getElementById('scheduledEditor').classList.contains('is-open')");
  assert.equal(await evaluate("document.getElementById('scheduledTitle').value"), '每日仓库巡检');
  assert.equal(await evaluate("document.getElementById('scheduledTime').value"), '09:30');
  await evaluate("document.getElementById('scheduledCancel').click(); true");

  // Deleting returns to the empty state.
  await evaluate("document.querySelector('.scheduled-card [data-action=\"delete\"]').click(); true");
  await wait("!!document.querySelector('dialog.iexa-app-dialog')");
  await evaluate("document.querySelector('dialog.iexa-app-dialog .iexa-app-dialog-actions .btn-primary').click(); true");
  await wait("!!document.querySelector('.scheduled-empty')");
  assert.equal(await evaluate("document.querySelectorAll('.scheduled-card').length"), 0);

  // Phone width turns the editor into a bottom sheet.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.getElementById('scheduledNewBtn').click(); true");
  await wait("document.getElementById('scheduledEditor').classList.contains('is-open')");
  const sheet = await evaluate(`(() => {
    const box = document.querySelector('.scheduled-editor').getBoundingClientRect();
    return { width: Math.round(box.width), bottom: Math.round(box.bottom), viewport: innerHeight,
      radius: getComputedStyle(document.querySelector('.scheduled-editor')).borderTopLeftRadius };
  })()`);
  assert.equal(sheet.width, 430);
  assert.equal(sheet.bottom, sheet.viewport);
  assert.equal(sheet.radius, '18px');

  assert.deepEqual(exceptions, [], 'the scheduled surface must not throw');
});
