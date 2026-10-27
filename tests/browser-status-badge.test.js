// The sidebar footer carries two pieces of live chrome: a version pill that
// must match package.json, and a three-dot wave that replaces the typed
// ellipsis while a turn runs. Both are rendered by app.js at boot, so only a
// real page proves they exist, are visible, and actually animate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const pkg = require('../package.json');

test('real browser: the footer shows the version pill and a waving busy ellipsis', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-status-'));
  const workspace = path.join(dir, 'workspace');
  const at = Date.now() - 30_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: 'sess_status', title: '状态栏验证', titleSource: 'message', created: at, updated: at, messageCount: 1, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_status.json'), JSON.stringify([
    { role: 'user', content: '开始', timestamp: at },
  ]));
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await wait("document.getElementById('appVersion') && !document.getElementById('appVersion').hidden");

  // The badge must read the real build number, not a hard-coded string.
  const badge = await evaluate(`(() => {
    const el = document.getElementById('appVersion');
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      text: el.textContent.trim(),
      radius: parseFloat(style.borderRadius),
      background: style.backgroundColor,
      padding: style.padding,
      right: Math.round(rect.right),
      footerRight: Math.round(document.querySelector('.sidebar-footer').getBoundingClientRect().right),
      visible: rect.width > 20 && rect.height > 8,
    };
  })()`);
  assert.equal(badge.text, 'Ver ' + pkg.version);
  assert.match(badge.text, /^Ver \d+\.\d+\.\d+$/);
  assert.equal(badge.visible, true, 'the pill is laid out');
  assert.ok(badge.radius >= 8, 'the pill has rounded corners: ' + badge.radius);
  assert.notEqual(badge.background, 'rgba(0, 0, 0, 0)', 'the pill has a background');
  assert.ok(badge.right <= badge.footerRight, 'the pill stays inside the footer');

  // Idle: no dots, status text carries no ellipsis.
  const idle = await evaluate(`(() => ({
    dotsHidden: document.getElementById('statusDots').hidden,
    text: document.getElementById('statusText').textContent.trim(),
  }))()`);
  assert.equal(idle.dotsHidden, true, 'idle status shows no dots');

  // Busy: the ellipsis is drawn, so the text must not also type one.
  // The host reports `system`; this machine asks for reduced motion, so the
  // full-motion branch is driven explicitly instead of trusting the OS.
  await evaluate(`document.documentElement.setAttribute('data-motion', 'full'); true`);
  await evaluate(`setStatusText('处理中…（2 条待发送）'); true`);
  await wait("!document.getElementById('statusDots').hidden");
  const busy = await evaluate(`(() => {
    const dots = document.getElementById('statusDots');
    const items = [...dots.querySelectorAll('i')];
    const styles = items.map((dot) => {
      const style = getComputedStyle(dot);
      return { name: style.animationName, duration: style.animationDuration, delay: style.animationDelay, radius: parseFloat(style.borderRadius) };
    });
    return {
      text: document.getElementById('statusText').textContent,
      count: items.length,
      styles,
      height: Math.round(dots.getBoundingClientRect().height),
    };
  })()`);
  assert.equal(busy.count, 3, 'three dots');
  assert.equal(busy.text, '处理中 · 2', 'the typed ellipsis is gone and the count is compact');
  for (const style of busy.styles) {
    assert.equal(style.name, 'status-wave', 'each dot runs the wave');
    assert.equal(style.duration, '1s', 'one cycle per second');
    assert.ok(style.radius >= 1, 'dots are round');
  }
  assert.deepEqual(busy.styles.map((style) => style.delay), ['0s', '0.16s', '0.32s'], 'the dots are staggered');

  // The wave must actually advance. Under the parallel browser suite a
  // background tab can be throttled, so the page is brought forward and the
  // animation clock is read instead of one painted transform sample.
  await cdp('Page.bringToFront');
  const samples = [];
  for (let index = 0; index < 6; index += 1) {
    samples.push(await evaluate(`(() => {
      const dot = document.querySelector('#statusDots i');
      const animation = dot.getAnimations ? dot.getAnimations()[0] : null;
      return animation ? Math.round(animation.currentTime || 0) : -1;
    })()`));
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  assert.ok(samples.every((value) => value >= 0), 'the dot has a running animation: ' + samples.join(' | '));
  assert.ok(new Set(samples).size > 1, 'the animation clock advances: ' + samples.join(' | '));

  // Completing hides the dots again.
  await evaluate(`setStatusText('就绪'); true`);
  await wait("document.getElementById('statusDots').hidden");
  assert.equal(await evaluate(`document.getElementById('statusText').textContent.trim()`), '就绪');

  // Reduced motion keeps the dots static but still present.
  await evaluate(`document.documentElement.setAttribute('data-motion', 'reduced'); setStatusText('处理中…'); true`);
  await wait("!document.getElementById('statusDots').hidden");
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#statusDots i')).animationName`), 'none');
  await evaluate(`document.documentElement.setAttribute('data-motion', 'full'); true`);

  // Screenshot both states of the footer, cropped, at 3x for review.
  await evaluate(`setStatusText('就绪'); true`);
  await wait("document.getElementById('statusDots').hidden");
  const artifact = path.resolve('.iexa-artifacts/status-badge');
  fs.mkdirSync(artifact, { recursive: true });
  const footer = await evaluate(`(() => { const r = document.querySelector('.sidebar-footer').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const clip = { x: Math.max(0, footer.x - 6), y: Math.max(0, footer.y - 6), width: footer.width + 12, height: footer.height + 12, scale: 3 };
  const idleShot = await cdp('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(path.join(artifact, 'footer-idle.png'), Buffer.from(idleShot.result.data, 'base64'));

  await evaluate(`setStatusText('处理中…（2 条待发送）'); true`);
  await new Promise((resolve) => setTimeout(resolve, 260));
  // A full queue label must stay on one line: ellipsised, never wrapped, and
  // the dots and the pill must not overlap.
  const layout = await evaluate(`(() => {
    const footer = document.querySelector('.sidebar-footer');
    const text = document.getElementById('statusText');
    const dots = document.getElementById('statusDots');
    const pill = document.getElementById('appVersion');
    const fr = footer.getBoundingClientRect();
    return {
      footerHeight: Math.round(fr.height),
      textHeight: Math.round(text.getBoundingClientRect().height),
      textLines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight || '18')),
      dotsRight: Math.round(dots.getBoundingClientRect().right),
      pillLeft: Math.round(pill.getBoundingClientRect().left),
      pillRight: Math.round(pill.getBoundingClientRect().right),
      footerRight: Math.round(fr.right),
      title: text.title,
    };
  })()`);
  assert.ok(layout.footerHeight < 34, 'the footer stays one row: ' + JSON.stringify(layout));
  assert.ok(layout.dotsRight <= layout.pillLeft + 1, 'dots never run under the pill: ' + JSON.stringify(layout));
  assert.ok(layout.pillRight <= layout.footerRight, 'the pill stays inside the footer');
  assert.equal(layout.title, '处理中…（2 条待发送）', 'the full label is still available on hover');

  const busyShot = await cdp('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(path.join(artifact, 'footer-busy.png'), Buffer.from(busyShot.result.data, 'base64'));
  assert.ok(fs.statSync(path.join(artifact, 'footer-idle.png')).size > 500, 'idle screenshot written');
  assert.ok(fs.statSync(path.join(artifact, 'footer-busy.png')).size > 500, 'busy screenshot written');
});
