// The transcript notice used to be a full-width red box that never went away.
// These assertions pin the replacement: compact, theme-derived, self-dismissing,
// and paused while the reader is holding it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const LONG_ERROR = 'Git 操作失败：error: pathspec \'.tmp-rea-help.txt\' did not match any file(s) known to git';

test('real browser: the transcript notice is compact, themed and self-dismissing', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-notice-'));
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
  async function wait(expression, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  const move = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  // Headless defaults to reduced motion, which would legitimately disable the
  // countdown animation; this test is about the animated path.
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof addError === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");

  await evaluate(`addError(${JSON.stringify(LONG_ERROR)}); true`);
  await wait("document.querySelectorAll('#chatMessages > .error-message').length === 1");

  const box = await evaluate(`(() => {
    const el = document.querySelector('#chatMessages > .error-message');
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    const transcript = document.getElementById('chatMessages').getBoundingClientRect();
    return {
      width: Math.round(rect.width), height: Math.round(rect.height), transcriptWidth: Math.round(transcript.width),
      role: el.getAttribute('role'),
      fontSize: style.fontSize, borderLeft: style.borderLeftWidth, radius: style.borderRadius,
      background: style.backgroundColor, borderLeftColor: style.borderLeftColor,
      textLines: el.querySelector('.error-message-text').getBoundingClientRect().height,
      // The countdown bar must clear the text: a shrunk flex item used to clip the
      // second line and let the bar run through it.
      textBottomGap: Math.round(rect.bottom - el.querySelector('.error-message-text').getBoundingClientRect().bottom),
      barBottom: parseFloat(after.bottom), barHeight: parseFloat(after.height),
      shrink: style.flexShrink,
      close: !!el.querySelector('.error-message-close'),
      closeLabel: el.querySelector('.error-message-close')?.getAttribute('aria-label'),
      countdown: after.animationName + ' ' + after.animationDuration,
    };
  })()`);

  // Compact: a notice, not a banner. 620px cap, and well under half the transcript.
  assert.ok(box.width <= 620, 'width is capped: ' + box.width);
  assert.ok(box.width < box.transcriptWidth * 0.75, `width ${box.width} stays a fraction of ${box.transcriptWidth}`);
  assert.ok(box.height <= 70, 'height stays compact: ' + box.height);
  // A flex item in the column transcript shrinks by default; that clipped the
  // second line and drew the countdown bar across it.
  assert.equal(box.shrink, '0', 'the notice never shrinks below its content');
  assert.ok(box.textBottomGap >= box.barBottom + box.barHeight + 1,
    `the text clears the countdown bar (gap ${box.textBottomGap}px, bar ends at ${box.barBottom + box.barHeight}px)`);
  assert.equal(box.fontSize, '12px', 'smaller type than the old 15.2px box');
  assert.equal(box.borderLeft, '2px', 'one tinted edge instead of a full border');
  assert.equal(box.radius, '8px');
  assert.equal(box.role, 'alert', 'announced to assistive tech');
  assert.equal(box.close, true);
  assert.equal(box.closeLabel, '关闭提示');
  assert.equal(box.countdown, 'notice-countdown 10s', 'the bar shows the 10 second life');

  // Theme-derived, not a saturated red block: the surface stays close to the
  // panel and only the edge carries the error tint.
  const parse = (value) => (value.match(/[-\d.]+/g) || []).map(Number).slice(0, 3);
  const surface = parse(box.background);
  const edge = parse(box.borderLeftColor);
  assert.ok(Math.abs(surface[0] - surface[1]) < 40, 'the surface is a near-neutral tint, got ' + box.background);
  assert.ok(edge[0] >= edge[1], 'the edge leans red, got ' + box.borderLeftColor);

  // Hovering holds the notice: the bar pauses and the class says so.
  const rect = await evaluate("(() => { const r = document.querySelector('#chatMessages > .error-message').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  await move(rect.x, rect.y);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await evaluate("document.querySelector('#chatMessages > .error-message').classList.contains('is-paused')"), true, 'pointer hold pauses it');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#chatMessages > .error-message'), '::after').animationPlayState"), 'paused');
  await move(5, 5);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await evaluate("document.querySelector('#chatMessages > .error-message').classList.contains('is-paused')"), false, 'and releasing resumes it');

  // The close button is immediate, and does not wait for the timer.
  await evaluate("document.querySelector('#chatMessages > .error-message .error-message-close').click(); true");
  await wait("document.querySelectorAll('#chatMessages > .error-message').length === 0", 3000);

  // A burst is capped: the newest three survive, the rest leave.
  await evaluate("for (let i = 0; i < 5; i += 1) addError('burst ' + i); true");
  await wait("document.querySelectorAll('#chatMessages > .error-message').length === 3", 5000);
  const burst = await evaluate("Array.from(document.querySelectorAll('#chatMessages > .error-message')).map((el) => el.textContent.trim())");
  assert.deepEqual(burst, ['burst 2', 'burst 3', 'burst 4'], 'oldest notices are dropped, newest kept: ' + JSON.stringify(burst));

  // And the timer really fires: the last one is gone after its ten seconds.
  await evaluate("document.querySelectorAll('#chatMessages > .error-message').forEach((el) => el.remove()); addError('expires on its own'); true");
  await wait("document.querySelectorAll('#chatMessages > .error-message').length === 1", 3000);
  const startedAt = Date.now();
  await wait("document.querySelectorAll('#chatMessages > .error-message').length === 0", 14000);
  const lived = Date.now() - startedAt;
  assert.ok(lived >= 9000 && lived <= 13000, `it lived about ten seconds, not ${lived}ms`);
});
