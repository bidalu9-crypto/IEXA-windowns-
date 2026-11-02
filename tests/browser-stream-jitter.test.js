// Measures what the eye sees: after each append, sample the prompt's painted
// position on the following animation frame. A per-frame layout write shows up
// here as a ±1px wobble; a read-only implementation shows one constant value.
//
// This is the regression guard for the anchor rewrite. The previous version
// shrank the borrowed padding on every token, so each frame ran read-write-read
// against the layout engine and the prompt shimmered while text streamed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the pinned prompt does not move while the reply streams', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-jitter-'));
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

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof sendMessage === 'function' && typeof addMessage === 'function' && currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 900));

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
  await new Promise((resolve) => setTimeout(resolve, 800));

  const result = await evaluate(`(async () => {
    const container = document.getElementById('chatMessages');
    const prompts = [...container.querySelectorAll('.message.user')];
    const target = prompts[prompts.length - 1];
    let reply = container.querySelector('.message.assistant.is-streaming');
    if (!reply) reply = addMessage('assistant', '', undefined, { streaming: true });
    const body = reply.querySelector('.message-content');
    const borrowed = parseFloat(getComputedStyle(container).paddingBottom);
    const token = '流式输出的一段文字，用来模拟 token 逐个到达的过程。';
    const frames = [];
    let released = false;
    for (let step = 0; step < 90; step += 1) {
      body.textContent += token;
      scrollToBottom(false, isNearChatBottom);
      await new Promise((r) => requestAnimationFrame(() => r()));
      // Second frame: this is the painted position.
      await new Promise((r) => requestAnimationFrame(() => r()));
      const padding = parseFloat(getComputedStyle(container).paddingBottom);
      // Past release the prompt is allowed to scroll away; measuring there would
      // only measure follow-latest.
      if (padding < borrowed - 1) { released = true; break; }
      frames.push(Math.round(target.getBoundingClientRect().top * 100) / 100);
    }
    const first = frames[0];
    const deltas = frames.map((v) => Math.round((v - first) * 100) / 100);
    return {
      anchoredFrames: frames.length,
      released,
      unique: [...new Set(deltas)],
      maxDeviation: Math.max(...deltas.map((d) => Math.abs(d))),
    };
  })()`);

  assert.ok(result.anchoredFrames >= 20, 'enough anchored frames measured: ' + JSON.stringify(result));
  assert.ok(result.maxDeviation <= 1, 'the prompt must not move while streaming: ' + JSON.stringify(result));
  assert.ok(result.unique.length <= 2, 'the painted position takes at most one value: ' + JSON.stringify(result));
  assert.ok(result.released, 'the anchor retires so follow-latest can resume: ' + JSON.stringify(result));
});
