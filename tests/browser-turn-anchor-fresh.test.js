// The regression this file exists for: in a freshly created conversation, the
// cold-start "jump to latest" positioning is still running when the first turn
// begins. It used to keep pinning the transcript to the bottom of the borrowed
// room on every streamed token, so the room grew with the reply; the moment the
// room was given back, the browser clamped scrollTop and the reader landed on
// the first message with nothing left to scroll. Any wheel turn did the same,
// because a wheel takes the room back immediately.
//
// So: borrowing the room must not grow the transcript, streaming must not move
// it, and the hand-back must not pull it anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a fresh conversation keeps its place while the first reply streams', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-turnanchor-fresh-'));
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 300));
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
  await wait("document.readyState === 'complete' && typeof anchorTurnAtTop === 'function' && typeof addMessage === 'function'");
  await new Promise((resolve) => setTimeout(resolve, 900));

  await evaluate(`
    window.__snap = function () {
      const c = document.getElementById('chatMessages');
      return {
        top: Math.round(c.scrollTop),
        max: Math.round(c.scrollHeight - c.clientHeight),
        sh: Math.round(c.scrollHeight),
        pad: Math.round(parseFloat(getComputedStyle(c).paddingBottom)),
        anchored: typeof turnAnchor !== 'undefined' && !!turnAnchor,
      };
    };
    window.__step = function () {
      if (!window.__reply) window.__reply = addMessage('assistant', '', undefined, { streaming: true });
      window.__reply.querySelector('.message-content').textContent += '第 N 步：读取文件、生成索引、书写说明。\\n';
      scrollToBottom();
      return __snap();
    };
  `);

  // createSession() starts the cold-start positioning this bug was born in.
  await evaluate("(async () => { if (!currentSessionId) await createSession(); return currentSessionId; })()");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await evaluate(`(() => {
    dismissWelcome();
    const prompt = addMessage('user', '帮我看一下这个项目的目录结构，然后告诉我哪些文件是入口');
    anchorTurnAtTop(prompt);
    return true;
  })()`);

  const steps = [];
  for (let index = 0; index < 60; index += 1) {
    steps.push(await evaluate('__step()'));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  const anchored = steps.filter((step) => step.anchored);
  assert.ok(anchored.length >= 10, 'the room was actually borrowed: ' + anchored.length);

  // 1. Borrowing the room must not let the transcript grow: that growth is what
  //    has to be handed back later, and the hand-back is what used to clamp.
  const heights = anchored.map((step) => step.sh);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 4,
    'the height stays put while the room is borrowed: ' + JSON.stringify(heights));

  // 2. And the reader's offset never drifts while it streams.
  const tops = anchored.map((step) => step.top);
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 4,
    'streaming does not move the transcript: ' + JSON.stringify(tops));

  // 3. The hand-back is seamless: no clamp, so the offset cannot fall back.
  const releaseAt = steps.findIndex((step, index) => index > 0 && steps[index - 1].anchored && !step.anchored);
  assert.ok(releaseAt > 0, 'the anchor retires once the reply fills the room');
  assert.ok(steps[releaseAt].top >= steps[releaseAt - 1].top - 4,
    'the hand-back does not pull the transcript back: ' + JSON.stringify([steps[releaseAt - 1], steps[releaseAt]]));

  // 4. Past it, follow-latest resumes and the newest line stays reachable. The
  //    follow is scheduled on a frame, so let one land before reading.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const tail = await evaluate('__snap()');
  assert.ok(tail.max > 0, 'the reply overflowed the viewport: ' + JSON.stringify(tail));
  assert.ok(Math.abs(tail.top - tail.max) <= 2, 'the transcript follows the newest line again: ' + JSON.stringify(tail));
});

