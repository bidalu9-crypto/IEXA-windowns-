const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: default immediate insert, plus queue and steer routing', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-steer-ui-'));
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
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof sendMessage === 'function' && typeof currentSessionId !== 'undefined'");
  await wait("currentSessionId");

  // Stub only the two turn endpoints; everything else hits the real server.
  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.__steerPayload = null;
    window.__chatFrames = [];
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/chat') {
        const body = JSON.parse(init.body || '{}');
        window.__chatPayload = body;
        return new Response(new ReadableStream({
          start(controller) {
            window.__pushChat = (frame) => controller.enqueue(new TextEncoder().encode(frame));
            controller.enqueue(new TextEncoder().encode('event: turn_started\ndata: {"thinkingLevel":"medium"}\n\n'));
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url === '/api/steer') {
        window.__steerPayload = JSON.parse(init.body || '{}');
        return new Response(JSON.stringify({ ok: true, steerId: window.__steerPayload.steerId }), {
          status: 202, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('/api/cancel')) {
        window.__cancelCalls = (window.__cancelCalls || 0) + 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return window.__realFetch(input, init);
    };
  })()`);

  // Start a turn and keep its stream open.
  await evaluate("chatInput.value='start a long task'; void sendMessage(); true");
  await wait("isProcessing === true && !!window.__chatPayload");

  // Enter must insert immediately by default — the behaviour "插入对话" promises.
  assert.equal(await evaluate("followUpMode"), 'interrupt');
  assert.equal(await evaluate("document.getElementById('followUpModeSelect').value"), 'interrupt');
  assert.equal(await evaluate("document.getElementById('followUpModeBtn') === null"), true,
    'the composer has no mode chip');

  // One round button, like Codex: stop replaces send while the turn runs, and
  // the composer carries no mode jargon.
  assert.equal(await evaluate("getComputedStyle(stopBtn).display !== 'none'"), true, 'stop is the visible action');
  assert.equal(await evaluate("getComputedStyle(sendBtn).display === 'none'"), true, 'send is not shown beside stop');
  assert.equal(await evaluate("chatInput.placeholder"), '有问题，随便问');
  assert.equal(await evaluate("document.querySelector('.input-actions').textContent.trim()"), '');

  // queue: the bubble must stay pending and no steer is posted.
  await evaluate("followUpMode='queue'; chatInput.value='QUEUED_FOLLOW_UP'; void sendMessage(); true");
  await wait("!!document.querySelector('.message.user.is-queued')");
  assert.equal(await evaluate("window.__steerPayload"), null, 'queue must not touch /api/steer');

  // steer: immediate bubble + POST; applied only when the server says so.
  await evaluate("followUpMode='steer'; chatInput.value='STEER_FOLLOW_UP'; void sendMessage(); true");
  await wait("window.__steerPayload && document.querySelector('.message.user.is-steering')");
  assert.match(await evaluate("window.__steerPayload.message"), /STEER_FOLLOW_UP/);
  const steerId = await evaluate("window.__steerPayload.steerId");
  assert.ok(steerId, 'the renderer generates a steer id');
  assert.equal(await evaluate("document.querySelector('.message.user.is-steering').dataset.steerId"), steerId);

  // A steer belongs to its own conversation: switching away must not strand
  // the pending bubble when the server commits it.
  const originSessionId = await evaluate("currentSessionId");
  await evaluate("void createSession(); true");
  await wait(`currentSessionId && currentSessionId !== '${originSessionId}'`);
  await evaluate(`window.__pushChat('event: steer_applied\\ndata: ' + JSON.stringify({ id: '${steerId}', timestamp: Date.now() }) + '\\n\\n'); true`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await evaluate("!!document.querySelector('.message.user.is-steering')"), false);
  await evaluate(`void switchSession('${originSessionId}', false); true`);
  await wait(`visibleSessionId === '${originSessionId}'`);
  assert.equal(await evaluate("!!document.querySelector('.message.user.is-steering[data-steer-id]')"), false);
  assert.equal(await evaluate("!!document.querySelector('.message.user[data-steer-id]')"), true);
  assert.match(
    await evaluate("document.querySelector('.message.is-steer-applied .steer-badge-text')?.textContent || ''"),
    /已插入本轮/,
    'a committed steer still shows that it is waiting for a reply',
  );

  // interrupt: jumps the queue, stops the step, and runs as soon as the server
  // confirms cancellation.
  await evaluate("followUpMode='interrupt'; chatInput.value='INTERRUPT_FOLLOW_UP'; void sendMessage(); true");
  await wait("window.__cancelCalls > 0 && document.querySelector('.message.user.is-interrupting')");
  assert.equal(await evaluate("!!document.querySelector('.message.user.is-interrupting .queued-badge')"), false,
    'an immediate insert is not a queued bubble');

  await evaluate("window.__pushChat('event: cancelled\\ndata: {}\\n\\n'); true");
  await wait("window.__chatPayload.message === 'INTERRUPT_FOLLOW_UP'");
  assert.equal(await evaluate("!!document.querySelector('.message.user.is-interrupting')"), false,
    'the bubble turns live once the turn is handed over');
  assert.equal(await evaluate("!!document.querySelector('.message.is-steer-applied .steer-badge')"), false,
    'ending the turn retires any stale waiting note');

  // Finish that turn: the older queued bubble drains next, in FIFO order.
  await evaluate("window.__pushChat('event: done\\ndata: {\"stopReason\":\"endTurn\"}\\n\\n'); true");
  await wait("window.__chatPayload.message === 'QUEUED_FOLLOW_UP'");
  assert.equal(await evaluate("window.__steerPayload.message"), 'STEER_FOLLOW_UP');
  assert.equal(await evaluate("!!document.querySelector('.message.user.is-queued')"), false, 'the queue bubble became a live turn');

  await evaluate("window.__pushChat('event: done\\ndata: {\"stopReason\":\"endTurn\"}\\n\\n'); true");
  await wait("isProcessing === false");
  assert.equal(await evaluate("getComputedStyle(sendBtn).display !== 'none'"), true, 'send returns when the turn ends');
  assert.equal(await evaluate("getComputedStyle(stopBtn).display === 'none'"), true);
});
