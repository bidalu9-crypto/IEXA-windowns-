// The appearance page owns the skin editor: presets, live custom colours,
// per-mode palettes, persistence and the responsive layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: appearance page edits and persists a skin', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-appearance-'));
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 800));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 120; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  const openAppearance = async () => {
    await evaluate("document.querySelector('.nav-btn[data-view=appearance]').click(); true");
    await wait("document.getElementById('view-appearance').classList.contains('active')");
    await new Promise((r) => setTimeout(r, 300));
  };
  const tokens = () => evaluate(`(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      skin: document.documentElement.dataset.skin,
      accent: s.getPropertyValue('--accent').trim(),
      canvas: s.getPropertyValue('--bg-primary').trim(),
      surface: s.getPropertyValue('--bg-secondary').trim(),
      radius: s.getPropertyValue('--radius').trim(),
    };
  })()`);

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof IexaSkins === 'object' && typeof currentSessionId !== 'undefined' && !!currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 900));
  await openAppearance();

  // Structure: three cards, nine skins, one preview, two contrast readings.
  const structure = await evaluate(`(() => {
    const grid = document.getElementById('skinGrid');
    return {
      cards: document.querySelectorAll('.appearance-card').length,
      tiles: grid.children.length,
      customTile: !!grid.querySelector('[data-skin-id=custom]'),
      active: grid.querySelector('.is-active')?.dataset.skinId,
      preview: !!document.querySelector('.appearance-preview-window'),
      plan: !!document.querySelector('.preview-plan'),
      contrastPills: document.querySelectorAll('.contrast-pill').length,
      columns: getComputedStyle(document.querySelector('.appearance-grid')).gridTemplateColumns.split(' ').length,
      rangeFill: getComputedStyle(document.getElementById('skinRadius')).getPropertyValue('--range-progress').trim(),
    };
  })()`);
  assert.equal(structure.cards, 3);
  assert.equal(structure.tiles, 9, 'eight presets plus custom');
  assert.equal(structure.customTile, true);
  assert.equal(structure.active, 'default');
  assert.equal(structure.preview, true);
  assert.equal(structure.plan, true, 'the preview includes a plan card, not just colours');
  assert.equal(structure.contrastPills, 2);
  assert.equal(structure.columns, 2, 'desktop is a two-column page');
  assert.match(structure.rangeFill, /%/);

  // A preset paints the whole palette, not only the accent.
  await evaluate("document.querySelector('[data-skin-id=amber]').click(); true");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await tokens(), {
    skin: 'amber', accent: '#c4841d', canvas: '#f6f1e8', surface: '#fdf9f2', radius: '12px',
  });

  // Editing any colour bends the preset into a custom skin of the same family.
  await evaluate(`(() => {
    const input = document.getElementById('skinAccent');
    input.value = '#0f8a72';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const radius = document.getElementById('skinRadius');
    radius.value = '16';
    radius.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const custom = await tokens();
  assert.equal(custom.skin, 'custom');
  assert.equal(custom.accent, '#0f8a72');
  assert.equal(custom.canvas, '#f6f1e8', 'the rest of the preset survives the edit');
  assert.equal(custom.radius, '16px');
  assert.equal(await evaluate("document.querySelector('[data-skin-id=custom]').classList.contains('is-active')"), true,
    await evaluate("Array.from(document.querySelectorAll('.skin-tile')).map(function(t){ return t.dataset.skin + ':' + t.className; }).join(' | ')"));

  // Each mode keeps its own palette; the dark side still carries the preset.
  await evaluate("document.querySelector('#themeSeg [data-theme-set=dark]').click(); true");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const dark = await tokens();
  assert.equal(dark.accent, '#e5a33c', 'dark keeps the amber accent');
  assert.equal(dark.canvas, '#1f1b16');
  assert.notEqual(dark.accent, custom.accent, 'light edits do not leak into dark');
  assert.equal(await evaluate("document.querySelector('[data-skin-id=custom]').classList.contains('is-active')"), true);

  // Reload: the server value must come back before the page is usable.
  await cdp('Page.reload');
  await wait("typeof IexaSkins === 'object' && typeof currentSessionId !== 'undefined' && !!currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 900));
  const restored = await tokens();
  assert.equal(restored.skin, 'custom');
  assert.equal(restored.accent, '#e5a33c');
  assert.equal(restored.canvas, '#1f1b16');
  await openAppearance();
  assert.equal(await evaluate("document.getElementById('skinAccentHex').value"), '#e5a33c',
    'the editor shows the saved dark accent');

  // Reset clears the inline overrides and falls back to the stylesheet.
  await evaluate("document.getElementById('appearanceResetAll').click(); true");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const reset = await tokens();
  assert.equal(reset.skin, 'default');
  assert.equal(await evaluate("document.documentElement.style.getPropertyValue('--accent')"), '',
    'reset removes the skin properties instead of pinning a copy');

  // Import refuses files that are not skins.
  assert.match(await evaluate("IexaSkins.importPatch({ format: 'other' })"), /不是 IEXA 皮肤文件/);

  // Layout: one column on a narrow window, no horizontal overflow on a phone.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 980, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.appearance-grid')).gridTemplateColumns.split(' ').length"), 1);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const phone = await evaluate(`(() => {
    const view = document.getElementById('view-appearance');
    const grid = document.getElementById('skinGrid');
    return {
      overflow: view.scrollWidth > view.clientWidth + 1,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      tile: Math.round(grid.children[0].getBoundingClientRect().width),
    };
  })()`);
  assert.equal(phone.overflow, false);
  assert.equal(phone.columns, 2);
  assert.ok(phone.tile > 120);
});
