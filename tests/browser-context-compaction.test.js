// The panel has to be usable, not just correct in the API: the custom field must
// accept a real number, reject one below the floor with a message, and the
// trigger point must persist through a click.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the compaction panel saves a custom window and trigger', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-compaction-ui-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;
  const token = backend.getServerCredentials(server).token;

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
  const stored = async () => (await (await fetch(`http://127.0.0.1:${port}/api/context-compaction`, {
    headers: { Authorization: 'Bearer ' + token },
  })).json());

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof initContextCompactionControl === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");

  assert.equal(await evaluate("document.getElementById('contextCompactionLabel').textContent"), '自动');

  await evaluate("document.getElementById('contextCompactionBtn').click(); true");
  await wait("document.getElementById('contextCompactionMenu').style.display === 'block'");
  await evaluate("document.querySelector('.context-compaction-option[data-limit=\"custom\"]').click(); true");
  await wait("document.getElementById('contextCompactionCustom').hidden === false");

  await evaluate(`(() => {
    const input = document.getElementById('contextCompactionCustomInput');
    input.value = '100000';
    document.getElementById('contextCompactionCustomConfirm').click();
  })()`);
  await wait("document.getElementById('contextCompactionCustomHint').dataset.tone === 'error'");
  assert.match(await evaluate("document.getElementById('contextCompactionCustomHint').textContent"), /128000/);
  assert.equal((await stored()).contextCompactionLimit, null, 'an invalid value is never saved');

  await evaluate(`(() => {
    const input = document.getElementById('contextCompactionCustomInput');
    input.value = '200000';
    document.getElementById('contextCompactionCustomConfirm').click();
  })()`);
  await wait("document.getElementById('contextCompactionLabel').textContent === '200K'");
  assert.equal((await stored()).contextCompactionLimit, 200000);
  assert.equal(await evaluate("document.getElementById('contextCompactionBtn').dataset.limit"), '200000');

  await evaluate("document.getElementById('contextCompactionBtn').click(); true");
  await wait("document.getElementById('contextCompactionMenu').style.display === 'block'");
  await evaluate("document.querySelector('.context-compaction-threshold-option[data-threshold=\"50\"]').click(); true");
  await wait("document.querySelector('.context-compaction-threshold-option[data-threshold=\"50\"]').classList.contains('is-active')");
  assert.equal((await stored()).contextCompactionThreshold, 0.5, '50% is stored as a ratio');
  assert.match(await evaluate("document.getElementById('contextCompactionThresholdHint').textContent"), /50%/);

  await evaluate("window.__beforeReload = true; true");
  await cdp('Page.reload');
  await wait("!window.__beforeReload && typeof currentSessionId !== 'undefined' && currentSessionId");
  await wait("document.getElementById('contextCompactionLabel').textContent === '200K'");
  assert.equal(await evaluate("document.querySelector('.context-compaction-threshold-option[data-threshold=\"50\"]').classList.contains('is-active')"), true);
});
