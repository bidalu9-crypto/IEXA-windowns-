// The code preview is what a reader sees when they open a source file: a
// numbered gutter, highlighted tokens, a wrap toggle and a copy action. This
// runs the real page because the gutter/scroll layout only exists in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const SAMPLE = `import { readFile } from 'node:fs/promises'

/** Read a UTF-8 file and drop the trailing newline. */
export async function load(name) {
  const text = await readFile(name, 'utf8')
  return text.replace(/\\n$/, '')
}

export const VERSION = '1.0.0'
`;

test('real browser: opening a source file shows the code preview', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-codepreview-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_preview';
  const at = Date.now() - 60_000;

  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'load.js'), SAMPLE);
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '代码预览', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: workspace, projectName: 'workspace' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '看看这个文件', timestamp: at },
    { role: 'assistant', content: '好的。', status: 'done', timestamp: at + 1000, durationMs: 1000 },
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
    for (let index = 0; index < 140; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await evaluate(`void switchSession('${sessionId}'); true`);
  await wait("document.querySelectorAll('#chatMessages .message').length === 2");

  await evaluate("document.getElementById('filesPanel').style.display = 'flex'; true");
  await evaluate("(async () => { await loadProjectState(); await openFilePreview('src/load.js'); return true })()");
  await wait("document.querySelectorAll('.code-preview-line').length > 5");

  const view = await evaluate(`(() => {
    const host = document.getElementById('filesPreview');
    const numbers = [...host.querySelectorAll('.code-preview-line-number')].map((n) => n.textContent);
    const body = host.querySelector('.code-preview-body');
    const first = host.querySelector('.code-preview-line-number');
    const code = host.querySelector('.code-preview-line');
    const numRect = first.getBoundingClientRect();
    const codeRect = code.getBoundingClientRect();
    return {
      visible: host.style.display,
      lines: host.querySelectorAll('.code-preview-line').length,
      rows: host.querySelectorAll('.code-preview-row').length,
      numbers: numbers.slice(0, 3).join(','),
      meta: host.querySelector('.code-preview-meta').textContent,
      highlighted: host.querySelectorAll('.code-preview-line span[class^="hljs-"]').length,
      numberColor: getComputedStyle(first).color,
      numberLeft: Math.round(numRect.left),
      numberTop: Math.round(numRect.top),
      codeLeft: Math.round(codeRect.left),
      codeTop: Math.round(codeRect.top),
      bodyTop: Math.round(body.getBoundingClientRect().top),
      wrap: body.dataset.wrap,
      hasCopy: !!host.querySelector('#codePreviewCopy'),
      hasWrap: !!host.querySelector('#codePreviewWrap'),
      text: code.textContent.slice(0, 30),
    };
  })()`);
  console.log('PREVIEW', JSON.stringify(view));
  assert.equal(view.visible, 'flex');
  assert.equal(view.lines, SAMPLE.replace(/\n$/, '').split('\n').length);
  assert.equal(view.rows, view.lines);
  assert.equal(view.numbers, '1,2,3');
  assert.match(view.meta, /javascript/);
  assert.ok(view.highlighted > 5, 'tokens carry hljs classes: ' + view.highlighted);
  assert.ok(view.numberLeft < view.codeLeft, 'the number sits left of its line: ' + view.numberLeft + ' < ' + view.codeLeft);
  assert.equal(view.numberTop, view.codeTop, 'the number is on the same baseline row');
  assert.equal(view.numberColor, 'rgb(119, 119, 127)');
  assert.equal(view.wrap, 'off');
  assert.ok(view.hasCopy && view.hasWrap);
  assert.match(view.text, /import/);


  const artifact = path.resolve('.iexa-artifacts', 'code-preview');
  fs.mkdirSync(artifact, { recursive: true });
  const cropRect = { x: 978, y: 540, width: 292, height: 360, scale: 2 };
  const unwrapped = await cdp('Page.captureScreenshot', { format: 'png', clip: cropRect });
  fs.writeFileSync(path.join(artifact, 'crop-unwrapped.png'), Buffer.from(unwrapped.result.data, 'base64'));

  // Wrap is a real layout switch, not just a class: the source line must fit
  // the column instead of scrolling sideways.
  await evaluate("document.getElementById('codePreviewWrap').click(); true");
  await new Promise((r) => setTimeout(r, 150));
  const after = await evaluate(`(() => {
    const body = document.querySelector('.code-preview-body');
    return { wrap: body.dataset.wrap, scroll: Math.round(body.scrollWidth), client: Math.round(body.clientWidth) };
  })()`);
  assert.equal(after.wrap, 'on');
  assert.ok(after.scroll <= after.client + 1, 'wrapped text fits the column: ' + after.scroll + ' <= ' + after.client);
  const wrapped = await cdp('Page.captureScreenshot', { format: 'png', clip: cropRect });
  fs.writeFileSync(path.join(artifact, 'crop-wrapped.png'), Buffer.from(wrapped.result.data, 'base64'));

  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(artifact, 'code-preview-light.png'), Buffer.from(shot.result.data, 'base64'));
  await evaluate("document.documentElement.dataset.theme='dark'; true");
  await new Promise((r) => setTimeout(r, 200));
  const dark = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(artifact, 'code-preview-dark.png'), Buffer.from(dark.result.data, 'base64'));
});