const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(x => fs.existsSync(x));

test('real browser: the purge action clears settled tasks and keeps running ones', { skip: !browser, timeout: 150000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-jobs-clear-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
  // Seed the audit trail before the first read so the panel, the DELETE route
  // and the file all see the same data.
  const now = Date.now();
  const seeded = [];
  for (let i = 0; i < 4; i += 1) {
    seeded.push({ id: `a_${i}`, sessionId: 'sess_a', kind: 'tool', toolName: 'shell_execute', title: `A ${i}`, status: 'completed', createdAt: now - i * 1000, finishedAt: now - i * 1000 });
  }
  seeded.push({ id: 'a_live', sessionId: 'sess_a', kind: 'tool', toolName: 'shell_execute', title: '仍在运行', status: 'running', createdAt: now, startedAt: now });
  for (let i = 0; i < 3; i += 1) {
    seeded.push({ id: `b_${i}`, sessionId: 'sess_b', kind: 'tool', toolName: 'file_write', title: `B ${i}`, status: 'completed', createdAt: now - i * 1000, finishedAt: now - i * 1000 });
  }
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-jobs.json'), JSON.stringify(seeded));

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
    for (let i = 0; i < 240; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof SafeMarkdown !== 'undefined' && document.body.dataset.mobileClient === 'desktop'");
  await wait("typeof loadJobs === 'function' && currentSessionId");

  await evaluate("document.querySelector('[data-view=\"jobs\"]').click()");
  await wait("document.getElementById('view-jobs').classList.contains('active')");
  // "全部会话" so the seeded rows from both conversations are visible.
  await evaluate("document.querySelector('[data-jobs-filter=\"all\"]').click()");
  await wait("document.querySelectorAll('#jobsList .job-card').length === 8");

  const hint = await evaluate("document.getElementById('jobsRetentionHint').textContent");
  assert.match(hint, /7 天/, 'the panel states the retention window it actually enforces');
  assert.match(hint, /200 条/);

  // The dialog names the scope the visible filter implies.
  const opened = await evaluate(`(async () => {
    document.getElementById('jobsClearBtn').click();
    await new Promise(r => setTimeout(r, 120));
    const dialog = document.querySelector('dialog.iexa-app-dialog');
    return { message: dialog ? dialog.querySelector('p').textContent : '', scope: jobsFilter };
  })()`);
  assert.equal(opened.scope, 'all');
  assert.match(opened.message, /全部会话/);
  assert.match(opened.message, /正在运行的任务会保留/);

  // Cancelling leaves everything alone.
  await evaluate(`(() => {
    const dialog = document.querySelector('dialog.iexa-app-dialog');
    dialog.querySelector('.iexa-app-dialog-actions button:not(.btn-primary)').click();
  })()`);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await evaluate("document.querySelectorAll('#jobsList .job-card').length"), 8);

  // Confirming purges settled rows and reloads from the server.
  await evaluate(`(async () => {
    document.getElementById('jobsClearBtn').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('dialog.iexa-app-dialog .btn-primary').click();
  })()`);
  await wait("document.querySelectorAll('#jobsList .job-card').length === 1");
  const survivor = await evaluate(`(() => {
    const card = document.querySelector('#jobsList .job-card');
    return { title: card.querySelector('.job-row-title').textContent,
             status: card.querySelector('.job-status').textContent,
             badge: document.getElementById('navJobBadge').textContent };
  })()`);
  assert.equal(survivor.title, '仍在运行');
  assert.equal(survivor.status, '运行中');
  assert.equal(survivor.badge, '1', 'the running count survives the purge');

  // The file on disk agrees with the panel.
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-jobs.json'), 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, 'a_live');

  assert.deepEqual(exceptions, [], 'no renderer exceptions while purging');
});
