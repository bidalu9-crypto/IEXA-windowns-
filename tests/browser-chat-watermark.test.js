// The brand watermark is decorative: hidden on the landing screen (which has its
// own mark), visible once a conversation exists, and painted strictly behind the
// transcript so it can never tint or cover a message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');
const sharp = require('sharp');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the watermark stays behind the transcript and skips the landing', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-watermark-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_watermark';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '水印', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '层级验证', timestamp: at },
    { role: 'assistant', content: '这一段文字必须始终压在水印之上，不能被任何背景遮住。', status: 'done', timestamp: at + 2000, durationMs: 2000 },
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
    await new Promise((r) => server.close(r));
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
      await new Promise((r) => setTimeout(r, 100));
    }
    const snapshot = await evaluate(`(() => ({
      welcome: document.getElementById('view-chat').classList.contains('is-welcome'),
      messages: document.querySelectorAll('#chatMessages .message').length,
      current: typeof currentSessionId === 'string' ? currentSessionId : null,
      visible: typeof visibleSessionId === 'string' ? visibleSessionId : null,
      runtime: typeof sessionRuntimes !== 'undefined' && sessionRuntimes.has('sess_watermark')
        ? { ready: sessionRuntimes.get('sess_watermark').historyReady, count: (sessionRuntimes.get('sess_watermark').historyMessages || []).length }
        : null,
      loading: !!document.querySelector('.history-loading'),
      body: (document.querySelector('#chatMessages') || {}).textContent?.slice(0, 120),
    }))()`);
    throw new Error('UI condition timeout: ' + expression + ' :: ' + JSON.stringify(snapshot));
  }
  const mark = () => evaluate(`(() => {
    const area = document.querySelector('.chat-messages-area');
    const style = getComputedStyle(area, '::before');
    return {
      welcome: document.getElementById('view-chat').classList.contains('is-welcome'),
      opacity: Number(style.opacity),
      position: style.position,
      pointer: style.pointerEvents,
      zIndex: style.zIndex,
      image: style.backgroundImage,
      isolation: getComputedStyle(area).isolation,
    };
  })()`);

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");

  // Landing: the hero already carries the mark, so the watermark must be off.
  await evaluate("(async () => { await createSession(); return true; })()");
  await wait("document.getElementById('view-chat').classList.contains('is-welcome')");
  const landing = await mark();
  assert.equal(landing.welcome, true);
  assert.equal(landing.opacity, 0, 'the landing screen has no watermark');

  // A conversation: the mark appears.
  await evaluate(`(async () => { await switchSession('${sessionId}'); return true; })()`);
  await wait("!document.getElementById('view-chat').classList.contains('is-welcome') && document.querySelectorAll('#chatMessages .message').length === 2");
  await new Promise((r) => setTimeout(r, 600));
  const chat = await mark();
  assert.equal(chat.welcome, false);
  assert.ok(chat.opacity > 0.02 && chat.opacity < 0.2, `subtle but visible, got ${chat.opacity}`);
  assert.match(chat.image, /mobile-pair-logo\.png/, 'it is the brand mark');
  assert.equal(chat.position, 'absolute', 'it cannot take part in layout');
  assert.equal(chat.pointer, 'none', 'it never receives a click');
  assert.equal(chat.zIndex, '-1', 'it paints below in-flow content');
  assert.equal(chat.isolation, 'isolate', 'the negative index stays inside the message area');

  // Paint-order proof: put an opaque red block where the mark sits. If the mark
  // were above the transcript, every neutral dark glyph pixel would disappear.
  const rect = await evaluate(`(() => {
    const box = document.querySelectorAll('#chatMessages .message.assistant')[0].getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  })()`);
  const darkPixels = async () => {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    const { data, info } = await sharp(Buffer.from(shot.result.data, 'base64')).raw().toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      // Neutral dark only: pure red reads as "dark" by luma and would poison it.
      if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) count += 1;
    }
    return count;
  };
  const baseline = await darkPixels();
  assert.ok(baseline > 200, 'the fixture actually renders text: ' + baseline);

  await evaluate(`(() => {
    const style = document.createElement('style');
    style.id = 'probe-opaque-mark';
    style.textContent = '.chat-messages-area::before { background-image: none !important; background-color: #ff0000 !important; opacity: 1 !important; }';
    document.head.appendChild(style);
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const covered = await darkPixels();
  await evaluate("document.getElementById('probe-opaque-mark')?.remove(); true");

  assert.ok(covered >= baseline * 0.95,
    `the text stays above the mark: ${covered} of ${baseline} glyph pixels survived an opaque block`);

  // Visibility proof: the mark must actually contribute pixels. Muting it alone
  // (no layout change) has to alter the canvas, otherwise it is hiding behind an
  // opaque background while every structural assertion still passes.
  const areaRect = await evaluate(`(() => {
    const box = document.querySelector('.chat-messages-area').getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  })()`);
  const areaPixels = async () => {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...areaRect, scale: 1 } });
    return (await sharp(Buffer.from(shot.result.data, 'base64')).raw().toBuffer({ resolveWithObject: true })).data;
  };
  const visible = await areaPixels();
  await evaluate(`(() => {
    const style = document.createElement('style');
    style.id = 'probe-mute-mark';
    style.textContent = '.chat-messages-area::before { opacity: 0 !important; transition: none !important; }';
    document.head.appendChild(style);
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  const muted = await areaPixels();
  await evaluate("document.getElementById('probe-mute-mark')?.remove(); true");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(visible.length, muted.length);
  let changed = 0;
  for (let i = 0; i < visible.length; i += 1) if (visible[i] !== muted[i]) changed += 1;
  assert.ok(changed > 500, `the mark is genuinely painted (${changed} channel bytes differ when muted)`);

  // No layout side effects: a pseudo-element cannot scroll the page sideways.
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);

  // Dark theme deepens it a little so it reads on the darker canvas.
  await evaluate("document.documentElement.dataset.theme = 'dark'; true");
  await new Promise((r) => setTimeout(r, 400));
  const dark = await mark();
  assert.ok(dark.opacity > chat.opacity, `dark theme opacity ${dark.opacity} > light ${chat.opacity}`);
});
