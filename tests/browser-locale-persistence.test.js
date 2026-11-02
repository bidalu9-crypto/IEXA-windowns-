// Real browser proof for the reported bug: choose English, then simulate what a
// restart used to do — a renderer origin with empty storage — and require the
// interface to come back in English instead of resetting to Chinese.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the chosen language comes back after a storage-less restart', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-locale-e2e-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({ sessions: [] }));
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 200));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 200; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  const booted = "document.readyState === 'complete' && typeof IexaI18n !== 'undefined' && typeof switchSession === 'function'";

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait(booted);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Choose English the way the settings page does.
  await evaluate("(() => { const s = document.getElementById('localeSelect'); s.value = 'en-US'; s.dispatchEvent(new Event('change')); return true; })()");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(await evaluate("IexaI18n.getLocale()"), 'en-US');

  const credentials = backend.getServerCredentials(server);
  const stored = await fetch(`http://127.0.0.1:${port}/api/appearance`, {
    cache: 'no-store',
    headers: { Cookie: `${credentials.cookieName}=${credentials.token}` },
  }).then((r) => r.json());
  assert.equal(stored.locale, 'en-US', 'the choice reached the backend');

  // A restart on a fresh port has empty localStorage. Dropping storage and
  // reloading reproduces exactly that.
  await evaluate("localStorage.clear(); true");
  assert.equal(await evaluate("localStorage.getItem('iexa-locale')"), null);
  await evaluate("window.__beforeReload = true; true");
  await cdp('Page.reload');
  await wait("!window.__beforeReload && " + booted);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(await evaluate("IexaI18n.getLocale()"), 'en-US', 'the interface boots in the saved language');
  assert.equal(await evaluate("document.getElementById('localeSelect').value"), 'en-US', 'the settings control agrees');
  assert.equal(await evaluate("document.documentElement.lang"), 'en-US');
  assert.match(await evaluate("document.getElementById('permissionModeLabel').textContent"),
    /plan|approval|access|Approve/i, 'labels are translated, not left in Chinese');

  // A local choice still wins over the mirrored one afterwards.
  await evaluate("(() => { const s = document.getElementById('localeSelect'); s.value = 'ja-JP'; s.dispatchEvent(new Event('change')); return true; })()");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await evaluate("localStorage.clear(); window.__beforeReload = true; true");
  await cdp('Page.reload');
  await wait("!window.__beforeReload && " + booted);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await evaluate("IexaI18n.getLocale()"), 'ja-JP', 'the newest choice is the one restored');
});
