// Typing must filter without pressing Enter, and a late response for an older
// query must not replace a newer one.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const test = require('node:test');
const assert = require('node:assert/strict');

test('real browser: session search filters while typing and never clips its ring', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-search-ui-'));
  const workspace = path.join(dir, 'workspace');
  const now = Date.now();
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  const sessions = [
    { id: 's-ios', title: 'iOS 项目工作区待办', created: now - 60000, updated: now - 60000 },
    { id: 's-web', title: '网页登录页改造', created: now - 120000, updated: now - 120000 },
    { id: 's-doc', title: '整理 README 说明', created: now - 180000, updated: now - 180000 },
  ];
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: sessions.map((s) => ({ ...s, titleSource: 'message', messageCount: 2, projectRoot: '', projectName: '无项目' })),
  }), 'utf8');
  for (const session of sessions) {
    fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${session.id}.json`), JSON.stringify([
      { role: 'user', content: `请处理 ${session.title} 相关的事情`, timestamp: session.created },
      { role: 'assistant', content: '好的，我来看一下。', timestamp: session.created + 1000 },
    ]), 'utf8');
  }
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
    for (let index = 0; index < 120; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.querySelectorAll('.session-item').length === 3");

  // 1. Typing alone must produce results; no Enter.
  await evaluate(`(() => {
    const input = document.getElementById('searchInput');
    input.focus();
    input.value = 'iOS';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait("getComputedStyle(document.getElementById('searchResults')).display === 'block'");
  const typed = await evaluate(`({
    items: document.querySelectorAll('.search-result-item').length,
    title: document.querySelector('.search-result-title')?.textContent,
    listHidden: getComputedStyle(document.getElementById('sessionsList')).display === 'none',
    clear: getComputedStyle(document.getElementById('searchClear')).display,
  })`);
  assert.equal(typed.items, 1, 'only the iOS session matches');
  assert.match(typed.title, /iOS/);
  assert.equal(typed.listHidden, true, 'the list gives way to results');
  assert.equal(typed.clear, 'flex', 'the clear button appears with text');

  // 2. A stale answer must not overwrite a newer query.
  await evaluate(`(() => {
    const input = document.getElementById('searchInput');
    input.value = 'README';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait("document.querySelector('.search-result-title')?.textContent?.includes('README')");
  assert.equal(await evaluate("document.querySelectorAll('.search-result-item').length"), 1);

  // 3. Clearing restores the list.
  await evaluate("document.getElementById('searchClear').click(); true");
  await wait("getComputedStyle(document.getElementById('sessionsList')).display !== 'none'");
  assert.equal(await evaluate("document.getElementById('searchInput').value"), '');

  // 4. The focus ring stays inside the clip box on both sides. Focus through a
  //    real click, because :focus-visible only matches for user interaction.
  const center = await evaluate("(() => { const r = document.getElementById('searchInput').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x: center.x, y: center.y, button: 'left', clickCount: 1 });
  }
  await wait("document.getElementById('searchInput').matches(':focus-visible')");
  const ring = await evaluate(`(() => {
    const input = document.getElementById('searchInput');
    const style = getComputedStyle(input);
    const box = input.getBoundingClientRect();
    const clip = document.getElementById('sessionsList').parentElement.getBoundingClientRect();
    return {
      width: parseFloat(style.outlineWidth),
      offset: parseFloat(style.outlineOffset),
      reachLeft: Math.round(box.left - (parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))),
      reachRight: Math.round(box.right + (parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))),
      clipLeft: Math.round(clip.left),
      clipRight: Math.round(clip.right),
    };
  })()`);
  assert.ok(ring.offset <= 0, 'the ring is drawn inside: offset ' + ring.offset);
  assert.ok(ring.reachLeft >= ring.clipLeft, `left edge is not clipped (${ring.reachLeft} >= ${ring.clipLeft})`);
  assert.ok(ring.reachRight <= ring.clipRight, `right edge is not clipped (${ring.reachRight} <= ${ring.clipRight})`);
});
