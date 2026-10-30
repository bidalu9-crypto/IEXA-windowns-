// Cold start must not paint a long history from the first message down. The
// transcript mounts one window with the surface hidden, reveals it at the
// bottom, and grafts older chunks only when the reader scrolls up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a long history mounts one window, at the bottom', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-window-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_window';
  const at = Date.now() - 600_000;
  const messages = [];
  for (let index = 0; index < 200; index += 1) {
    messages.push(index % 2 === 0
      ? { role: 'user', content: '第 ' + (index / 2) + ' 个问题', timestamp: at + index * 1000 }
      : { role: 'assistant', content: '第 ' + Math.floor(index / 2) + ' 个回答，内容很短。', status: 'done', timestamp: at + index * 1000 + 400, durationMs: 400 });
  }
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '长会话', titleSource: 'message', created: at, updated: at, messageCount: messages.length, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify(messages));
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 160; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof switchSession === 'function'");
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await evaluate(`void switchSession('${sessionId}'); true`);
  await wait(`document.querySelectorAll('#chatMessages .message').length > 0`);
  await wait(`!document.getElementById('chatMessages').classList.contains('is-hydrating')`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const mounted = await evaluate(`(() => {
    const box = document.getElementById('chatMessages');
    const spacer = box.querySelector('.history-spacer');
    return {
      messages: box.querySelectorAll('.message').length,
      startIndex: sessionRuntimes.get('${sessionId}').historyStartIndex,
      total: sessionRuntimes.get('${sessionId}').historyMessages.length,
      spacerHeight: spacer ? Math.round(spacer.getBoundingClientRect().height) : -1,
      atBottom: Math.abs(box.scrollHeight - box.clientHeight - box.scrollTop) <= 8,
      hydrating: box.classList.contains('is-hydrating'),
    };
  })()`);
  assert.equal(mounted.total, 200, 'the whole conversation is still in memory');
  assert.ok(mounted.messages <= 61, 'only one window is in the DOM: ' + mounted.messages);
  assert.ok(mounted.startIndex > 0, 'the window starts past the first message: ' + mounted.startIndex);
  assert.ok(mounted.spacerHeight > 0, 'the spacer reserves the unmounted height: ' + mounted.spacerHeight);
  assert.equal(mounted.atBottom, true, 'the first frame lands at the newest message');
  assert.equal(mounted.hydrating, false, 'the surface is revealed once mounted');

  // The previous chunk grafts when the reader asks for it.
  await evaluate(`(() => { const box = document.getElementById('chatMessages'); const button = box.querySelector('.load-earlier-messages'); button.click(); return true; })()`);
  await wait(`sessionRuntimes.get('${sessionId}').historyStartIndex < ${mounted.startIndex}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const earlier = await evaluate(`(() => {
    const box = document.getElementById('chatMessages');
    return {
      startIndex: sessionRuntimes.get('${sessionId}').historyStartIndex,
      messages: box.querySelectorAll('.message').length,
      spacerHeight: box.querySelector('.history-spacer') ? Math.round(box.querySelector('.history-spacer').getBoundingClientRect().height) : 0,
      keptPosition: box.scrollTop > 0,
    };
  })()`);
  assert.ok(earlier.startIndex < mounted.startIndex, 'an older chunk was grafted');
  assert.ok(earlier.messages > mounted.messages, 'more messages are mounted now: ' + earlier.messages);
  assert.ok(earlier.spacerHeight < mounted.spacerHeight, 'the spacer shrank with the window');
  assert.equal(earlier.keptPosition, true, 'the reader stays on the content they were reading');
});
