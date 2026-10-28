// The conversation/trajectory switch belongs to the top of the chat column.
// The landing page centres the hero and the composer, and centring the whole
// flex column used to drag this strip down with them, leaving a large empty
// band above it. Measure real geometry instead of trusting the stylesheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the view switch stays at the top of the chat column', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-tabs-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_tabs';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  // No sessions at all: the app opens on the landing hero, which is exactly the
  // state that used to push the view switch down.
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({ sessions: [] }));
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;
  const artifact = path.resolve('.iexa-artifacts/view-tabs');
  fs.mkdirSync(artifact, { recursive: true });

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
  async function geometry() {
    return evaluate(`(() => {
      const container = document.querySelector('#view-chat .chat-container');
      const tabs = document.getElementById('chatViewTabs');
      const messages = document.querySelector('.chat-messages-area');
      const hero = document.querySelector('.welcome');
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; };
      return {
        welcome: document.getElementById('view-chat').classList.contains('is-welcome'),
        container: box(container),
        tabs: box(tabs),
        messages: box(messages),
        hero: box(document.querySelector('.welcome')),
        composer: box(document.querySelector('.chat-input-area')),
        display: getComputedStyle(tabs).display,
      };
    })()`);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof syncWelcomeLayout === 'function'");
  await wait("document.getElementById('chatViewTabs') !== null");

  // 1. Landing with no messages: the strip must hug the top of the column.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const landing = await geometry();
  assert.equal(landing.welcome, true, 'the landing state is active');
  assert.ok(landing.tabs.top - landing.container.top <= 4,
    `landing: tabs ${landing.tabs.top} vs column ${landing.container.top}`);
  assert.ok(landing.tabs.bottom <= landing.messages.top,
    `landing: tabs must precede the transcript (${landing.tabs.bottom} > ${landing.messages.top})`);
  const landingGap = (landing.hero || landing.composer).top - landing.tabs.bottom;
  assert.ok(landingGap > 60, 'the hero is still centred with room above it: ' + landingGap + 'px');

  const landingShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(artifact, 'landing.png'), Buffer.from(landingShot.result.data, 'base64'));

  // 2. A conversation with messages: same anchoring. Sending the first message
  //    is what drops the landing class in the real app.
  await evaluate(`(() => { dismissWelcome(); addMessage('user', '你好'); syncWelcomeLayout(); return true; })()`);
  await wait("document.querySelectorAll('#chatMessages .message').length === 1");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const chat = await geometry();
  assert.equal(chat.welcome, false, 'a loaded conversation drops the landing state');
  assert.ok(chat.tabs.top - chat.container.top <= 4,
    `chat: tabs ${chat.tabs.top} vs column ${chat.container.top}`);

  // 3. The strip still switches views without moving house.
  await evaluate(`document.querySelector('.chat-view-tab[data-chat-view="trajectory"]').click(); true`);
  await wait("!document.getElementById('trajectoryView').hidden");
  const switched = await geometry();
  assert.ok(switched.tabs.top - switched.container.top <= 4, 'switching views must not shift the strip');
  await evaluate(`document.querySelector('.chat-view-tab[data-chat-view="conversation"]').click(); true`);
  await wait("document.getElementById('trajectoryView').hidden");

  const chatShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(artifact, 'conversation.png'), Buffer.from(chatShot.result.data, 'base64'));
});
