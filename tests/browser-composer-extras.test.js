// The composer must come back to life when a parked turn resumes, and the
// screenshot button must open a working annotation surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: resume unlocks the composer and screenshots annotate', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-composer-extras-'));
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
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* lock */ }
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

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await wait("typeof handlePaused === 'function' && typeof syncPausedBanner === 'function'");

  // The camera sits left of the microphone, then send/stop at the edge.
  assert.deepEqual(
    await evaluate("Array.from(document.querySelectorAll('.input-actions > button')).map((b) => b.id)"),
    ['screenshotBtn', 'voiceBtn', 'sendBtn', 'stopBtn'],
    'action row order',
  );

  // --- Pause parks the composer, resume must restore a live turn's controls ---
  await evaluate(`(() => {
    window.__realFetch = window.fetch;
    window.__continueBody = null;
    window.fetch = async (input, init) => {
      if (String(input) === '/api/chat') {
        window.__continueBody = JSON.parse((init && init.body) || '{}');
        return new Response(new ReadableStream({
          start(controller) {
            window.__pushContinue = (frame) => controller.enqueue(new TextEncoder().encode(frame));
            controller.enqueue(new TextEncoder().encode('event: turn_started\\ndata: {}\\n\\n'));
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
    isProcessing = true;
    runtimeForSession(currentSessionId).isProcessing = true;
    setProcessing(true);
    handlePaused(null);
    return true;
  })()`);

  const parked = await evaluate(`({
    banner: document.getElementById('pausedBanner').hidden,
    input: chatInput.disabled,
    send: sendBtn.style.display,
    stop: stopBtn.style.display,
    attach: attachBtn.disabled,
    shot: screenshotBtn.disabled,
  })`);
  assert.equal(parked.banner, false, 'the banner is visible while parked');
  assert.equal(parked.input, true, 'typing waits while parked');
  assert.equal(parked.send, 'none', 'no send button while parked');
  assert.equal(parked.stop, 'none', 'no stop button while parked');
  assert.equal(parked.shot, true, 'screenshot waits while parked');

  await evaluate("void resumeProcessing(); true");
  await wait("document.getElementById('pausedBanner').hidden === true");
  assert.equal(await evaluate("window.__continueBody && window.__continueBody.continueTurn"), true,
    'continuing asks the server to carry on from disk');

  const resumed = await evaluate(`({
    input: chatInput.disabled,
    send: sendBtn.style.display,
    stop: stopBtn.style.display,
    attach: attachBtn.disabled,
    shot: screenshotBtn.disabled,
    status: document.getElementById('statusText').textContent,
  })`);
  assert.equal(resumed.input, false, 'the input unlocks the moment the turn resumes');
  assert.equal(resumed.stop, 'flex', 'stop is the visible action again');
  assert.equal(resumed.send, 'none', 'send stays hidden while the turn is still running');
  assert.equal(resumed.shot, false, 'screenshot is usable again');
  assert.match(resumed.status, /继续中|处理中/);

  // A finished turn swaps back to send, and typing works.
  await evaluate("setProcessing(false); true");
  assert.equal(await evaluate("sendBtn.style.display"), 'flex');
  assert.equal(await evaluate("stopBtn.style.display"), 'none');
  await evaluate("chatInput.focus(); chatInput.value = 'typed'; true");
  assert.equal(await evaluate("chatInput.value"), 'typed', 'the input accepts text after a resume');

  // --- Voice button: no ring, gradient mic while listening ---
  const voice = await evaluate(`(() => {
    const b = document.getElementById('voiceBtn');
    const icon = b.querySelector('.voice-icon');
    const idleBorder = getComputedStyle(b).borderTopWidth;
    const idleStroke = getComputedStyle(icon).stroke;
    b.classList.add('is-listening');
    // getComputedStyle returns a live declaration: read the strings before the
    // class is removed, otherwise every value reflects the idle state again.
    const listeningStroke = getComputedStyle(icon).stroke;
    const listeningFilter = getComputedStyle(icon).filter;
    b.classList.remove('is-listening');
    return { border: idleBorder, idleStroke, listeningStroke, filter: listeningFilter };
  })()`);
  assert.equal(voice.border, '0px', 'the circle is gone');
  assert.equal(voice.idleStroke, 'rgb(94, 94, 100)', 'idle keeps the plain icon colour');
  assert.match(voice.listeningStroke, /voice-gradient/, 'listening paints the mic with the gradient');
  assert.match(voice.filter, /drop-shadow/, 'listening adds a soft bloom');

  // --- Screenshot: capture, select, annotate, confirm ---
  await evaluate(`(() => {
    const source = document.createElement('canvas');
    source.width = 400; source.height = 300;
    const ctx = source.getContext('2d');
    let alive = true;
    // A canvas capture stream only emits frames when the surface changes, so the
    // fixture keeps painting; a still image would leave the video without a frame.
    const paint = () => {
      if (!alive) return;
      ctx.fillStyle = '#3366cc'; ctx.fillRect(0, 0, 400, 300);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(40, 40, 120, 80);
      requestAnimationFrame(paint);
    };
    paint();
    navigator.mediaDevices.getDisplayMedia = async () => {
      const stream = source.captureStream(30);
      window.__stopShotSource = () => { alive = false; for (const track of stream.getTracks()) track.stop(); };
      return stream;
    };
    return true;
  })()`);

  await evaluate("screenshotBtn.click(); true");
  await wait("!!document.querySelector('.shot-overlay.is-ready')");

  const overlay = await evaluate(`(() => {
    const root = document.querySelector('.shot-overlay');
    return {
      tools: Array.from(root.querySelectorAll('.shot-tool')).map((n) => n.dataset.tool),
      colors: root.querySelectorAll('.shot-color').length,
      actions: Array.from(root.querySelectorAll('.shot-action')).map((n) => n.textContent),
      hint: root.querySelector('.shot-hint').textContent,
      canvas: [root.querySelector('canvas').width, root.querySelector('canvas').height],
    };
  })()`);
  assert.deepEqual(overlay.tools, ['select', 'rect', 'arrow', 'pen']);
  assert.equal(overlay.colors, 6);
  assert.deepEqual(overlay.actions, ['撤销', '重选', '取消', '完成']);
  assert.match(overlay.hint, /拖拽框选/);

  // Drag a selection over the frame.
  await evaluate(`(() => {
    const canvas = document.querySelector('.shot-canvas');
    const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
    send('pointerdown', 240, 220);
    send('pointermove', 320, 280);
    send('pointermove', 520, 430);
    send('pointerup', 520, 430);
    return true;
  })()`);
  await wait("document.querySelector('.shot-overlay').classList.contains('has-selection')");
  assert.match(await evaluate("document.querySelector('.shot-hint').textContent"), /Enter 完成/);

  // Draw an arrow inside the selection.
  await evaluate(`(() => {
    document.querySelector('.shot-tool[data-tool="arrow"]').click();
    document.querySelector('.shot-color[data-color="#ef4444"]').click();
    const canvas = document.querySelector('.shot-canvas');
    const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 2 }));
    send('pointerdown', 280, 250);
    send('pointermove', 400, 330);
    send('pointerup', 460, 390);
    return true;
  })()`);
  assert.equal(await evaluate("document.querySelector('.shot-tool[data-tool=arrow]').getAttribute('aria-pressed')"), 'true');
  assert.equal(await evaluate("document.querySelector('.shot-color[data-color=\"#ef4444\"]').getAttribute('aria-pressed')"), 'true');
  assert.equal(await evaluate("document.querySelector('.shot-action:not(.shot-primary)').disabled"), false, 'undo is enabled once something is drawn');

  // Undo, redraw, then confirm.
  await evaluate("document.querySelector('.shot-action:not(.shot-primary)').click(); true");
  await evaluate(`(() => {
    const canvas = document.querySelector('.shot-canvas');
    const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 3 }));
    send('pointerdown', 300, 260);
    send('pointermove', 420, 340);
    send('pointerup', 500, 400);
    return true;
  })()`);
  await evaluate("document.querySelector('.shot-primary').click(); true");
  await wait("!document.querySelector('.shot-overlay')");
  await wait("document.querySelectorAll('#attachPreview .attach-item, #attachPreview > *').length > 0");

  const attachment = await evaluate(`(() => {
    const item = document.querySelector('#attachPreview > *');
    const img = item?.querySelector('img');
    return { name: item?.textContent.trim() || '', src: img?.getAttribute('src') || '', width: img?.naturalWidth || 0, height: img?.naturalHeight || 0 };
  })()`);
  assert.match(attachment.name, /截图/, 'the capture arrives as a named attachment');
  assert.match(attachment.src, /^data:image\/png/, 'it is a real PNG payload');
  // The selection is 280x210 display pixels over a 400x300 frame fitted into
  // 1280x800 (scale 2.667), so the crop must land at 105x79 image pixels.
  assert.ok(Math.abs(attachment.width - 105) <= 2, 'crop width maps back to image pixels: ' + attachment.width);
  assert.ok(Math.abs(attachment.height - 79) <= 2, 'crop height maps back to image pixels: ' + attachment.height);
});
