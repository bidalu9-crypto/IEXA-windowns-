// The composer shows the provider's account balance at the right end of the
// model bar. This runs the real app against a fake gateway that speaks the
// One API billing contract, then against a gateway with no balance route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: balance chip reports, expands and hides when unsupported', { skip: !browser, timeout: 60000 }, async (t) => {
  let mode = 'billing';
  const upstream = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/__mode') {
      mode = new URL(req.url, 'http://x').searchParams.get('v');
      res.end('ok');
      return;
    }
    if (url === '/relay/dashboard/billing/subscription' && mode === 'billing') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ hard_limit_usd: 12.34 }));
      return;
    }
    if (url === '/relay/dashboard/billing/usage' && mode === 'billing') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ total_usage: 320 }));
      return;
    }
    if (url === '/relay/v1/credits' && mode === 'low') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ total_credits: 20, total_usage: 19.5 }));
      return;
    }
    if ((url === '/relay/dashboard/billing/subscription' || url === '/relay/dashboard/billing/usage' || url === '/relay/v1/credits') && mode === 'error') {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${upstream.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-balance-ui-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const token = backend.getServerCredentials(server).token;
  const endpoint = `http://127.0.0.1:${port}`;

  async function api(route, method, body) {
    const response = await fetch(endpoint + route, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  for (const profile of [
    { id: 'balance-on', name: 'relay-model', provider: 'custom', model: 'gpt-6-pro', apiKey: 'sk-test', baseURL: `${relay}/relay/v1` },
    { id: 'balance-off', name: 'dead-model', provider: 'custom', model: 'gpt-6-pro', apiKey: 'sk-dead', baseURL: 'http://127.0.0.1:9/v1' },
  ]) {
    const created = await api('/api/profiles', 'POST', { ...profile, contextWindow: 200000, maxOutputTokens: 1024, apiKey: profile.apiKey });
    assert.equal(created.status, 200, JSON.stringify(created.body));
  }
  await api('/api/profiles', 'PUT', { activeProfileId: 'balance-on' });

  const code = backend.getServerCredentials(server).loginCode;
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
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
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
  const endpointUrl = new URL(wsUrl);
  const pages = await fetch(`http://${endpointUrl.host}/json`).then((r) => r.json());
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
    for (let index = 0; index < 140; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await wait("document.getElementById('balanceChip')?.dataset.state === 'ok'");
  assert.equal(await evaluate("document.getElementById('balanceValue').textContent"), '$12.34');
  assert.equal(await evaluate("document.getElementById('balanceWrap').hidden"), false);

  // The chip is part of the model bar, not a second row below it.
  const row = await evaluate(`(() => {
    const bar = document.querySelector('.model-bar').getBoundingClientRect();
    const chip = document.getElementById('balanceWrap').getBoundingClientRect();
    return { sameRow: chip.top - bar.top < 24, rightGap: Math.round(bar.right - chip.right) };
  })()`);
  assert.equal(row.sameRow, true, 'the chip shares the model row');
  assert.ok(row.rightGap < 24, 'the chip is right-aligned: ' + row.rightGap);

  await evaluate("document.getElementById('balanceChip').click(); true");
  await wait("!document.getElementById('balancePopover').hidden");
  const receipt = await evaluate("document.getElementById('balancePopover').textContent.replace(/\\s+/g, ' ').trim()");
  assert.match(receipt, /账户余额/);
  assert.match(receipt, /\$12\.34/);
  assert.match(receipt, /已用/);
  assert.match(receipt, /\$3\.20/);
  assert.match(receipt, /刷新/);

  mode = 'low';
  await evaluate("document.querySelector('#balancePopover .balance-refresh').click(); true");
  await wait("document.getElementById('balanceChip').dataset.state === 'low'");
  assert.equal(await evaluate("document.getElementById('balanceValue').textContent"), '$0.50');
  const lowColor = await evaluate("getComputedStyle(document.getElementById('balanceChip')).color");
  assert.match(lowColor, /196, 138, 26/, 'low balance uses the warning tone');
  assert.match(await evaluate("document.getElementById('balancePopover').textContent.replace(/\\s+/g, ' ').trim()"), /总额\$20\.00/);

  // Switching this conversation to a gateway with no balance route hides the
  // chip and closes the popover instead of leaving a dead control.
  await evaluate("void selectModelProfile('balance-off'); true");
  await wait("document.getElementById('balanceWrap').hidden === true");
  assert.equal(await evaluate("getComputedStyle(document.getElementById('balanceWrap')).display"), 'none',
    'the chip must actually leave the layout, not just carry the attribute');
  assert.equal(await evaluate("document.getElementById('balancePopover').hidden"), true);

  await evaluate("void selectModelProfile('balance-on'); true");
  await wait("document.getElementById('balanceWrap').hidden === false");

  // A probe that fails must not leave a lone dash in the model bar: the chip
  // disappears entirely, and reopening a profile with a number brings it back.
  mode = 'error';
  await evaluate("void window.IexaBalance.refresh(true); true");
  await wait("document.getElementById('balanceWrap').hidden === true");
  assert.equal(await evaluate("getComputedStyle(document.getElementById('balanceWrap')).display"), 'none',
    'a failed probe removes the chip instead of leaving a dash behind');
  assert.equal(await evaluate("document.getElementById('balanceValue').textContent"), '', 'no placeholder text is left behind');

  mode = 'billing';
  await evaluate("void window.IexaBalance.refresh(true); true");
  await wait("document.getElementById('balanceWrap').hidden === false");

  await evaluate("fetch('/__mode?v=billing'); true");
  await new Promise((resolve) => setTimeout(resolve, 120));
  await evaluate("void window.IexaBalance.refresh(true); true");
  await wait("document.getElementById('balanceWrap').hidden === false");

  // The key is used server-side only.
  const payload = await (await fetch(`${endpoint}/api/profiles/balance-on/balance`, {
    headers: { Authorization: 'Bearer ' + token },
  })).text();
  assert.doesNotMatch(payload, /sk-test/, 'the API key must never be echoed');
});
