// Real-browser proof of the send anchor: the prompt is pinned near the top and
// the reply starts directly beneath it, then the viewport holds still while the
// reply grows. The earlier spacer version passed a position check while leaving
// a half-screen hole between prompt and reply, so adjacency is asserted too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a sent prompt sits at the top with the reply right under it', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-turnanchor-'));
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
  const read = () => evaluate(`(() => {
    const container = document.getElementById('chatMessages');
    const prompts = [...container.querySelectorAll('.message.user')];
    const last = prompts[prompts.length - 1];
    const box = container.getBoundingClientRect();
    const rect = last.getBoundingClientRect();
    const next = last.nextElementSibling;
    const nextRect = next ? next.getBoundingClientRect() : null;
    return {
      top: Math.round(rect.top - box.top),
      gap: nextRect ? Math.round(nextRect.top - rect.bottom) : null,
      padding: Math.round(parseFloat(getComputedStyle(container).paddingBottom)),
      neighbour: next ? next.className : null,
    };
  })()`);

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof sendMessage === 'function' && typeof addMessage === 'function' && currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 900));

  // Enough history that the transcript actually scrolls.
  for (let index = 0; index < 6; index += 1) {
    await evaluate(`(() => {
      addMessage('user', '历史提问 ${index}');
      const reply = addMessage('assistant', '历史回答 ${index}。'.repeat(6), undefined, { streaming: false });
      finalizeAssistantMessage(reply);
      return true;
    })()`);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));

  await evaluate(`(() => {
    chatInput.value = '查一下广东油价';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sendBtn').click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 900));

  const sent = await read();
  assert.ok(sent.top >= 8 && sent.top <= 24, 'the prompt is pinned near the top: ' + JSON.stringify(sent));
  // Adjacency is the part the spacer version broke: a borrowed gap sat between
  // prompt and reply and pushed the answer to the bottom of the screen.
  assert.ok(sent.gap !== null && sent.gap <= 60, 'the reply starts right under the prompt: ' + JSON.stringify(sent));
  assert.ok(sent.padding > 100, 'the transcript borrowed room to allow the scroll: ' + JSON.stringify(sent));

  // While the reply grows the prompt must not move, and the gap must not change.
  const frames = [];
  for (let step = 0; step < 8; step += 1) {
    await evaluate(`(() => {
      const container = document.getElementById('chatMessages');
      let reply = container.querySelector('.message.assistant.is-streaming');
      if (!reply) reply = addMessage('assistant', '', undefined, { streaming: true });
      reply.querySelector('.message-content').textContent += '模拟回复内容，用来把下方面板撑高。'.repeat(3);
      scrollToBottom(false, isNearChatBottom);
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    frames.push(await read());
  }

  const firstTop = frames[0].top;
  const lastTop = frames[frames.length - 1].top;
  assert.ok(Math.abs(lastTop - firstTop) <= 8, 'the prompt holds its place: ' + firstTop + ' -> ' + lastTop);
  const stale = frames.filter((frame) => frame.gap !== null && frame.gap > 60);
  assert.deepEqual(stale, [], 'the reply stays attached while it grows');
  assert.ok(frames[frames.length - 1].padding < sent.padding, 'the borrowed room is being returned');
});
