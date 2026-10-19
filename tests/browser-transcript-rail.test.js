// A restored turn must keep the task bar and the fold the live turn had.
// Transcript replay used to rebuild rails without a summary, so after a restart
// a folded turn came back as a wall of visible tool rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(x => fs.existsSync(x));

test('real browser: a restored chain keeps its task bar and stays folded', { skip: !browser, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rail-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
  // The setting has to exist before boot: the renderer reads it on first paint.
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
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

  const root = fs.realpathSync.native(process.env.IEXA_WORKSPACE);
  const histDir = path.join(root, '.iexa-sessions');
  fs.mkdirSync(histDir, { recursive: true });
  const sessionId = 'rail-fixture-' + Date.now();
  const calls = [
    { id: 't1', name: 'shell_execute', args: { command: 'echo t1' }, result: { success: true, output: 't1', executionStatus: 'success' }, startedAt: 1, finishedAt: 2 },
    { id: 't2', name: 'shell_execute', args: { command: 'echo t2' }, result: { success: true, output: 't2', executionStatus: 'success' }, startedAt: 3, finishedAt: 4 },
  ];
  const messages = [
    { role: 'user', content: '跑一批命令', timestamp: 0 },
    {
      role: 'assistant', content: '完成。', thinking: 'R1R2', timestamp: 5, toolCalls: calls,
      transcript: {
        version: 1, valid: true, turnId: 'turn-1', revision: 0, status: 'completed',
        items: [
          { type: 'thinking', id: 'turn-1:1', sequence: 1, timestamp: 1, start: 0, end: 2 },
          { type: 'tool', id: 'turn-1:2', sequence: 2, timestamp: 2, callId: 't1', name: 'shell_execute' },
          { type: 'thinking', id: 'turn-1:3', sequence: 3, timestamp: 3, start: 2, end: 4 },
          { type: 'tool', id: 'turn-1:4', sequence: 4, timestamp: 4, callId: 't2', name: 'shell_execute' },
          { type: 'text', id: 'turn-1:5', sequence: 5, timestamp: 5, start: 0, end: 3 },
        ],
      },
    },
  ];
  fs.writeFileSync(path.join(histDir, `${sessionId}.json`), JSON.stringify(messages));
  const storeFile = path.join(root, '.iexa-sessions.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.sessions = [...(store.sessions || []), { id: sessionId, title: '轨夹具', projectRoot: '', projectName: '无项目', createdAt: 0, updatedAt: 5, messageCount: messages.length }];
  fs.writeFileSync(storeFile, JSON.stringify(store));

  await evaluate('(async () => { await syncConversationMetadata(); })()');
  await evaluate(`switchSession(${JSON.stringify(sessionId)})`);
  await wait("document.querySelectorAll('.chat-messages .message').length >= 2");
  await wait("document.querySelectorAll('.tool-steps').length >= 2");
  await new Promise(r => setTimeout(r, 400));

  const state = await evaluate(`(() => {
    const rails = [...document.querySelectorAll('.tool-steps')];
    const blocks = [...document.querySelectorAll('.tool-block')];
    return {
      attr: document.documentElement.getAttribute('data-collapse-tools'),
      state: document.querySelector('.chat-messages .message:last-child').dataset.transcriptState,
      rails: rails.length,
      withPill: rails.filter(r => r.querySelector(':scope > .task-summary')).length,
      folded: rails.filter(r => r.classList.contains('is-collapsed')).length,
      blocks: blocks.length,
      visible: blocks.filter(b => getComputedStyle(b).display !== 'none').length,
      counts: rails.map(r => r.querySelector(':scope > .task-summary .task-summary-count')?.textContent),
    };
  })()`);
  assert.equal(state.attr, 'on');
  assert.equal(state.state, 'ordered');
  assert.equal(state.rails, 2, JSON.stringify(state));
  assert.equal(state.withPill, state.rails, 'every restored rail needs its task bar');
  assert.equal(state.folded, state.rails, 'a restored rail must start folded');
  assert.deepEqual(state.counts, ['1 次调用', '1 次调用']);
  assert.equal(state.visible, 0, 'a folded turn must not paint its rows');

  // Expanding is still the user's call, and it reveals only that rail's rows.
  await evaluate("document.querySelector('.tool-steps > .task-summary').click()");
  const opened = await evaluate(`(() => {
    const rail = document.querySelector('.tool-steps');
    return { folded: rail.classList.contains('is-collapsed'),
      visible: [...rail.querySelectorAll(':scope > .tool-block')].filter(b => getComputedStyle(b).display !== 'none').length,
      others: [...document.querySelectorAll('.tool-steps')].slice(1).filter(r => r.classList.contains('is-collapsed')).length };
  })()`);
  assert.equal(opened.folded, false);
  assert.equal(opened.visible, 1);
  assert.equal(opened.others, 1, 'opening one rail must not unfold the rest');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions[0] || {}));
});
