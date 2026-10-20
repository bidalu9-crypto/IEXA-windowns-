// The empty-session landing keeps the composer with the hero in the page centre,
// then glides it down to the dock on the first message instead of teleporting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the landing composer sits centred and glides to the dock', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-landing-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  const proc = spawn(browser, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', (data) => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

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
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof syncWelcomeLayout === 'function' && !!document.querySelector('.welcome')");
  await wait("document.getElementById('view-chat').classList.contains('is-welcome')");
  // Headless reports prefers-reduced-motion: reduce; opt into full motion.
  await evaluate("document.documentElement.dataset.motion = 'full'; true");
  // Fonts change the hero height, which moves the group; measure only when settled.
  await evaluate("document.fonts.ready.then(() => true)");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const landing = await evaluate(`(() => {
    const box = document.querySelector('.chat-input-area').getBoundingClientRect();
    return { center: box.top + box.height / 2, vh: innerHeight, welcome: !!document.querySelector('.welcome') };
  })()`);
  assert.equal(landing.welcome, true);
  const landingRatio = landing.center / landing.vh;
  assert.ok(landingRatio > 0.55 && landingRatio < 0.78,
    'the landing composer sits in the middle of the page, not on the dock: ' + landingRatio.toFixed(3));

  // Record the motion so the glide can be asserted rather than inferred.
  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.__anims = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      window.__anims.push({ cls: String(this.className), frames: JSON.parse(JSON.stringify(frames)), options });
      return animate.call(this, frames, options);
    };
    window.fetch = async (input, init) => {
      if (String(input) === '/api/chat') {
        return new Response('event: text\ndata: {"content":"ok"}\n\nevent: done\ndata: {}\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);

  await evaluate("chatInput.value = 'first message'; void sendMessage(); true");
  await wait("!document.getElementById('view-chat').classList.contains('is-welcome')");
  await wait("document.querySelector('.chat-input-area').getAnimations().length === 0");

  const docked = await evaluate(`(() => {
    const box = document.querySelector('.chat-input-area').getBoundingClientRect();
    return { top: box.top, vh: innerHeight, welcome: !!document.querySelector('.welcome') };
  })()`);
  assert.equal(docked.welcome, false, 'the hero is gone once the turn starts');
  assert.ok(docked.top / docked.vh > 0.75, 'the composer is docked again: ' + (docked.top / docked.vh).toFixed(3));

  const glide = (await evaluate('window.__anims')).find((entry) => entry.cls.includes('chat-input-area'));
  assert.ok(glide, 'the composer transition was animated, not snapped: ' + JSON.stringify(await evaluate('window.__anims.map(a => a.cls)')));
  assert.match(String(glide.frames?.[0]?.transform || ''), /^translate\(-?[\d.]+px, -?[\d.]+px\)$/);
  assert.equal(glide.options?.duration, 420);
});
