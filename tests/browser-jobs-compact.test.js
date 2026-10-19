const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(x => fs.existsSync(x));

test('real browser: the task center is compact, collapsible and does not re-render on a no-op poll', { skip: !browser, timeout: 150000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-jobs-'));
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  const wsUrl = await new Promise((resolve, reject) => {
    // Three browser suites run in parallel; Chromium's cold start on a loaded
    // machine is slow enough to blow a tight budget. A generous ceiling still
    // fails fast when the browser genuinely never comes up.
    let log = ''; const timer = setTimeout(() => reject(new Error('browser startup timeout')), 60000);
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
  await wait("typeof applyJobUpdate === 'function' && currentSessionId");

  await evaluate("document.querySelector('[data-view=\"jobs\"]').click()");
  await wait("document.getElementById('view-jobs').classList.contains('active')");

  // Twelve rows: enough that a rebuild per job event would be visible.
  const now = Date.now();
  await evaluate(`(() => {
    jobsCache.length = 0; jobCardNodes.clear(); jobsRenderShape = 'idle'; jobsExpanded.clear();
    jobsFilter = 'all';
    for (let i = 0; i < 12; i++) {
      applyJobUpdate({
        id: 'job_' + i, sessionId: currentSessionId, kind: i % 4 === 0 ? 'turn' : 'tool',
        toolName: i % 4 === 0 ? '' : 'shell_execute', title: '任务 ' + i,
        status: i === 0 ? 'running' : 'completed', startedAt: ${now} - i * 60000,
        createdAt: ${now} - i * 60000, outputPreview: i === 0 ? '' : '输出内容 ' + i,
      });
    }
    return document.querySelectorAll('#jobsList .job-card').length;
  })()`);
  await wait("document.querySelectorAll('#jobsList .job-card').length === 12");

  const geometry = await evaluate(`(() => {
    const card = document.querySelector('#jobsList .job-card');
    const row = card.querySelector('.job-row');
    const body = card.querySelector('.job-body');
    return { card: Math.round(card.getBoundingClientRect().height),
             row: Math.round(row.getBoundingClientRect().height),
             bodyHidden: body.hidden, expanded: row.getAttribute('aria-expanded'),
             outputText: card.querySelector('.job-output').textContent,
             headerBtn: Math.round(document.getElementById('jobsRefreshBtn').getBoundingClientRect().width),
             headerGap: Math.round(document.getElementById('jobsRefreshBtn').getBoundingClientRect().left
               - document.querySelector('#view-jobs .settings-header h2').getBoundingClientRect().right) };
  })()`);
  assert.ok(geometry.card <= 44, `a collapsed card is a single ~34px row: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.bodyHidden, true, 'details start collapsed');
  assert.equal(geometry.expanded, 'false');
  assert.ok(geometry.headerBtn <= 120, `the refresh action keeps its intrinsic width: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.headerGap > 0, 'the header action sits clear of the title');

  // Expanding reveals the detail pane; the row itself stays one line.
  const expanded = await evaluate(`(() => {
    const card = document.querySelector('#jobsList .job-card');
    card.querySelector('.job-row').click();
    const body = card.querySelector('.job-body');
    return { hidden: body.hidden, expanded: card.querySelector('.job-row').getAttribute('aria-expanded'),
             text: body.querySelector('.job-output').textContent, row: Math.round(card.getBoundingClientRect().height) };
  })()`);
  assert.equal(expanded.hidden, false, 'clicking the row opens the details');
  assert.equal(expanded.expanded, 'true');
  assert.equal(expanded.text, '输出内容 11');
  assert.ok(expanded.row > geometry.row, 'the expanded card grows');

  // An update mutates the existing node and keeps it open: no rebuild, so no
  // lost expansion, focus or selection.
  const reuse = await evaluate(`(() => {
    const card = document.querySelector('#jobsList .job-card');
    window.__jobCard = card;
    applyJobUpdate({ ...jobsCache.find(j => j.id === 'job_11'), status: 'failed', outputPreview: '失败了' });
    return { same: window.__jobCard === document.querySelector('#jobsList .job-card'),
             status: document.querySelector('#jobsList .job-card .job-status').textContent,
             expanded: document.querySelector('#jobsList .job-card .job-row').getAttribute('aria-expanded'),
             output: document.querySelector('#jobsList .job-card .job-output').textContent,
             cards: document.querySelectorAll('#jobsList .job-card').length };
  })()`);
  assert.equal(reuse.same, true, 'the card element is reused, not recreated');
  assert.equal(reuse.status, '失败');
  assert.equal(reuse.expanded, 'true', 'an expanded card stays expanded across updates');
  assert.equal(reuse.output, '失败了');
  assert.equal(reuse.cards, 12);

  // A poll that returns identical data must not touch the DOM at all.
  const idleMutations = await evaluate(`(async () => {
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    observer.observe(document.getElementById('jobsList'), { childList: true, subtree: true, attributes: true, characterData: true });
    const snapshot = jobsCache.map(j => ({ ...j }));
    for (let i = 0; i < 3; i++) applyJobUpdate(snapshot[i % snapshot.length]);
    await new Promise(r => setTimeout(r, 150));
    observer.disconnect();
    return count;
  })()`);
  assert.equal(idleMutations, 0, 'an unchanged poll produces zero mutations');

  // While another view is showing, job events only move the badge.
  const hiddenWork = await evaluate(`(() => {
    document.querySelector('[data-view="chat"]').click();
    const before = document.getElementById('jobsList').innerHTML.length;
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    observer.observe(document.getElementById('jobsList'), { childList: true, subtree: true, attributes: true, characterData: true });
    applyJobUpdate({ id: 'job_hidden', sessionId: currentSessionId, kind: 'tool', toolName: 'file_write',
      title: '隐藏期间新建', status: 'running', startedAt: Date.now(), createdAt: Date.now(), outputPreview: '' });
    const badge = document.getElementById('navJobBadge');
    const result = { count, sameLength: document.getElementById('jobsList').innerHTML.length === before,
                     badgeHidden: badge.hidden, badgeText: badge.textContent, cards: document.querySelectorAll('#jobsList .job-card').length };
    observer.disconnect();
    return result;
  })()`);
  assert.equal(hiddenWork.count, 0, 'a background view is not laid out');
  assert.equal(hiddenWork.sameLength, true, 'the hidden list is left untouched');
  assert.equal(hiddenWork.badgeHidden, false, 'the badge still reflects the running job');
  // Fixture job_0 is still running, so the badge counts it plus the new one.
  assert.equal(hiddenWork.badgeText, '2');
  assert.equal(hiddenWork.cards, 12);

  // Activation paints from cache, newest first.
  const activated = await evaluate(`(() => {
    document.getElementById('view-jobs').classList.add('active');
    renderJobs();
    const cards = document.querySelectorAll('#jobsList .job-card');
    return { count: cards.length, first: cards[0].dataset.jobId,
             title: cards[0].querySelector('.job-row-title').textContent };
  })()`);
  assert.equal(activated.count, 13);
  assert.equal(activated.first, 'job_hidden');
  assert.equal(activated.title, '隐藏期间新建');

  // The switch back is a real click, so the nav wiring is exercised too.
  const afterNav = await evaluate(`(() => {
    document.querySelector('[data-view="chat"]').click();
    document.querySelector('[data-view="jobs"]').click();
    return document.querySelectorAll('#jobsList .job-card').length;
  })()`);
  assert.ok(afterNav >= 1, 'the view still renders through the nav handler');

  assert.deepEqual(exceptions, [], 'no renderer exceptions while managing jobs');
});
