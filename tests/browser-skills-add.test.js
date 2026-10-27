// Regression guard for the Skills "+" button: it carried the shell's
// .ui-icon-button class, whose `background: transparent` (specificity 0,2,0)
// beat .btn-primary's accent fill (0,1,0). The glyph kept --on-accent, so the
// dark theme rendered a near-black plus on a near-black header: the entry point
// for adding skills was invisible while still being clickable.
//
// The test asserts the affordance, not the CSS source: opaque fill plus a
// readable glyph in both palettes, and a menu that actually opens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

test('real browser: skills add button stays visible in light and dark', { skip: !browser, timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-browser-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;


  let socket;
  let page;
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (page) await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows file lock */ }
  });

  page = await launchPage();
  socket = page.socket;

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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 8000);
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
    for (let i = 0; i < 120; i++) {
      // A polled predicate can legitimately touch nodes that do not exist yet
      // (document.body during navigation), so transient throws retry instead of
      // failing the whole assertion.
      try {
        if (await evaluate(expression)) return;
      } catch { /* not ready yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1175, height: 839, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'", 'app shell');
  await evaluate("document.querySelector('.nav-btn[data-view=\"skills\"]').click()");
  await wait("document.getElementById('view-skills')?.classList.contains('active')", 'skills view');

  // Measured in-page: resolves the effective fill and the glyph colour exactly
  // as painted, including inheritance.
  const probe = theme => evaluate(`(() => {
    if (${JSON.stringify(theme)} === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
    const btn = document.getElementById('skillAddBtn');
    const icon = btn.querySelector('svg');
    const b = getComputedStyle(btn);
    const i = getComputedStyle(icon);
    const parse = value => {
      const m = String(value).match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const parts = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const lum = c => {
      const channel = value => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };
    const bg = parse(b.backgroundColor);
    const fg = parse(i.stroke && i.stroke !== 'none' ? i.stroke : b.color);
    const ratio = bg && fg && bg.a > 0
      ? (Math.max(lum(bg), lum(fg)) + 0.05) / (Math.min(lum(bg), lum(fg)) + 0.05)
      : 0;
    const rect = btn.getBoundingClientRect();
    return {
      theme: document.documentElement.getAttribute('data-theme') || 'default',
      background: b.backgroundColor, color: b.color, stroke: i.stroke,
      opacity: b.opacity, radius: b.borderRadius,
      width: Math.round(rect.width), height: Math.round(rect.height),
      contrast: Number(ratio.toFixed(2)),
      visible: b.display !== 'none' && b.visibility !== 'hidden' && Number(b.opacity) > 0.5 &&
        rect.width >= 32 && rect.height >= 32 &&
        rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth
    };
  })()`);

  for (const theme of ['dark', 'light', null]) {
    const state = await probe(theme);
    assert.equal(state.visible, true, `button must be laid out and on screen in ${state.theme}: ${JSON.stringify(state)}`);
    assert.equal(state.width, 36, `expected a 36px hit target in ${state.theme}`);
    assert.equal(state.height, 36, `expected a 36px hit target in ${state.theme}`);
    assert.equal(state.visible, true);
    const alpha = Number((state.background.match(/rgba?\(([^)]+)\)/)?.[1].split(/[,\s/]+/).filter(Boolean)[3] ?? 1));
    assert.equal(alpha, 1, `fill must be opaque in ${state.theme}, got ${state.background}`);
    assert.ok(state.contrast >= 3, `glyph contrast ${state.contrast}:1 is below 3:1 in ${state.theme} (${state.stroke} on ${state.background})`);
  }

  await probe('dark');
  assert.equal(await evaluate("document.getElementById('skillAddBtn').getAttribute('aria-expanded')"), 'false');
  await evaluate("document.getElementById('skillAddBtn').click()");
  await wait("getComputedStyle(document.getElementById('skillAddMenu')).display === 'flex'", 'menu open');
  assert.equal(await evaluate("document.getElementById('skillAddBtn').getAttribute('aria-expanded')"), 'true');
  assert.ok(await evaluate("document.getElementById('skillImportFileBtn').getBoundingClientRect().height > 0"), 'menu items laid out');

  await evaluate("document.body.click()");
  await wait("getComputedStyle(document.getElementById('skillAddMenu')).display === 'none'", 'menu closed');
  assert.equal(await evaluate("document.getElementById('skillAddBtn').getAttribute('aria-expanded')"), 'false');

  assert.equal(exceptions.length, 0, 'renderer must not throw: ' + JSON.stringify(exceptions[0] || null));
});
