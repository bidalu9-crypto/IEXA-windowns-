'use strict';
// The reasoning slider draws its own rail: theme accent below the top step, and
// a violet-white sheen with travelling sparks on the last one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the reasoning slider fills with the accent and shimmers at the top step', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-thinking-slider-'));
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
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof applyThinkingLevelUI === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");
  // Headless reports reduce, and the app suppresses motion outside full mode.
  await evaluate("document.documentElement.dataset.motion = 'full'; true");
  await evaluate("document.getElementById('thinkingLevelBtn').click(); true");
  await wait("document.getElementById('thinkingLevelMenu').style.display !== 'none'");

  const read = `(() => {
    const track = document.getElementById('thinkingSliderTrack');
    const fill = track.querySelector('.thinking-slider-fill');
    const sheen = track.querySelector('.thinking-slider-sheen');
    const flow = track.querySelector('.thinking-slider-flow');
    const ticks = document.getElementById('thinkingSliderTicks');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;background:var(--action-bg)';
    document.body.appendChild(probe);
    const accentFill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      atMax: track.dataset.atMax,
      width: getComputedStyle(fill).width,
      background: getComputedStyle(fill).backgroundColor,
      image: getComputedStyle(fill).backgroundImage,
      sheenOpacity: getComputedStyle(sheen).opacity,
      sheenAnimation: getComputedStyle(sheen).animationName,
      flowOpacity: getComputedStyle(flow).opacity,
      flowAnimation: getComputedStyle(flow, '::before').animationName,
      ticksOpacity: getComputedStyle(ticks).opacity,
      accentFill,
    };
  })()`;

  // Below the top step: a plain theme-accent bar, no sheen, no sparks.
  const normal = await evaluate(read);
  assert.equal(normal.atMax, 'false');
  assert.equal(normal.background, normal.accentFill, 'the fill is the theme action colour');
  assert.equal(normal.image, 'none', 'no gradient below the top step');
  assert.equal(normal.flowOpacity, '0', 'sparks stay hidden');
  assert.equal(normal.sheenOpacity, '0', 'the sweep stays hidden');
  assert.equal(normal.ticksOpacity, '1', 'step dots remain visible');

  // Top step: violet-white sheen, travelling sparks, dots give way.
  await evaluate("setThinkingLevel('xhigh', { skipSave: true, keepOpen: true }); true");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const top = await evaluate(read);
  assert.equal(top.atMax, 'true');
  assert.match(top.image, /linear-gradient/, 'the top step paints a gradient: ' + top.image);
  assert.match(top.sheenAnimation, /thinking-max-sheen/, 'the sweep animates: ' + top.sheenAnimation);
  assert.match(top.flowAnimation, /thinking-max-flow/, 'the sparks animate: ' + top.flowAnimation);
  assert.ok(Number(top.flowOpacity) > 0.7, 'the sparks are visible: ' + top.flowOpacity);
  assert.equal(top.ticksOpacity, '0', 'the step dots fade out under the sparks');

  // Back down: the gradient is gone and the bar follows a new accent.
  await evaluate("document.documentElement.dataset.accent = 'green'; setThinkingLevel('medium', { skipSave: true, keepOpen: true }); true");
  await new Promise((resolve) => setTimeout(resolve, 260));
  const green = await evaluate(read);
  assert.equal(green.atMax, 'false');
  assert.equal(green.image, 'none');
  assert.equal(green.background, green.accentFill, 'the fill tracks the new accent');
  assert.notEqual(green.background, normal.background, 'a different accent repaints the bar');

  // The compact button carries the top-step tint as well.
  await evaluate("setThinkingLevel('xhigh', { skipSave: true, keepOpen: true }); true");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await evaluate("document.getElementById('thinkingLevelBtn').dataset.atMax"), 'true');

  assert.deepEqual(await evaluate("(document.getElementById('thinkingLevelSlider').max|0)"), 4);
});
