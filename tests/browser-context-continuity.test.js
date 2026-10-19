// A restart must not look like a new conversation.
//
// The context ring used to start at zero on every launch: the request size
// lived only in the running compactor. The session file now carries it, and the
// ring must paint it as soon as the session is opened — before any new turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(x => fs.existsSync(x));

test('real browser: a reopened session keeps its carried context size', { skip: !browser, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-context-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-appearance.json'),
    JSON.stringify({ theme: 'dark', motion: 'full', accent: 'blue', collapseConsecutiveTools: true }));
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  t.after(async () => {
    try { socket?.close(); } catch {}
    proc.kill();
    await new Promise(r => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows file lock */ }
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
    if (msg.id && waiting.has(msg.id)) { const done = waiting.get(msg.id); waiting.delete(msg.id); done(msg); return; }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
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

  const root = fs.realpathSync.native(process.env.IEXA_WORKSPACE);
  const sessionsDir = path.join(root, '.iexa-sessions');
  const contextDir = path.join(root, '.iexa-session-context');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });

  const carriedId = 'ctx-carried-' + Date.now();
  const freshId = 'ctx-fresh-' + Date.now();
  const messages = [
    { role: 'user', content: '继续上次的活', timestamp: 0 },
    { role: 'assistant', content: '好。', timestamp: 5 },
  ];
  fs.writeFileSync(path.join(sessionsDir, `${carriedId}.json`), JSON.stringify(messages));
  fs.writeFileSync(path.join(sessionsDir, `${freshId}.json`), JSON.stringify(messages));
  // Exactly what a measured run leaves behind: 242K of a 1M window.
  fs.writeFileSync(path.join(contextDir, `${carriedId}.json`), JSON.stringify({
    version: 2, sessionId: carriedId, updatedAt: 1, content: '索引',
    usage: { usedTokens: 242000, contextWindow: 1000000, compactThreshold: 800000, estimated: false, updatedAt: 1 },
  }));
  const storeFile = path.join(root, '.iexa-sessions.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.sessions = [...(store.sessions || []),
    { id: carriedId, title: '续接夹具', projectRoot: '', projectName: '无项目', createdAt: 0, updatedAt: 5, messageCount: 2 },
    { id: freshId, title: '空夹具', projectRoot: '', projectName: '无项目', createdAt: 0, updatedAt: 5, messageCount: 2 }];
  fs.writeFileSync(storeFile, JSON.stringify(store));

  await evaluate('(async () => { await syncConversationMetadata(); })()');

  const ring = `(() => ({
    percent: document.getElementById('contextProgressPercent')?.textContent,
    title: document.getElementById('contextProgress')?.title,
  }))()`;

  await evaluate(`switchSession(${JSON.stringify(carriedId)})`);
  await wait("document.getElementById('contextProgressPercent')?.textContent === '24%'");
  const carried = await evaluate(ring);
  assert.equal(carried.percent, '24%', 'a reopened session must not start the ring at zero');
  assert.match(carried.title, /242K \/ 1M tokens/, carried.title);
  assert.match(carried.title, /24%/, carried.title);
  assert.match(carried.title, /阈值 80%/, carried.title);

  // A session without accounting must clear rather than inherit the last one.
  await evaluate(`switchSession(${JSON.stringify(freshId)})`);
  await wait("document.getElementById('contextProgressPercent')?.textContent === '0%'");
  const fresh = await evaluate(ring);
  assert.equal(fresh.percent, '0%');
  assert.match(fresh.title, /尚无请求/, fresh.title);

  // Returning to the carried session (cached runtime) must restore its number.
  await evaluate(`switchSession(${JSON.stringify(carriedId)})`);
  await wait("document.getElementById('contextProgressPercent')?.textContent === '24%'");
  const again = await evaluate(ring);
  assert.equal(again.percent, '24%');
  assert.match(again.title, /242K/, again.title);

  // A branch reset shortens the conversation, so the carried size must go: the
  // server drops the record and the next load reports no accounting at all.
  const afterReset = await evaluate(`(async () => {
    const r = await fetch('/api/sessions/${carriedId}/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageIndex: 0 }),
    });
    const s = await (await fetch('/api/sessions/${carriedId}')).json();
    return { ok: r.ok, context: s.context, count: (s.messages || []).length };
  })()`);
  assert.equal(afterReset.ok, true);
  assert.equal(afterReset.count, 1);
  assert.equal(afterReset.context, null, 'a shortened conversation must not keep its old size');

  await evaluate(`applySessionContextStatus(${JSON.stringify(carriedId)}, null)`);
  const cleared = await evaluate(ring);
  assert.equal(cleared.percent, '0%', 'the ring must clear with the record');
  assert.match(cleared.title, /尚无请求/, cleared.title);

  assert.equal(exceptions.length, 0, JSON.stringify(exceptions[0] || {}));
});
