// Regression guard for the image lightbox gallery.
//
// The lightbox used to show exactly one picture: openImagePreview(src, name)
// replaced the <img> and that was it, so a turn with several attachments could
// only be inspected by closing and reopening the dialog one image at a time.
// It now collects every picture in the open conversation, pages through them
// with arrows / keyboard / a film strip, and zooms with the wheel or buttons.
//
// The test drives a real browser: it opens the gallery from a real click on a
// thumbnail, pages with the keyboard, zooms at the pointer, pans, resets, and
// checks the single-image case collapses the navigation away.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

// 1600x1200 so that a 2.5x zoom genuinely overflows the stage and the pan is
// not clamped back to zero.
function svgDataUrl(color, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">`
    + `<rect width="1600" height="1200" fill="${color}"/>`
    + `<text x="800" y="660" font-size="220" text-anchor="middle" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const IMAGES = [
  { name: 'one-red.svg', dataUrl: svgDataUrl('#c0392b', 'ONE') },
  { name: 'two-green.svg', dataUrl: svgDataUrl('#1e8449', 'TWO') },
  { name: 'three-blue.svg', dataUrl: svgDataUrl('#1f4e9c', 'THREE') },
];

function seedWorkspace(dir) {
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  const now = Date.now();
  const user = (text, attachments) => ({ role: 'user', content: text, attachments, timestamp: now });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: 'sess_multi',
    sessions: [
      { id: 'sess_multi', title: '多图预览', created: now, updated: now, messageCount: 3, projectRoot: '', projectName: '', pinned: false },
      { id: 'sess_single', title: '单图预览', created: now - 1000, updated: now - 1000, messageCount: 1, projectRoot: '', projectName: '', pinned: false },
    ],
  }));
  const multi = [
    user('第一张', [{ kind: 'image', name: IMAGES[0].name, dataUrl: IMAGES[0].dataUrl }]),
    user('第二张', [{ kind: 'image', name: IMAGES[1].name, dataUrl: IMAGES[1].dataUrl }]),
    user('第三张', [{ kind: 'image', name: IMAGES[2].name, dataUrl: IMAGES[2].dataUrl }]),
  ];
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_multi.json'), JSON.stringify(multi));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_single.json'), JSON.stringify([
    user('只有一个', [{ kind: 'image', name: IMAGES[0].name, dataUrl: IMAGES[0].dataUrl }]),
  ]));
  return workspace;
}

test('real browser: image lightbox pages through a conversation and zooms', { skip: !browser, timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-gallery-'));
  process.env.IEXA_WORKSPACE = seedWorkspace(dir);
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
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Chromium releases its profile handles shortly after exit; on Windows a
    // recursive delete can still race that teardown. Cleanup must never turn a
    // passing UI assertion into a failed test.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn('[image-gallery] temp cleanup deferred:', error.message);
    }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 15000);
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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10000);
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
    for (let i = 0; i < 150; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch { /* not ready yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }
  const settle = (ms = 260) => new Promise(resolve => setTimeout(resolve, ms));
  async function mouse(type, x, y, extra = {}) {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  }
  async function key(keyName, code, virtualKeyCode) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
    await settle(140);
  }
  async function clickCenter(selector) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    assert.ok(box, `missing element ${selector}`);
    await mouse('mouseMoved', box.x, box.y, { button: 'none' });
    await mouse('mousePressed', box.x, box.y);
    await mouse('mouseReleased', box.x, box.y);
    await settle();
    return box;
  }

  const overlayOpen = "document.getElementById('imagePreviewOverlay').style.display !== 'none'";
  const counterText = "document.getElementById('imagePreviewCounter').textContent";
  const current = () => evaluate(`(() => {
    const img = document.getElementById('imagePreviewImage');
    const style = getComputedStyle(img);
    const matrix = style.transform === 'none' ? null : new DOMMatrix(style.transform);
    return {
      src: img.currentSrc || img.src,
      scale: matrix ? matrix.a : 1,
      x: matrix ? matrix.e : 0,
      y: matrix ? matrix.f : 0,
      label: document.getElementById('imagePreviewZoomLabel').textContent,
      touchAction: getComputedStyle(document.getElementById('imagePreviewStage')).touchAction,
    };
  })()`);

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1323, height: 859, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'", 'app shell');
  await wait("document.querySelectorAll('.message-image-attach').length === 3", 'three attachment thumbnails');

  // ---- opening from a real click picks that image and keeps the set --------
  await clickCenter('.message-image-attach');
  await wait(overlayOpen, 'gallery open');
  assert.equal(await evaluate(counterText), '1 / 3', 'counter starts on the clicked image');
  assert.equal(await evaluate("document.querySelectorAll('.image-preview-thumb').length"), 3, 'film strip lists every image in the conversation');
  assert.equal(await evaluate("document.querySelector('.image-preview-thumb.is-active').dataset.index"), '0');
  assert.equal(await evaluate("document.getElementById('imagePreviewPrev').offsetParent !== null"), true, 'previous arrow is available with several images');

  // ---- keyboard paging ----------------------------------------------------
  await key('ArrowRight', 'ArrowRight', 39);
  assert.equal(await evaluate(counterText), '2 / 3', 'ArrowRight advances');
  const second = await current();
  assert.equal((await evaluate("document.querySelector('.image-preview-thumb.is-active').dataset.index")), '1');
  assert.ok(second.src.startsWith('data:image/svg+xml'), 'second image is loaded');

  await key('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await evaluate(counterText), '1 / 3', 'ArrowLeft goes back');

  // ---- wrap-around through the arrow buttons ------------------------------
  await evaluate("document.getElementById('imagePreviewPrev').click()");
  await settle(150);
  assert.equal(await evaluate(counterText), '3 / 3', 'paging left from the first image wraps to the last');
  await evaluate("document.getElementById('imagePreviewNext').click()");
  await settle(150);
  assert.equal(await evaluate(counterText), '1 / 3', 'paging right from the last image wraps to the first');

  // ---- wheel zoom anchored at the pointer ---------------------------------
  const stage = await evaluate(`(() => {
    const r = document.getElementById('imagePreviewStage').getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.62), y: Math.round(r.top + r.height * 0.4) };
  })()`);
  await mouse('mouseMoved', stage.x, stage.y, { button: 'none' });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: stage.x, y: stage.y, deltaX: 0, deltaY: -300, button: 'none' });
  await settle(200);
  const zoomed = await current();
  assert.ok(zoomed.scale > 1.2, `wheel should zoom in (scale ${zoomed.scale})`);
  assert.equal(zoomed.label, `${Math.round(zoomed.scale * 100)}%`, 'the label reports the current zoom');
  assert.notEqual(zoomed.label, '100%');
  assert.equal(await evaluate("document.getElementById('imagePreviewBody').classList.contains('is-zoomed')"), true);

  // The zoom is anchored at the cursor, so a pointer left of centre pushes the
  // image right rather than scaling from the middle.
  assert.ok(Math.abs(zoomed.x) > 1, `zoom should be anchored at the pointer (translate ${zoomed.x})`);

  // ---- drag to pan --------------------------------------------------------
  const beforePan = await current();
  await mouse('mousePressed', stage.x, stage.y);
  await mouse('mouseMoved', stage.x + 70, stage.y + 40, { buttons: 1 });
  await mouse('mouseReleased', stage.x + 70, stage.y + 40);
  await settle(200);
  const panned = await current();
  assert.ok(Math.abs(panned.x - beforePan.x) > 20 || Math.abs(panned.y - beforePan.y) > 20,
    `dragging should pan the zoomed image (${beforePan.x},${beforePan.y} -> ${panned.x},${panned.y})`);
  assert.equal(await evaluate("document.getElementById('imagePreviewBody').classList.contains('is-panning')"), false, 'the pan state is cleared on pointerup');

  // ---- reset and the +/- buttons -----------------------------------------
  await evaluate("document.getElementById('imagePreviewZoomReset').click()");
  await settle(150);
  const reset = await current();
  assert.equal(reset.scale, 1, 'reset returns to fit');
  assert.equal(reset.label, '100%');
  assert.equal(await evaluate("document.getElementById('imagePreviewImage').style.transform"), '', 'fit leaves no transform behind');

  await evaluate("document.getElementById('imagePreviewZoomIn').click()");
  await settle(120);
  assert.ok((await current()).scale > 1.2, 'the + button zooms in');
  await evaluate("document.getElementById('imagePreviewZoomOut').click()");
  await settle(120);
  assert.equal((await current()).scale, 1, 'the - button returns to fit');
  assert.equal(await evaluate("document.getElementById('imagePreviewZoomOut').disabled"), true, 'the - button disables at fit');

  // ---- film strip jump ----------------------------------------------------
  await evaluate("document.querySelector('.image-preview-thumb[data-index=\"2\"]').click()");
  await settle(200);
  assert.equal(await evaluate(counterText), '3 / 3', 'the film strip jumps to the clicked image');
  assert.equal(await evaluate("document.querySelector('.image-preview-thumb.is-active').dataset.index"), '2');
  assert.equal((await current()).scale, 1, 'switching images resets the zoom');

  // ---- escape closes and restores focus ----------------------------------
  await key('Escape', 'Escape', 27);
  await settle(200);
  assert.equal(await evaluate(overlayOpen), false, 'Escape closes the gallery');
  assert.equal(await evaluate("document.activeElement.classList.contains('message-image-attach')"), true, 'focus returns to the thumbnail');

  // ---- a single image collapses the navigation ----------------------------
  await evaluate("switchSession('sess_single')");
  await wait("document.querySelectorAll('.message-image-attach').length === 1", 'single-image conversation');
  await clickCenter('.message-image-attach');
  await wait(overlayOpen, 'single image gallery open');
  assert.equal(await evaluate("document.getElementById('imagePreviewCounter').hidden"), true, 'no counter for a lone image');
  assert.equal(await evaluate("document.getElementById('imagePreviewStrip').hidden"), true, 'no film strip for a lone image');
  assert.equal(await evaluate("document.getElementById('imagePreviewPrev').offsetParent === null"), true, 'arrows are not shown for a lone image');
  assert.equal(await evaluate("document.getElementById('imagePreviewNext').offsetParent === null"), true);

  assert.deepEqual(exceptions, [], 'no renderer exceptions while paging and zooming');
});
