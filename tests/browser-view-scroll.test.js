const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(x => fs.existsSync(x));

test('real browser: a view switch keeps the transcript where the reader left it', { skip: !browser, timeout: 150000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-viewscroll-'));
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
    if (socket) { try { socket.close(); } catch {} }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise(r => setTimeout(r, 1500))]);
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows file lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('browser startup timeout')), 15000);
    proc.stderr.on('data', d => { log += d; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then(r => r.json());
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let sequence = 0; const waiting = new Map(); const exceptions = [];
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails);
    const entry = waiting.get(msg.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(msg.id); entry.resolve(msg); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 600));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof SafeMarkdown !== 'undefined' && document.body.dataset.mobileClient === 'desktop'");
  await wait("currentSessionId && document.getElementById('shellAddProject')");

  const root = fs.realpathSync.native(process.env.IEXA_WORKSPACE);
  const histDir = path.join(root, '.iexa-sessions');
  fs.mkdirSync(histDir, { recursive: true });
  const sessionId = 'view-scroll-' + Date.now();
  const total = 60;
  const messages = [];
  for (let i = 0; i < total; i++) {
    messages.push(i % 2 === 0
      ? { role: 'user', content: `第 ${i} 个问题`, timestamp: Date.now() + i }
      : { role: 'assistant', content: `## 回答 ${i}\n\n` + '正文段落内容，用来撑出高度。'.repeat(14) + `\n\n\`\`\`ts\nexport const v${i} = ${i};\n\`\`\``, timestamp: Date.now() + i });
  }
  fs.writeFileSync(path.join(histDir, `${sessionId}.json`), JSON.stringify(messages));
  const storeFile = path.join(root, '.iexa-sessions.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.sessions = [...(store.sessions || []), {
    id: sessionId, title: '滚动夹具', projectRoot: '', projectName: '无项目',
    created: Date.now(), updated: Date.now(), messageCount: total,
  }];
  fs.writeFileSync(storeFile, JSON.stringify(store));
  await evaluate('loadSessionList()');
  await wait('sessionsCache.some(s => s.id === ' + JSON.stringify(sessionId) + ')');
  await evaluate(`switchSession(${JSON.stringify(sessionId)})`);
  await wait(`document.querySelectorAll('.chat-messages .message').length === ${total}`);
  await new Promise(r => setTimeout(r, 600));

  const read = `(() => { const el = document.querySelector('.chat-messages');
    return { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
             client: el.clientHeight, height: el.scrollHeight, near: isNearChatBottom }; })()`;
  const toChat = "document.querySelector('[data-view=\"chat\"]').click()";
  const toSettings = "document.querySelector('[data-view=\"settings\"]').click()";
  const settle = () => new Promise(r => setTimeout(r, 250));

  // 1. Reading the newest message survives a round trip.
  await evaluate('scrollToBottom(true)');
  await settle();
  const atBottom = await evaluate(read);
  assert.ok(atBottom.gap < 4 && atBottom.height > atBottom.client * 4, 'fixture must overflow: ' + JSON.stringify(atBottom));
  await evaluate(toSettings);
  await settle();
  await evaluate(toChat);
  await new Promise(r => setTimeout(r, 450));
  const returned = await evaluate(read);
  assert.notEqual(returned.top, 0, 'the transcript must not snap back to its first message');
  assert.ok(returned.gap < 4, `returning to a followed transcript lands at the newest message: ${JSON.stringify(returned)}`);
  assert.equal(returned.near, true);

  // 2. A reader parked mid-history gets their exact offset back.
  await evaluate("(() => { document.querySelector('.chat-messages').scrollTop = 900; })()");
  await settle();
  const parked = await evaluate(read);
  assert.equal(parked.top, 900);
  await evaluate(toSettings);
  await settle();
  await evaluate(toChat);
  await new Promise(r => setTimeout(r, 450));
  const resumed = await evaluate(read);
  assert.equal(resumed.top, 900, `mid-transcript offset is restored, saw ${JSON.stringify(resumed)}`);
  assert.equal(resumed.near, false, 'a parked reader must not be marked as following the newest message');

  // 3. Messages that arrive while the view is hidden keep a following reader at
  //    the newest one, instead of resurrecting the stale offset.
  await evaluate('scrollToBottom(true)');
  await settle();
  await evaluate(toSettings);
  await settle();
  await evaluate("addMessage('assistant', '隐藏期间到达的回答', [], {})");
  await settle();
  await evaluate(toChat);
  await new Promise(r => setTimeout(r, 450));
  const afterHiddenAppend = await evaluate(read);
  assert.ok(afterHiddenAppend.gap < 4, `a following reader stays at the bottom: ${JSON.stringify(afterHiddenAppend)}`);
  assert.equal(afterHiddenAppend.height > atBottom.height, true, 'the appended message must have grown the transcript');

  // 4. The remembered offset belongs to its own conversation: switching to
  //    another session while the chat is hidden must not resurrect it.
  const otherId = 'view-scroll-other-' + Date.now();
  const otherMessages = [
    { role: 'user', content: '另一个会话', timestamp: Date.now() },
    { role: 'assistant', content: '短回复。', timestamp: Date.now() + 1 },
  ];
  fs.writeFileSync(path.join(histDir, `${otherId}.json`), JSON.stringify(otherMessages));
  const withOther = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  withOther.sessions = [...withOther.sessions, {
    id: otherId, title: '另一个会话', projectRoot: '', projectName: '无项目',
    created: Date.now(), updated: Date.now(), messageCount: otherMessages.length,
  }];
  fs.writeFileSync(storeFile, JSON.stringify(withOther));
  await evaluate('loadSessionList()');
  await wait('sessionsCache.some(s => s.id === ' + JSON.stringify(otherId) + ')');

  await evaluate("(() => { document.querySelector('.chat-messages').scrollTop = 700; })()");
  await settle();
  await evaluate(toSettings);
  await settle();
  await evaluate(`switchSession(${JSON.stringify(otherId)})`);
  await settle();
  await evaluate(toChat);
  await new Promise(r => setTimeout(r, 450));
  const crossSession = await evaluate(read);
  assert.equal(crossSession.top, 0, `a stored offset must not leak across a session switch: ${JSON.stringify(crossSession)}`);
  assert.equal(await evaluate("document.querySelectorAll('.chat-messages .message').length"), otherMessages.length);

  assert.deepEqual(exceptions, [], 'no renderer exceptions during view switches');
});
