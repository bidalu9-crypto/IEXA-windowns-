'use strict';
// The pet page end to end: a transparent PNG takes the fast path, then a plain
// photo goes through the real u2netp model. One server and one browser are
// shared because the server module binds its workspace on first require.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('real browser: pet sprites upload, cut out and summon', { skip: !browser, timeout: 300000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-pet-page-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
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
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 120000);
    waiting.set(id, { resolve, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 500));
    return result.result?.result?.value;
  };
  const wait = async (expression, ms = 200000) => {
    const started = Date.now();
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() - started > ms) throw new Error('UI condition timeout: ' + expression);
      await sleep(250);
    }
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof petHandleFile === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");

  await evaluate("document.querySelector('.nav-btn[data-view=\"pet\"]').click(); true");
  await wait("document.getElementById('view-pet').classList.contains('active')");

  assert.equal(await evaluate("document.getElementById('petSummon').disabled"), true, 'summon is disabled without a sprite');
  assert.equal(await evaluate("document.getElementById('petSizeHint').textContent"), '还没有形象');

  // ---- fast path: the image already carries transparency ------------------
  await evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 240;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 200, 240);
    x.fillStyle = '#3f7bd6'; x.beginPath(); x.ellipse(100, 130, 70, 95, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(78, 105, 12, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(122, 105, 12, 0, Math.PI * 2); x.fill();
    window.__petBlob = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    return true;
  })()`);
  await evaluate("window.__petBlob.then(b => petHandleFile(new File([b], 'pet.png', { type: 'image/png' })))", true);
  await wait("document.getElementById('petDrop').classList.contains('has-image')");
  await wait("(() => { const i = document.getElementById('petPreview'); return i.complete && i.naturalWidth > 0; })()");

  const preview = await evaluate(`(() => {
    const img = document.getElementById('petPreview');
    return { src: img.src, natural: [img.naturalWidth, img.naturalHeight],
      summon: document.getElementById('petSummon').textContent,
      disabled: document.getElementById('petSummon').disabled,
      hint: document.getElementById('petSizeHint').textContent };
  })()`);
  assert.match(preview.src, /\/api\/pet\/sprite\?v=/);
  // The transparent margin is trimmed: 140x190 content plus 4px padding.
  assert.deepEqual(preview.natural, [148, 198]);
  assert.equal(preview.disabled, false);
  assert.equal(preview.summon, '召唤桌宠');
  assert.match(preview.hint, /148 × 198 像素/);

  await evaluate("const s = document.getElementById('petScale'); s.value = '150'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); true");
  await wait("document.getElementById('petScaleValue').textContent === '150%'");
  await sleep(350);
  const scaled = await evaluate("fetch('/api/pet').then(r => r.json())", true);
  assert.equal(scaled.config.scale, 1.5);
  assert.match(await evaluate("document.getElementById('petSizeHint').textContent"), /222 × 297/);

  await evaluate("const w = document.getElementById('pet-wander'); w.checked = false; w.dispatchEvent(new Event('change')); true");
  await sleep(350);
  assert.equal((await evaluate("fetch('/api/pet').then(r => r.json())", true)).config.wander, false);

  await evaluate("document.getElementById('petSummon').click(); true");
  await wait("fetch('/api/pet').then(r => r.json()).then(s => s.config.visible === true)");
  assert.equal(await evaluate("document.getElementById('petSummon').textContent"), '收起桌宠');

  await evaluate("document.getElementById('petClear').click(); true");
  await wait("!!document.querySelector('.iexa-app-dialog[open]')");
  await evaluate("document.querySelector('.iexa-app-dialog .btn-primary').click(); true");
  await wait("!document.getElementById('petDrop').classList.contains('has-image')");
  assert.equal(await evaluate("document.getElementById('petSummon').disabled"), true);

  // ---- real cut-out: a plain photo through u2netp ------------------------
  const result = await evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 320;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 320, 320);
    x.fillStyle = '#d94a4a'; x.beginPath(); x.arc(160, 160, 100, 0, Math.PI * 2); x.fill();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const started = performance.now();
    await petHandleFile(new File([blob], 'plain.png', { type: 'image/png' }));
    const snapshot = await fetch('/api/pet').then((r) => r.json());
    const img = new Image();
    img.src = '/api/pet/sprite?v=' + snapshot.spriteVersion;
    await img.decode();
    const probe = document.createElement('canvas');
    probe.width = img.width; probe.height = img.height;
    const px = probe.getContext('2d');
    px.drawImage(img, 0, 0);
    const d = px.getImageData(0, 0, probe.width, probe.height).data;
    let clear = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 16) clear++;
    return { ms: Math.round(performance.now() - started), w: img.width, h: img.height,
      clearPct: Math.round(clear / (d.length / 4) * 100), hasSprite: snapshot.hasSprite };
  })()`, true);

  assert.equal(result.hasSprite, true);
  assert.ok(result.w * result.h > 100 * 100, 'the subject survived the cut: ' + result.w + 'x' + result.h);
  assert.ok(result.clearPct > 10, 'the white background became transparent: ' + result.clearPct + '%');
  assert.ok(result.clearPct < 80, 'the subject itself was kept: ' + result.clearPct + '%');
});
