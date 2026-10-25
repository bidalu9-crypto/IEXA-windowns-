// The parked state has two ways out, and both used to leave the UI wrong:
//   结束任务 waited for a terminal SSE event a parked turn can never send,
//   and 继续 appended a fresh empty bubble instead of reviving the paused one.
// One browser, one flow, so the assertions follow the real lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

function seed(workspace) {
  const now = Date.now();
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: 'sess_parked',
    sessions: [{
      id: 'sess_parked', title: '查系统', created: now, updated: now,
      messageCount: 2, projectRoot: '', projectName: '无项目',
    }],
  }), 'utf8');
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_parked.json'), JSON.stringify([
    { role: 'user', content: '我的操作系统和硬件配置是什么？', timestamp: now - 8000 },
    {
      role: 'assistant', content: '我来查一下这台机器的系统与硬件信息。', status: 'paused',
      timestamp: now - 7000, durationMs: 7000, thinkingLevel: 'high',
      toolCalls: [
        { id: 'c1', name: 'shell_execute', args: { tool_title: '系统信息', command: 'systeminfo' }, result: { success: true, output: 'ok', durationMs: 900 } },
        { id: 'c2', name: 'shell_execute', args: { tool_title: '硬件', command: 'wmic' }, result: { success: true, output: 'ok', durationMs: 700 } },
      ],
    },
  ]), 'utf8');
}

test('real browser: a parked turn resumes in place and ends locally', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-parked-recovery-'));
  const workspace = path.join(dir, 'workspace');
  seed(workspace);
  process.env.IEXA_WORKSPACE = workspace;

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
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* lock */ }
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
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 8000);
    waiting.set(id, { resolve, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  };
  const wait = async (expression) => {
    for (let index = 0; index < 150; index += 1) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId === 'sess_parked'");
  await wait("document.getElementById('pausedBanner').hidden === false");

  // The restored turn is one message, marked as parked.
  const before = await evaluate(`({
    messages: document.querySelectorAll('#chatMessages .message.assistant').length,
    parked: document.querySelectorAll('#chatMessages .message.assistant[data-parked-turn="1"]').length,
  })`);
  assert.equal(before.messages, 1, 'the seeded turn is a single message');
  assert.equal(before.parked, 1, 'it is marked as parked so 继续 can revive it');

  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.__chatBody = null;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/chat') {
        window.__chatBody = JSON.parse(init.body || '{}');
        return new Response(new ReadableStream({
          start(controller) {
            window.__push = (frame) => controller.enqueue(new TextEncoder().encode(frame));
            controller.enqueue(new TextEncoder().encode('event: turn_started\ndata: {}\n\n'));
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.startsWith('/api/cancel')) {
        window.__cancelCalls = (window.__cancelCalls || 0) + 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);

  // ---- 继续: revive, do not append ----
  await evaluate("document.getElementById('pausedResume').click(); true");
  await wait("!!window.__chatBody");
  assert.equal(await evaluate('window.__chatBody.continueTurn'), true, 'the request continues the stored turn');

  // The server replays the prose already streamed, so the bubble keeps its text.
  await evaluate(String.raw`window.__push('event: text\ndata: {"content":"我来查一下这台机器的系统与硬件信息。CPU 是 14900K。"}\n\n'); true`);
  await wait("(document.querySelector('#chatMessages .message.assistant .message-content')?.textContent || '').includes('14900K')");
  await wait("document.getElementById('chatInput').disabled === false");

  const during = await evaluate(`({
    messages: document.querySelectorAll('#chatMessages .message.assistant').length,
    parked: document.querySelectorAll('#chatMessages .message.assistant[data-parked-turn="1"]').length,
    text: document.querySelector('#chatMessages .message.assistant .message-content')?.textContent || '',
  })`);
  assert.equal(during.messages, 1, '继续 must not add a second assistant bubble');
  assert.equal(during.parked, 0, 'the revived bubble is no longer parked');
  assert.match(during.text, /我来查一下这台机器的系统与硬件信息/, 'the earlier prose survives');
  assert.match(during.text, /14900K/, 'the new prose is appended to it');

  // ---- park again, then end it ----
  await evaluate(String.raw`window.__push('event: paused\ndata: {}\n\n'); true`);
  await wait("document.getElementById('pausedBanner').hidden === false");
  assert.equal(await evaluate("document.querySelectorAll('#chatMessages .message.assistant[data-parked-turn=\"1\"]').length"), 1,
    'the parked bubble is marked again for the next continue');

  await evaluate("document.getElementById('pausedEnd').click(); true");
  await wait("document.getElementById('pausedBanner').hidden === true");
  await wait("document.getElementById('statusText').textContent === '就绪'");
  const ended = await evaluate(`({
    calls: window.__cancelCalls || 0,
    input: document.getElementById('chatInput').disabled,
    send: document.getElementById('sendBtn').style.display,
    stop: document.getElementById('stopBtn').style.display,
    pending: !!runtimeForSession('sess_parked').turnStopPending,
    parked: !!(runtimeForSession('sess_parked').pausedTurn || runtimeForSession('sess_parked').interruptedTurn),
  })`);
  assert.equal(ended.calls, 1, 'the cancel request is made once');
  assert.equal(ended.input, false, 'the composer is usable again');
  assert.equal(ended.send, 'flex', 'send is the visible action');
  assert.equal(ended.stop, 'none', 'stop is gone');
  assert.equal(ended.pending, false, 'no terminal event is awaited');
  assert.equal(ended.parked, false, 'the parked state is cleared');
});
