// The model refresh used to sit in the bar as its own icon button. It now lives
// at the bottom of the model dropdown: one control per concern, and the action
// stays reachable while the list scrolls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: model refresh lives inside the dropdown and keeps it open', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-model-menu-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const token = backend.getServerCredentials(server).token;
  const code = backend.getServerCredentials(server).loginCode;
  const endpoint = `http://127.0.0.1:${port}`;

  // Enough profiles that the list has to scroll, which is what pins the footer.
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(endpoint + '/api/profiles', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `menu-profile-${index}`, provider: 'custom', model: `fixture-model-${index}`,
        apiKey: 'FIXTURE-KEY', baseURL: 'http://127.0.0.1:9/v1', contextWindow: 128000, maxOutputTokens: 512,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  }


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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `${endpoint}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId && document.getElementById('modelSelectorLabel').textContent !== '— 尚未配置模型 —'");

  // The bar no longer carries its own refresh control; the only one lives in
  // the dropdown footer.
  assert.equal(await evaluate("document.querySelectorAll('.model-bar-refresh').length"), 0, 'the standalone refresh button is gone');
  assert.equal(await evaluate("document.querySelectorAll('.model-bar > button use[href=\"#ui-refresh\"]').length"), 0, 'no refresh glyph sits in the bar itself');
  assert.equal(await evaluate("!!document.getElementById('modelSelectorMenu').querySelector('#modelSelectorRefresh')"), true, 'the refresh action sits inside the dropdown');

  await evaluate("document.getElementById('modelSelector').click(); true");
  await wait("document.getElementById('modelSelectorMenu').style.display === 'flex'");

  const layout = await evaluate(`(() => {
    const menu = document.getElementById('modelSelectorMenu');
    const list = document.getElementById('modelSelectorList');
    const footer = menu.querySelector('.model-selector-footer');
    const button = document.getElementById('modelSelectorRefresh');
    const menuBox = menu.getBoundingClientRect(), footerBox = footer.getBoundingClientRect(), buttonBox = button.getBoundingClientRect();
    return {
      options: list.querySelectorAll('.model-selector-option').length,
      scrolls: list.scrollHeight > list.clientHeight + 1,
      footerInside: Math.round(footerBox.bottom) <= Math.round(menuBox.bottom) + 1,
      buttonVisible: buttonBox.width > 0 && buttonBox.height >= 24,
      label: button.textContent.trim(),
      href: button.querySelector('use').getAttribute('href'),
    };
  })()`);
  assert.ok(layout.options >= 10, 'every profile is listed');
  assert.equal(layout.scrolls, true, 'the list scrolls before the footer');
  assert.equal(layout.footerInside, true, 'the footer stays inside the menu');
  assert.equal(layout.buttonVisible, true, 'the refresh action has a real hit area');
  assert.equal(layout.label, '刷新列表');
  assert.equal(layout.href, '#ui-refresh');

  // Clicking it re-fetches and keeps the dropdown open, with focus intact.
  await evaluate(String.raw`(() => {
    window.__profileCalls = 0;
    const real = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes('/api/profiles')) window.__profileCalls += 1;
      return real(input, init);
    };
    window.__closeCount = 0;
    new MutationObserver(() => {
      if (document.getElementById('modelSelectorMenu').style.display === 'none') window.__closeCount += 1;
    }).observe(document.getElementById('modelSelectorMenu'), { attributes: true, attributeFilter: ['style'] });
    return true;
  })()`);
  await evaluate("document.getElementById('modelSelectorRefresh').click(); true");
  await wait("window.__profileCalls >= 1 && document.getElementById('modelSelectorRefresh').dataset.busy === 'false'");

  const after = await evaluate(`(() => ({
    display: document.getElementById('modelSelectorMenu').style.display,
    closeCount: window.__closeCount,
    focused: document.activeElement === document.getElementById('modelSelectorRefresh'),
    options: document.querySelectorAll('#modelSelectorList .model-selector-option').length,
  }))()`);
  assert.equal(after.display, 'flex', 'refreshing keeps the dropdown open');
  assert.equal(after.closeCount, 0, 'the menu never flashed closed');
  assert.equal(after.focused, true, 'focus stays on the refresh action');
  assert.ok(after.options >= 10, 'the list is rebuilt in place');
});
