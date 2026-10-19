const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

test('real browser: search hit jumps to the matching message', { skip: !browser, timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-browser-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  // Seed a transcript whose fourth message carries a unique token.
  const made = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { Authorization: `Bearer ${backend.getServerCredentials(server).token}` },
  }).then(response => response.json());
  const sessionId = made.session.id;
  const messages = [
    { role: 'user', content: '第一轮准备', timestamp: 1000 },
    { role: 'assistant', content: '第一轮回答', timestamp: 2000 },
    { role: 'user', content: '第二轮准备', timestamp: 3000 },
    { role: 'assistant', content: '这里包含唯一标记 NEEDLE-HIT-42 便于定位', timestamp: 4000 },
    { role: 'user', content: '第三轮准备', timestamp: 5000 },
    { role: 'assistant', content: '收尾回答', timestamp: 6000 },
  ];
  fs.writeFileSync(
    path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions', `${sessionId}.json`),
    JSON.stringify(messages),
  );

  const proc = spawn(browser, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows file lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let sequence = 0;
  const waiting = new Map();
  const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 8000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression, message) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1175, height: 839, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof SafeMarkdown !== 'undefined' && document.body.dataset.mobileClient === 'desktop'", 'app shell');
  await wait('typeof performSearch === "function" && typeof openSearchHit === "function"', 'search functions');

  await evaluate(`(() => {
    document.getElementById('searchInput').value = 'NEEDLE-HIT-42';
    return performSearch();
  })()`);
  await wait("document.querySelector('.search-result-snippet.is-hittable')", 'search hit rendered');

  const snippetArg = await evaluate("document.querySelector('.search-result-snippet.is-hittable').dataset.uiArg");
  assert.equal(snippetArg, `${sessionId}:3`);

  await evaluate("document.querySelector('.search-result-snippet.is-hittable').click()");
  await wait("document.querySelector('.message.search-hit-flash')", 'jump flash');
  const jumped = await evaluate(`(() => {
    const node = document.querySelector('.message.search-hit-flash');
    return { index: node?.dataset.messageIndex || null, text: node?.textContent || '' };
  })()`);
  assert.equal(jumped.index, '3');
  assert.match(jumped.text, /NEEDLE-HIT-42/);

  assert.equal(exceptions.length, 0, 'renderer must not throw: ' + JSON.stringify(exceptions[0] || null));
});
