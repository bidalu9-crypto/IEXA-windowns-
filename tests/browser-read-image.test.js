// A picture read by the model is a deliverable: it must stay visible beside
// the tool row after the turn folds. It used to be appended to the collapsible
// tool body, so "read_image" showed nothing once the turn settled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a read image stays visible after the turn folds', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-read-image-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_read_image';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '看图', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '看一下这张设计稿', timestamp: at },
    { role: 'assistant', content: '', status: 'done', timestamp: at + 2000, durationMs: 2000 },
  ]));
  process.env.IEXA_WORKSPACE = workspace;

  const sharp = require('sharp');
  const png = await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .png().toBuffer();
  const base64 = png.toString('base64');

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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 140; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await evaluate(`void switchSession('${sessionId}'); true`);
  await wait("document.querySelectorAll('#chatMessages .message').length === 2");

  // Drive the live path exactly as the SSE stream does.
  await evaluate(`(() => {
    addMessage('assistant', '', null, { streaming: true });
    const id = 'call_read_image';
    handleToolStart(id, 'read_image');
    handleToolInput('read_image', { path: 'attachments/probe.png', tool_title: '查看设计稿' }, id);
    handleToolResult(
      id, 'Image: attachments/probe.png', true, undefined, undefined,
      ${JSON.stringify(base64)}, 'image/png',
      [{ kind: 'image', path: 'attachments/probe.png', mimeType: 'image/png' }],
      'completed', 30
    );
    finalizeAssistantMessage(currentAssistantMsg);
    return true;
  })()`);

  await wait("!!document.querySelector('#chatMessages .tool-artifacts img')");
  await wait("document.querySelector('#chatMessages .tool-artifacts img').complete");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = await evaluate(`(() => {
    const card = document.querySelector('#chatMessages .tool-artifacts');
    const image = card.querySelector('img');
    const box = image.getBoundingClientRect();
    return {
      settled: !!document.querySelector('#chatMessages .message.is-activity-settled'),
      images: document.querySelectorAll('#chatMessages .tool-artifacts img').length,
      legacy: document.querySelectorAll('#chatMessages .tool-result-image').length,
      insideBody: !!card.closest('.tool-body'),
      insideHidden: !!card.closest('.turn-activity-hidden'),
      display: getComputedStyle(card).display,
      width: Math.round(box.width),
      height: Math.round(box.height),
      naturalWidth: image.naturalWidth,
      dataUrl: image.src.startsWith('data:image/png;base64,'),
    };
  })()`);

  assert.equal(state.settled, true, 'the turn folded');
  assert.equal(state.insideBody, false, 'the picture is not inside the collapsible body');
  assert.equal(state.insideHidden, false, 'and not inside the folded region');
  assert.equal(state.images, 1, 'exactly one picture');
  assert.equal(state.legacy, 0, 'no duplicate legacy image node');
  assert.notEqual(state.display, 'none', 'the card is laid out');
  assert.ok(state.width >= 24 && state.height >= 24, `the picture renders (${state.width}x${state.height})`);
  assert.equal(state.naturalWidth, 48, 'the bytes loaded');
  assert.equal(state.dataUrl, true, 'it renders from the inline result bytes');
});
