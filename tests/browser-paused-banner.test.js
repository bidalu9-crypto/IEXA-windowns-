const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a paused turn shows a banner that resumes the same stream', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-paused-ui-'));
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof sendMessage === 'function' && typeof currentSessionId !== 'undefined'");
  await wait("currentSessionId");
  await evaluate("document.documentElement.dataset.motion = 'full'; true");

  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.__calls = [];
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/chat') {
        return new Response(new ReadableStream({
          start(controller) {
            window.__pushChat = (frame) => controller.enqueue(new TextEncoder().encode(frame));
            controller.enqueue(new TextEncoder().encode('event: turn_started\ndata: {"thinkingLevel":"medium"}\n\n'));
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.startsWith('/api/pause') || url.startsWith('/api/resume') || url.startsWith('/api/cancel')) {
        window.__calls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);

  // Nothing is paused before the turn starts.
  assert.equal(await evaluate("document.getElementById('pausedBanner').hidden"), true);

  await evaluate("chatInput.value='a long job'; void sendMessage(); true");
  await wait("isProcessing === true && typeof window.__pushChat === 'function'");

  // The stop button parks the turn instead of killing it.
  await evaluate("document.getElementById('stopBtn').click(); true");
  await wait("window.__calls.some((url) => url.startsWith('/api/pause'))");
  assert.equal(await evaluate("window.__calls.some((url) => url.startsWith('/api/cancel'))"), false, 'stopping does not cancel');

  await evaluate("window.__pushChat('event: paused\\ndata: {}\\n\\n'); true");
  await wait("document.getElementById('pausedBanner').hidden === false");
  // The composer glides from the landing position on the first message; measure
  // only once both that FLIP and the banner's entrance have settled.
  await wait("document.querySelector('.chat-input-area').getAnimations().length === 0 && document.getElementById('pausedBanner').getAnimations().length === 0");

  const banner = await evaluate(`(() => {
    const el = document.getElementById('pausedBanner');
    const box = el.getBoundingClientRect();
    const composer = document.querySelector('.chat-input-area').getBoundingClientRect();
    return {
      title: el.querySelector('strong').textContent,
      hint: el.querySelector('small').textContent,
      buttons: Array.from(el.querySelectorAll('button')).map((button) => button.textContent),
      width: Math.round(box.width), composer: Math.round(composer.width),
      gap: Math.round(composer.top - box.bottom),
      radius: getComputedStyle(el).borderRadius,
      status: document.getElementById('statusText').textContent,
      role: el.getAttribute('role'),
      live: el.querySelector('.paused-banner-text').getAttribute('aria-live'),
    };
  })()`);
  assert.equal(banner.title, '任务已暂停');
  assert.match(banner.hint, /继续后从当前位置接着执行/);
  assert.deepEqual(banner.buttons, ['结束任务', '继续']);
  assert.equal(banner.width, banner.composer, 'the banner shares the composer column');
  assert.ok(banner.gap >= 0 && banner.gap <= 12, 'the banner sits just above the composer: ' + banner.gap);
  assert.equal(banner.radius, '12px');
  assert.equal(banner.status, '已暂停');
  assert.equal(banner.role, 'region');
  assert.equal(banner.live, 'polite', 'only the text is announced, not the buttons');

  // Continue resumes the same stream; nothing is re-sent as a new turn.
  await evaluate("document.getElementById('pausedResume').click(); true");
  await wait("window.__calls.some((url) => url.startsWith('/api/resume'))");
  await wait("document.getElementById('pausedBanner').hidden === true");
  assert.equal(await evaluate("window.__calls.filter((url) => url.startsWith('/api/chat')).length"), 0, 'no new chat request is made');

  await evaluate("window.__pushChat('event: done\\ndata: {}\\n\\n'); true");
  await wait("isProcessing === false");
  assert.equal(await evaluate("document.getElementById('pausedBanner').hidden"), true, 'a finished turn leaves no banner');

  // Ending a parked turn is an explicit, separate action.
  await evaluate("document.getElementById('pausedEnd').click(); true");
  await wait("window.__calls.some((url) => url.startsWith('/api/cancel'))");
});
