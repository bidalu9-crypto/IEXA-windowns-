// The running ring marks a session that is still streaming. It has to follow
// the per-session runtime: a background chat keeps running while another one is
// open, and a finished one must lose the ring immediately.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a running session carries a travelling ring', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-ring-'));
  const workspace = path.join(dir, 'workspace');
  const runningId = 'sess_ring_running';
  const idleId = 'sess_ring_idle';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [
      { id: runningId, title: '正在跑的会话', titleSource: 'message', created: at, updated: at, messageCount: 1, projectRoot: '', projectName: '无项目' },
      { id: idleId, title: '已结束的会话', titleSource: 'message', created: at, updated: at - 5000, messageCount: 1, projectRoot: '', projectName: '无项目' },
    ],
  }));
  for (const id of [runningId, idleId]) {
    fs.writeFileSync(path.join(workspace, '.iexa-sessions', id + '.json'), JSON.stringify([
      { role: 'user', content: '开始', timestamp: at },
    ]));
  }
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  let socket;
  let page;
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (page) await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  page = await launchPage();
  socket = page.socket;
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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000);
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await wait("document.querySelectorAll('.session-item').length >= 2");

  const before = await evaluate(`(() => {
    const running = document.querySelector('.session-item[data-id="${runningId}"]');
    const idle = document.querySelector('.session-item[data-id="${idleId}"]');
    return { running: running.classList.contains('is-running'), idle: idle.classList.contains('is-running') };
  })()`);
  assert.equal(before.running, false, 'an idle session has no ring');
  assert.equal(before.idle, false, 'and neither has the other one');

  // Mark only the first session as running, exactly as the stream does.
  await evaluate(`(() => {
    const runtime = sessionRuntimes.get('${runningId}') || {};
    runtime.isProcessing = true;
    sessionRuntimes.set('${runningId}', runtime);
    renderSessionList();
    return true;
  })()`);
  await wait(`document.querySelector('.session-item[data-id="${runningId}"]').classList.contains('is-running')`);

  const ring = await evaluate(`(() => {
    const item = document.querySelector('.session-item[data-id="${runningId}"]');
    const style = getComputedStyle(item);
    const layer = getComputedStyle(item, '::before');
    return {
      hasGradient: layer.backgroundImage.includes('conic-gradient'),
      mask: layer.webkitMaskImage || layer.maskImage,
      radius: style.borderRadius,
      overflow: style.overflow,
      dot: !!item.querySelector('.session-running-dot'),
      stillMarked: layer.backgroundImage !== 'none',
    };
  })()`);
  assert.equal(ring.hasGradient, true, 'the ring is a conic gradient');
  assert.equal(ring.radius, '7px', 'the workbench shell narrows the pill to 7px');
  assert.ok(['hidden', 'visible'].includes(ring.overflow));
  assert.equal(ring.dot, true, 'the old running dot stays as a second cue');

  // `system` on this host resolves to no motion, so both branches are driven
  // explicitly instead of trusting whatever the machine happens to prefer.
  const animation = () => evaluate(`getComputedStyle(document.querySelector('.session-item[data-id="${runningId}"]'), '::before').animationName`);
  await evaluate(`document.documentElement.setAttribute('data-motion', 'full'); true`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await animation(), 'session-ring-spin', 'full motion sweeps the ring');
  await evaluate(`document.documentElement.setAttribute('data-motion', 'reduced'); true`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await animation(), 'none', 'reduced motion keeps the arc still');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.session-item[data-id="${runningId}"]'), '::before').backgroundImage.includes('conic-gradient')`), true, 'the static arc still marks the session');

  // With motion restored, two samples must differ: the angle is advancing.
  // Under the parallel browser suite Chrome may throttle a background tab, so
  // the page is brought forward and the angle is polled instead of sampled once.
  await evaluate(`document.documentElement.setAttribute('data-motion', 'full'); true`);
  await cdp('Page.bringToFront');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const angle = () => evaluate(`getComputedStyle(document.querySelector('.session-item[data-id="${runningId}"]'), '::before').getPropertyValue('--session-ring-angle').trim()`);
  const first = await angle();
  let second = first;
  for (let attempt = 0; attempt < 25 && second === first; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    second = await angle();
  }
  assert.notEqual(first, second, 'the ring angle advances over time (' + first + ' -> ' + second + ')');

  // Finishing removes the ring at once.
  await evaluate(`(() => {
    const runtime = sessionRuntimes.get('${runningId}');
    runtime.isProcessing = false;
    renderSessionList();
    return true;
  })()`);
  await wait(`!document.querySelector('.session-item[data-id="${runningId}"]').classList.contains('is-running')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.session-item[data-id="${runningId}"]'), '::before').backgroundImage`), 'none');
});
