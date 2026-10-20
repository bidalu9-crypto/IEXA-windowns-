// The settings page is a sectioned card layout: aligned label/control rows, a
// provider list with avatars, and an editor that keeps its header and footer
// while only the body scrolls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: settings rows, provider list and the sectioned editor hold their shape', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-settings-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const creds = backend.getServerCredentials(server);
  const endpoint = `http://127.0.0.1:${port}`;
  for (const [name, model] of [['workbuddy-4.1', 'cn:deepseek-v4.1-flash'], ['万次', 'deepseek-v4.1-flash']]) {
    const created = await fetch(endpoint + '/api/profiles', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider: 'openai', model, baseURL: 'https://relay.example/v1', apiKey: 'FIXTURE-KEY', contextWindow: 128000, maxOutputTokens: 512 }),
    });
    assert.equal(created.status, 200, await created.text());
  }

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
  const api = new URL(wsUrl);
  const pages = await fetch(`http://${api.host}/json`).then((r) => r.json());
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let sequence = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${endpoint}/#login=${creds.loginCode}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await evaluate("document.querySelector('[data-view=\"settings\"]').click(); true");
  await wait("document.getElementById('view-settings').classList.contains('active') && document.querySelectorAll('.profile-card').length === 2");

  const page = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.setting-row'));
    const cards = Array.from(document.querySelectorAll('.settings-card'));
    return {
      title: document.querySelector('.settings-intro h1')?.textContent,
      cards: cards.length,
      rows: rows.length,
      twoColumns: rows.every((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length === 2),
      hintUnderControl: rows[1] ? (() => {
        const hint = rows[1].querySelector('.setting-row-hint');
        const control = rows[1].querySelector('.setting-row-control');
        return hint && hint.getBoundingClientRect().left >= control.getBoundingClientRect().left - 1;
      })() : false,
      avatars: Array.from(document.querySelectorAll('.profile-avatar')).map((el) => el.textContent),
      activeChip: document.querySelector('.profile-card.active .profile-active-chip')?.textContent,
      activeActions: Number(getComputedStyle(document.querySelector('.profile-card.active .profile-card-actions')).opacity),
      idleActions: Number(getComputedStyle(document.querySelectorAll('.profile-card')[1].querySelector('.profile-card-actions')).opacity),
      pageWidth: Math.round(document.querySelector('.settings-page').getBoundingClientRect().width),
    };
  })()`);
  assert.equal(page.title, '配置');
  assert.equal(page.cards, 2);
  assert.equal(page.rows, 3);
  assert.equal(page.twoColumns, true, 'label and control share one aligned row');
  assert.equal(page.hintUnderControl, true, 'hints sit with the control, not in the label column');
  assert.deepEqual(page.avatars, ['O', 'O']);
  assert.equal(page.activeChip, '当前');
  assert.equal(page.activeActions, 1, 'the active row keeps its actions visible');
  assert.equal(page.idleActions, 0, 'idle rows reveal actions on hover only');
  assert.ok(page.pageWidth >= 860, 'the page fills its column: ' + page.pageWidth);

  await evaluate("showProfileEditor({ id: 'p1', name: 'workbuddy-4.1', provider: 'openai', model: 'cn:deepseek-v4.1-flash', baseURL: 'https://relay.example/v1', apiMode: 'chat_completions' }); true");
  await wait("document.getElementById('profileEditorOverlay').style.display !== 'none'");
  const editor = await evaluate(`(() => {
    const box = document.querySelector('.profile-editor').getBoundingClientRect();
    const head = document.querySelector('.profile-editor-head').getBoundingClientRect();
    const body = document.querySelector('.profile-editor-body');
    const footer = document.querySelector('.profile-editor-actions').getBoundingClientRect();
    return {
      sections: Array.from(document.querySelectorAll('.editor-section h4')).map((el) => el.textContent),
      title: document.getElementById('profileEditorTitle').textContent,
      headPinned: Math.abs(head.top - box.top) <= 2,
      footerPinned: Math.abs(footer.bottom - box.bottom) <= 2,
      scrolls: body.scrollHeight > body.clientHeight,
      order: Array.from(document.querySelectorAll('#profileEditorOverlay .profile-editor-actions button')).map((el) => el.textContent),
    };
  })()`);
  assert.deepEqual(editor.sections, ['基本信息', '能力', '连接', '高级']);
  assert.equal(editor.title, '编辑模型');
  assert.equal(editor.headPinned, true, 'the header stays put while the body scrolls');
  assert.equal(editor.footerPinned, true, 'the actions stay pinned to the bottom');
  assert.equal(editor.scrolls, true, 'a long form scrolls inside the body');
  assert.deepEqual(editor.order, ['取消', '保存']);

  await evaluate("hideProfileEditor(); true");
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise((r) => setTimeout(r, 450));
  const phone = await evaluate(`(() => {
    const row = document.querySelectorAll('.setting-row')[1];
    const box = row.getBoundingClientRect();
    const label = row.querySelector('.setting-row-text').getBoundingClientRect();
    const control = row.querySelector('.setting-row-control').getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      stacked: control.top >= label.bottom - 1,
      labelWidth: Math.round(label.width),
      rowWidth: Math.round(box.width),
    };
  })()`);
  assert.equal(phone.overflow, false, 'no horizontal overflow on a phone');
  assert.equal(phone.stacked, true, 'the control drops under its label on a phone');
  assert.ok(phone.labelWidth > phone.rowWidth * 0.8, 'the label uses the full row width, not a squeezed column');
});
