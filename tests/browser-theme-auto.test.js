// "Auto" is the only theme choice whose answer can change while the app sits
// still, so it cannot be proven by a screenshot: the OS preference has to flip
// underneath a running page, the page has to repaint without a reload, and the
// stored value has to stay `auto` instead of the colour it resolved to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: auto theme follows the system and hot-swaps', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-theme-auto-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  const proc = spawn(browser, [
    '--headless=new',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${path.join(dir, 'profile')}`,
    'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((response) => response.json());
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 800));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  const systemTheme = (value) => cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value }],
  });
  // Both attributes plus the lit segment: the choice is what stays, the colour
  // is what moves.
  const state = () => evaluate(`(() => ({
    mode: document.documentElement.dataset.themeMode,
    theme: document.documentElement.dataset.theme,
    active: [...document.querySelectorAll('#themeSeg [data-theme-set]')]
      .filter((button) => button.classList.contains('active'))
      .map((button) => button.dataset.themeSet),
    hint: (document.getElementById('themeHelp') || {}).textContent || '',
  }))()`);
  const openApp = async () => {
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
    await wait("typeof initTheme === 'function' && !!currentSessionId");
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  await systemTheme('light');
  await openApp();

  await evaluate("document.querySelector('#themeSeg [data-theme-set=auto]').click(); true");
  let view = await state();
  assert.equal(view.mode, 'auto', 'the segment stores the choice');
  assert.equal(view.theme, 'light', 'auto resolves to the light system immediately');
  assert.deepEqual(view.active, ['auto'], 'only the auto segment is lit');
  assert.match(view.hint, /浅色/, 'the hint names what Windows currently reports');

  // Windows flips light -> dark with the page already open.
  await systemTheme('dark');
  await wait("document.documentElement.dataset.theme === 'dark'");
  view = await state();
  assert.equal(view.mode, 'auto', 'a system flip must not overwrite the choice');
  assert.deepEqual(view.active, ['auto']);
  assert.match(view.hint, /深色/);

  // Persistence: the file records "auto", never the resolved colour. Saving the
  // resolution is what would freeze the app on whatever Windows was at click time.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const saved = await evaluate("fetch('/api/appearance').then((response) => response.json())");
  assert.equal(saved.theme, 'auto');
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-appearance.json'), 'utf8'));
  assert.equal(disk.theme, 'auto');

  // A cold start has to resolve before the first paint, not after the fetch.
  await openApp();
  view = await state();
  assert.equal(view.mode, 'auto');
  assert.equal(view.theme, 'dark', 'a reload trusts the stored choice, not a stored colour');

  await systemTheme('light');
  await wait("document.documentElement.dataset.theme === 'light'");

  // A fixed mode is a promise: the system must stop moving it.
  await evaluate("document.querySelector('#themeSeg [data-theme-set=dark]').click(); true");
  await systemTheme('light');
  await new Promise((resolve) => setTimeout(resolve, 600));
  view = await state();
  assert.equal(view.mode, 'dark');
  assert.equal(view.theme, 'dark', 'a fixed mode ignores the system flip');

  // Three buttons instead of two is exactly the kind of change that pushes a
  // settings row sideways on a phone, so the layout is part of the contract.
  await evaluate("document.querySelector('.nav-btn[data-view=appearance]').click(); true");
  await wait("document.getElementById('view-appearance').classList.contains('active')");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const narrow = await evaluate(`(() => {
    const view = document.getElementById('view-appearance');
    return { overflow: view.scrollWidth > view.clientWidth + 1, buttons: document.querySelectorAll('#themeSeg button').length };
  })()`);
  assert.equal(narrow.buttons, 3);
  assert.equal(narrow.overflow, false, 'the three-way segment must not widen the page');
});
