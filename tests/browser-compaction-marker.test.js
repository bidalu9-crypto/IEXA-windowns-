// The checkpoint has to be visible twice: while the turn streams it, and after
// the session is reopened from disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(x => fs.existsSync(x));

test('real browser: a checkpoint is marked in the live turn and after a reload', { skip: !browser, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-compaction-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  const root = fs.realpathSync.native(process.env.IEXA_WORKSPACE);
  const histDir = path.join(root, '.iexa-sessions');
  const storeFile = path.join(root, '.iexa-sessions.json');
  const sessionId = 'compaction-fixture-' + Date.now();
  const calls = [
    { id: 't1', name: 'shell_execute', args: { command: 'echo t1' }, result: { success: true, output: 't1', executionStatus: 'success' }, startedAt: 1, finishedAt: 2 },
    { id: 't2', name: 'shell_execute', args: { command: 'echo t2' }, result: { success: true, output: 't2', executionStatus: 'success' }, startedAt: 3, finishedAt: 4 },
  ];
  const messages = [
    { role: 'user', content: '压缩夹具', timestamp: 0 },
    {
      role: 'assistant', content: '压缩前后都保留了。', timestamp: 9, toolCalls: calls, durationMs: 12000,
      transcript: {
        version: 1, valid: true, turnId: 'turn-c', revision: 0, status: 'completed',
        items: [
          { type: 'tool', id: 'turn-c:1', sequence: 1, timestamp: 1, callId: 't1', name: 'shell_execute' },
          { type: 'compaction', id: 'turn-c:2', sequence: 2, timestamp: 2, before: 128000, after: 24000 },
          { type: 'tool', id: 'turn-c:3', sequence: 3, timestamp: 3, callId: 't2', name: 'shell_execute' },
          { type: 'text', id: 'turn-c:4', sequence: 4, timestamp: 4, start: 0, end: 9 },
        ],
      },
    },
  ];

  const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  t.after(async () => {
    try { socket?.close(); } catch { /* closed */ }
    proc.kill();
    await new Promise(r => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('browser startup timeout')), 20000);
    proc.stderr.on('data', d => { log += d; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then(r => r.json());
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let seq = 0; const waiting = new Map(); const exceptions = [];
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails);
    const entry = waiting.get(msg.id);
    if (entry) { waiting.delete(msg.id); entry(msg); }
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('UI condition timeout: ' + expression);
  };

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof SafeMarkdown !== 'undefined' && document.body.dataset.mobileClient === 'desktop'");
  await wait("currentSessionId && document.getElementById('shellAddProject')");

  // Seed the fixture only after the server has written its store file.
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, `${sessionId}.json`), JSON.stringify(messages));
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.sessions = [...(store.sessions || []), { id: sessionId, title: '压缩夹具', projectRoot: '', projectName: '无项目', createdAt: 0, updatedAt: 9, messageCount: messages.length }];
  fs.writeFileSync(storeFile, JSON.stringify(store));

  // The composer no longer asks the browser to spell-check Chinese prompts.
  assert.equal(await evaluate("document.getElementById('chatInput').getAttribute('spellcheck')"), 'false');

  await evaluate('(async () => { await syncConversationMetadata(); })()');
  await evaluate(`switchSession(${JSON.stringify(sessionId)})`);
  await wait("document.querySelectorAll('.chat-messages .message').length >= 2");
  await wait("document.querySelector('.transcript-compaction')");
  await new Promise(r => setTimeout(r, 300));

  const restored = await evaluate(`(() => {
    const message = document.querySelector('.chat-messages .message.assistant');
    const marker = message.querySelector('.transcript-compaction');
    const kids = [...message.children].map(node => node.className.split(' ')[0]);
    const box = marker.getBoundingClientRect();
    const icon = marker.querySelector('svg use')?.getAttribute('href');
    return {
      state: message.dataset.transcriptState,
      label: marker.querySelector('.compaction-label')?.textContent,
      delta: marker.querySelector('.compaction-delta')?.textContent,
      title: marker.getAttribute('title'),
      icon,
      role: marker.getAttribute('role'),
      order: kids,
      rails: message.querySelectorAll('.tool-steps').length,
      height: Math.round(box.height),
      border: getComputedStyle(marker).borderTopWidth,
      color: getComputedStyle(marker).color,
    };
  })()`);
  assert.equal(restored.state, 'ordered', 'the transcript replay must stay valid');
  assert.equal(restored.label, '上下文已自动压缩');
  assert.equal(restored.delta, '128K → 24K');
  assert.match(restored.title, /128,000 → 24,000 tokens/);
  assert.equal(restored.icon, '#ui-compact');
  assert.equal(restored.role, 'note');
  assert.equal(restored.border, '1px', 'the marker draws the boundary rule');
  // The marker splits the chain: one rail before it, one after it.
  assert.equal(restored.rails, 2, JSON.stringify(restored.order));
  const markerIndex = restored.order.indexOf('transcript-compaction');
  assert.ok(markerIndex > 0 && markerIndex < restored.order.length - 1, 'the marker sits between the two rails');

  // Live: the same boundary must appear while the turn streams.
  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input) === '/api/chat') {
        return new Response(new ReadableStream({
          start(controller) {
            const push = (frame) => controller.enqueue(new TextEncoder().encode(frame));
            window.__pushChat = push;
            push('event: turn_started\ndata: {}\n\n');
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);
  await evaluate("chatInput.value = 'live compaction'; void sendMessage(); true");
  await wait("typeof window.__pushChat === 'function'");
  await evaluate(`window.__pushChat(${JSON.stringify('event: compaction\ndata: {"before":96000,"after":18000}\n\n')}); true`);
  await wait("!!document.querySelector('.message.assistant:last-child .transcript-compaction') || !!document.querySelector('.transcript-compaction')");
  const live = await evaluate(`(() => {
    const markers = [...document.querySelectorAll('.transcript-compaction')];
    const marker = markers[markers.length - 1];
    return { count: markers.length, delta: marker.querySelector('.compaction-delta')?.textContent };
  })()`);
  assert.ok(live.count >= 2, 'the live marker joins the restored one');
  assert.equal(live.delta, '96K → 18K');

  assert.deepEqual(exceptions, [], 'no renderer exception while replaying or streaming a checkpoint');
});
