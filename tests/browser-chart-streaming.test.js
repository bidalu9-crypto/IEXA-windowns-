// The chart used to appear only after the turn ended. Rendering it mid-stream is
// easy; keeping it there is the hard part: patch() reconciles against the markdown
// template, which still contains the <pre>, so a naive enhancer has its card deleted
// on the very next delta. These tests pin both halves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a chart renders mid-stream and survives the next delta', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-chart-live-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
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
    for (let index = 0; index < 160; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof renderMarkdownContent === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");

  const report = await evaluate(`(() => {
    const host = document.getElementById('chatMessages');
    host.replaceChildren();
    const message = document.createElement('div');
    message.className = 'message assistant';
    const body = document.createElement('div');
    body.className = 'message-content';
    message.appendChild(body);
    host.appendChild(message);

    const fence = String.fromCharCode(96).repeat(3);
    const nl = String.fromCharCode(10);
    const spec = JSON.stringify({ type: 'line', title: '实时', categories: ['a', 'b', 'c'],
      series: [{ name: 's', values: [1, 3, 2] }] });
    const head = '开场白' + nl + nl + fence + 'chart' + nl;
    const tail = nl + fence + nl;
    const out = {};

    // 1. Half-written body: no card, no error banner, the block stays a <pre>.
    renderMarkdownContent(body, head + '{"type":"line","categories":["a"', false);
    out.partial = { cards: body.querySelectorAll('.chart-card').length, banners: body.querySelectorAll('.chart-error').length };

    // 2. Fence closes: the card appears while the turn is still streaming.
    renderMarkdownContent(body, head + spec + tail, false);
    out.complete = body.querySelectorAll('.chart-card').length;
    const card = body.querySelector('.chart-card');
    if (card) card.dataset.probeId = 'original';

    // 3. The model keeps writing: the same card node must survive.
    renderMarkdownContent(body, head + spec + tail + nl + '继续输出。', false);
    out.afterDelta = body.querySelectorAll('.chart-card').length;
    out.sameNode = !!body.querySelector('.chart-card[data-probe-id="original"]');
    out.preBack = body.querySelectorAll('pre > code.language-chart').length;

    // 4. Two more deltas, still one card.
    renderMarkdownContent(body, head + spec + tail + nl + '继续输出。' + nl + '还有。', false);
    renderMarkdownContent(body, head + spec + tail + nl + '继续输出。' + nl + '还有。' + nl + '结束。', false);
    out.stable = body.querySelectorAll('.chart-card').length;
    out.lines = body.querySelectorAll('.chart-card .chart-line').length;

    // 5. A second chart later in the same message also appears mid-stream.
    const two = head + spec + tail + nl + '中间' + nl + nl + fence + 'chart' + nl +
      JSON.stringify({ type: 'bar', title: '第二张', categories: ['x', 'y'],
        series: [{ name: 'n', values: [4, 7] }] }) + tail;
    renderMarkdownContent(body, two, false);
    out.twoCharts = body.querySelectorAll('.chart-card').length;
    out.bars = body.querySelectorAll('.chart-card .chart-bar').length;

    return out;
  })()`);

  assert.deepEqual(report.partial, { cards: 0, banners: 0 },
    'a half-written spec shows neither a card nor an error banner');
  assert.equal(report.complete, 1, 'the card appears as soon as the fence closes');
  assert.equal(report.afterDelta, 1, 'and is not duplicated by the next delta');
  assert.equal(report.sameNode, true, 'the same node survives, so the SVG is not rebuilt');
  assert.equal(report.preBack, 0, 'the placeholder <pre> does not come back');
  assert.equal(report.stable, 1, 'further deltas keep exactly one card');
  assert.equal(report.lines, 1, 'the chart still has its series');
  assert.equal(report.twoCharts, 2, 'a second chart later in the message also renders');
  assert.equal(report.bars, 2, 'with its own bars');
});
