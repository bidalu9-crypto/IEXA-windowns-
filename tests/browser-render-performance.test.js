const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(x => fs.existsSync(x));

test('real browser: history renders in frames, skips needless rebuilds and keeps views mounted', { skip: !browser, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-render-'));
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
    // A teardown that fails on a Windows file lock turns a green run red for a
    // reason that has nothing to do with the code under test. Retries cover the
    // normal case; the catch covers Chromium still holding the profile.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* locked */ }
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
    for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); }
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
  const sessionId = 'render-fixture-' + Date.now();
  const total = 40;
  const messages = [];
  for (let i = 0; i < total; i++) {
    messages.push(i % 2 === 0
      ? { role: 'user', content: `问题 ${i}`, timestamp: Date.now() + i }
      : { role: 'assistant', content: `## 回答 ${i}\n\n正文段落 ${i}。\n\n\`\`\`ts\nexport const v${i} = ${i};\n\`\`\``, timestamp: Date.now() + i });
  }
  fs.writeFileSync(path.join(histDir, `${sessionId}.json`), JSON.stringify(messages));
  const storeFile = path.join(root, '.iexa-sessions.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.sessions = [...(store.sessions || []), {
    id: sessionId, title: '渲染回归夹具', projectRoot: '', projectName: '无项目',
    created: Date.now(), updated: Date.now(), messageCount: total,
  }];
  fs.writeFileSync(storeFile, JSON.stringify(store));
  await evaluate('loadSessionList()');
  await wait('sessionsCache.some(s => s.id === ' + JSON.stringify(sessionId) + ')');

  // History must arrive across several frames, not in one blocking pass.
  await evaluate(`(() => {
    window.__seen = [];
    window.__watch = true;
    (function tick() {
      if (window.__watch && document.querySelector('.chat-messages')) {
        window.__seen.push(document.querySelectorAll('.chat-messages .message').length);
      }
      requestAnimationFrame(tick);
    })();
  })()`);
  await evaluate(`switchSession(${JSON.stringify(sessionId)})`);
  await evaluate('window.__watch = false');
  const seen = await evaluate('window.__seen');
  const distinct = [...new Set(seen)].filter(n => n > 0);
  assert.ok(distinct.length >= 2, `history should paint across frames, saw ${JSON.stringify(distinct.slice(0, 12))}`);
  // At least one painted frame must be a partial transcript: that is what keeps
  // a long history from becoming a single blocking layout.
  assert.ok(Math.max(...distinct.slice(0, -1)) < total, `a frame should show partial history, saw ${JSON.stringify(distinct.slice(0, 12))}`);
  assert.equal(await evaluate("document.querySelectorAll('.chat-messages .message').length"), total);
  assert.equal(await evaluate("(() => { const el = document.querySelector('.chat-messages'); return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 4; })()"), true);

  // The startup anchor lock suppresses refreshes for a few seconds after a
  // switch. Let it expire so the assertions below exercise the count guard
  // rather than the lock.
  await new Promise(r => setTimeout(r, 5400));

  // A metadata bump that matches what is already mounted must not rebuild.
  await evaluate(`(() => { window.__reloads = 0; const orig = reloadSessionView; window.reloadSessionView = async function (...a) { window.__reloads++; return orig.apply(this, a); }; })()`);
  const touched = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  touched.sessions = touched.sessions.map(s => s.id === sessionId ? { ...s, updated: Date.now() } : s);
  fs.writeFileSync(storeFile, JSON.stringify(touched));
  await evaluate('(async () => { await syncConversationMetadata(); })()');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await evaluate('window.__reloads'), 0, 'matching message count must not rebuild the transcript');

  // The count guard must not mask a real change: append messages to the file so
  // the server recomputes a different messageCount.
  const grownMessages = [...messages,
    { role: 'user', content: '追加问题', timestamp: Date.now() },
    { role: 'assistant', content: '追加回答', timestamp: Date.now() }];
  fs.writeFileSync(path.join(histDir, `${sessionId}.json`), JSON.stringify(grownMessages));
  const grownStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  grownStore.sessions = grownStore.sessions.map(s => s.id === sessionId
    ? { ...s, messageCount: grownMessages.length, updated: Date.now() }
    : s);
  fs.writeFileSync(storeFile, JSON.stringify(grownStore));
  await evaluate('(async () => { await syncConversationMetadata(); })()');
  await new Promise(r => setTimeout(r, 400));
  assert.ok(await evaluate('window.__reloads') >= 1, 'a changed message count must still refresh');

  // Views stay mounted and keep their DOM identity across navigation.
  await evaluate(`switchSession(${JSON.stringify(sessionId)})`);
  await wait("document.querySelectorAll('.chat-messages .message').length === " + grownMessages.length);
  await evaluate("document.querySelector('[data-view=\"settings\"]').click()");
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await evaluate("getComputedStyle(document.getElementById('view-chat')).contentVisibility"), 'hidden');
  assert.equal(await evaluate("document.getElementById('view-chat').getBoundingClientRect().width"), 0, 'inactive views must not intercept input');
  await evaluate("document.querySelector('[data-view=\"chat\"]').click()");
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await evaluate("getComputedStyle(document.getElementById('view-chat')).contentVisibility"), 'visible');
  assert.equal(await evaluate("document.querySelectorAll('.chat-messages .message').length"), grownMessages.length);
  // A click inside the returning view must reach the view, not a stacked sibling.
  assert.equal(await evaluate("document.elementFromPoint(640, 400)?.closest('.view')?.id"), 'view-chat');

  assert.deepEqual(exceptions, []);
  await cdp('Browser.close').catch(() => {});
});
