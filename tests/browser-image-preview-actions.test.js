// The preview must let the user take the picture with them: download it under
// its real name, or put it on the clipboard as PNG.
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

test('real browser: the preview downloads and copies the current image', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-preview-actions-'));
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

  page = await launchPage({ isolated: true });
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
    for (let index = 0; index < 300; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof openImagePreview === 'function' && typeof currentSessionId !== 'undefined'");

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVQIW2P8z8Dwn4GBgYERxAAAAP//AwB1WwYF8m0mQAAAAABJRU5ErkJggg==';
  await evaluate(`(() => {
    window.__download = null;
    window.__copied = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__download = this.download; return; }
      return realClick.call(this);
    };
    const realWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async (items) => {
      window.__copied = items.map((item) => Array.from(item.types || []));
      return realWrite ? undefined : undefined;
    };
    openImagePreview(${JSON.stringify(png)}, '截图 133651.png', null);
    return true;
  })()`);
  await wait("document.getElementById('imagePreviewOverlay').style.display === 'flex'");

  const tools = await evaluate(`(() => [...document.querySelectorAll('.image-preview-header .image-preview-tool')]
    .map((button) => ({ id: button.id, label: button.getAttribute('aria-label'), visible: button.getBoundingClientRect().width > 0 })))()`);
  const download = tools.find((tool) => tool.id === 'imagePreviewDownload');
  const copy = tools.find((tool) => tool.id === 'imagePreviewCopy');
  assert.ok(download && download.visible, 'a download button is visible');
  assert.equal(download.label, '下载图片');
  assert.ok(copy && copy.visible, 'a copy button is visible');
  assert.equal(copy.label, '复制图片');

  await evaluate("document.getElementById('imagePreviewDownload').click(); true");
  await wait("window.__download !== null");
  assert.equal(await evaluate('window.__download'), '截图 133651.png', 'the download keeps the original file name');

  await evaluate("document.getElementById('imagePreviewCopy').click(); true");
  await wait("window.__copied !== null");
  const copied = await evaluate('window.__copied');
  assert.deepEqual(copied, [['image/png']], 'the clipboard receives a PNG');
  await wait("document.getElementById('imagePreviewStatus').textContent.includes('已复制')");

  // The shortcut hint must survive UI scaling; it used to be display:none there.
  await evaluate("closeImagePreview(); document.documentElement.dataset.uiScaled='true'; true");
  // Wait for the scaled layout to settle instead of guessing 200 ms.
  await wait("(() => { const el = document.querySelector('.shell-new-thread kbd'); return !!el && el.getBoundingClientRect().width > 10; })()");
  const kbd = await evaluate(`(() => {
    const el = document.querySelector('.shell-new-thread kbd');
    return el ? { display: getComputedStyle(el).display, width: Math.round(el.getBoundingClientRect().width) } : null;
  })()`);
  assert.ok(kbd && kbd.display !== 'none' && kbd.width > 10, 'Ctrl N stays visible when the UI is scaled: ' + JSON.stringify(kbd));
});

