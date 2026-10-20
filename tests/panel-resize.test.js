// Regression guard for the panel resizer.
//
// The drag used to write --sidebar-width on :root. That property is inherited,
// so every pointermove invalidated the style of the whole document: on a real
// 34k-node transcript a single write measured 128ms and a 240-move drag spent
// 23s in style recalculation (201 of 264 frames over 32ms).
//
// The fix is behavioural, so that is what this test asserts:
//   1. moving the pointer must not touch the :root custom property,
//   2. the transcript keeps its pre-drag width while the drag is in flight,
//   3. the width is committed and persisted exactly once, on release,
//   4. double-click and arrow keys keep working.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

test('real browser: panel drag writes stay scoped and commit once', { skip: !browser, timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-resize-'));
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
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let sequence = 0;
  const waiting = new Map();
  const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 8000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression, message) {
    for (let i = 0; i < 120; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch { /* not ready yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1175, height: 839, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop' && document.body.dataset.panelResize === 'ready'", 'app shell');

  const start = await evaluate(`(() => {
    const handle = document.getElementById('sidebarResizer');
    const box = handle.getBoundingClientRect();
    return {
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + 200),
      width: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      rootVar: document.documentElement.style.getPropertyValue('--sidebar-width'),
      stored: localStorage.getItem('iexa-sidebar-width'),
    };
  })()`);
  assert.ok(start.width >= 180, `sidebar starts inside its range: ${start.width}`);

  // 1. Press and move 40px to the right, without releasing yet.
  const mid = await evaluate(`(() => {
    const handle = document.getElementById('sidebarResizer');
    const x = ${start.x}, y = ${start.y};
    const fire = (type, clientX) => handle.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY: y,
      bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true,
    }));
    fire('pointerdown', x);
    for (let i = 1; i <= 20; i++) fire('pointermove', x + i * 2);
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      rootVar: document.documentElement.style.getPropertyValue('--sidebar-width'),
      panelVar: document.getElementById('sidebar').style.getPropertyValue('--sidebar-width'),
      inlineWidth: document.getElementById('sidebar').style.width,
      rootVarTouched: document.documentElement.style.getPropertyValue('--sidebar-width') !== ${JSON.stringify(start.rootVar)},
      shield: document.querySelectorAll('.panel-drag-shield').length,
      dragging: handle.classList.contains('is-dragging'),
      stored: localStorage.getItem('iexa-sidebar-width'),
      fire,
    }))));
  })()`);

  // 2. During the drag: the document-level property is untouched, the panel
  //    carries the live width, and nothing has been persisted yet.
  assert.equal(mid.rootVarTouched, false, 'drag must not write the inherited :root property');
  assert.equal(mid.dragging, true, 'handle should report an active drag');
  assert.equal(mid.shield, 1, 'drag shield keeps the resize cursor over the UI');
  assert.ok(mid.sidebar > start.width, `live width follows the pointer (${start.width} -> ${mid.sidebar})`);
  assert.equal(mid.inlineWidth, `${mid.sidebar}px`, 'live width is written on the panel itself');
  assert.equal(mid.stored, start.stored, 'nothing is persisted mid-drag');

  // 3. Release: one commit, persisted.
  const end = await evaluate(`(() => {
    const handle = document.getElementById('sidebarResizer');
    handle.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, button: 0, buttons: 0, clientX: ${start.x + 40}, clientY: ${start.y},
      bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true,
    }));
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      rootVar: document.documentElement.style.getPropertyValue('--sidebar-width'),
      panelVar: document.getElementById('sidebar').style.getPropertyValue('--sidebar-width'),
      inlineWidth: document.getElementById('sidebar').style.width,
      dragging: handle.classList.contains('is-dragging'),
      shieldHidden: document.querySelector('.panel-drag-shield')?.hidden !== false,
      stored: localStorage.getItem('iexa-sidebar-width'),
    }))));
  })()`);

  assert.equal(end.dragging, false, 'drag state is cleared');
  assert.equal(end.shieldHidden, true, 'drag shield is hidden after release');
  assert.equal(end.inlineWidth, '', 'inline width is dropped in favour of the custom property');
  assert.equal(end.panelVar, `${end.sidebar}px`, 'final width is committed on the panel');
  assert.equal(end.rootVar, start.rootVar, 'the :root fallback stays as it was, so inheritance never repaints the document');
  assert.equal(end.stored, String(end.sidebar), 'final width is persisted once');

  // 4. Double-click restores the default; ArrowRight nudges by 16.
  const interactions = await evaluate(`(() => {
    const handle = document.getElementById('sidebarResizer');
    const read = () => Math.round(document.getElementById('sidebar').getBoundingClientRect().width);
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const afterReset = read();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const afterArrow = read();
    return { afterReset, afterArrow };
  })()`);
  assert.equal(interactions.afterReset, 240, 'double-click restores the default width');
  assert.equal(interactions.afterArrow, 256, 'arrow key nudges by 16px');

  // 5. The width has to survive a reload, which means currentAppearance() must
  //    read the panel-scoped property (the :root one is now only a fallback).
  const persisted = await evaluate(`(async () => {
    const handle = document.getElementById('sidebarResizer');
    for (let i = 0; i < 10; i++) handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const width = Math.round(document.getElementById('sidebar').getBoundingClientRect().width);
    await new Promise(resolve => setTimeout(resolve, 500));
    const response = await fetch('/api/appearance', { cache: 'no-store' });
    const value = await response.json();
    return { width, saved: value.sidebarWidth };
  })()`);
  assert.equal(persisted.saved, persisted.width, `server stores the committed width (${persisted.saved} vs ${persisted.width})`);

  await cdp('Page.reload', { ignoreCache: false });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop' && document.getElementById('sidebar')", 'app shell after reload');
  await new Promise(resolve => setTimeout(resolve, 600));
  const restored = await evaluate(`(() => {
    const width = Math.round(document.getElementById('sidebar').getBoundingClientRect().width);
    return width;
  })()`);
  assert.equal(restored, persisted.width, 'width is restored after reload');

  // One divider per boundary: the panels own no side border and the resizer
  // draws the only hairline, so the two lines in the old layout cannot return.
  // The hairline must also sit on the seam itself: a gutter that pushed the
  // panels apart left a 4px strip of background between the grey sidebar and
  // its line, which reads as a misaligned divider.
  const dividers = await evaluate(`(() => {
    const px = (el, side) => getComputedStyle(el)[side];
    const hairline = (el) => { const s = getComputedStyle(el, '::before'); return [s.width, s.left]; };
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const sidebar = box('sidebar'), chat = document.querySelector('.chat-container').getBoundingClientRect();
    const files = box('filesPanel');
    const leftResizer = box('sidebarResizer'), rightResizer = box('filesResizer');
    return {
      sidebar: px(document.getElementById('sidebar'), 'borderRightWidth'),
      chat: px(document.querySelector('.chat-container'), 'borderRightWidth'),
      files: px(document.getElementById('filesPanel'), 'borderLeftWidth'),
      leftLine: hairline(document.getElementById('sidebarResizer')),
      rightLine: hairline(document.getElementById('filesResizer')),
      panelsAdjacent: Math.round(sidebar.right) === Math.round(chat.left),
      leftSeam: [Math.round(sidebar.right), Math.round(leftResizer.left + 4), Math.round(chat.left)],
      rightSeam: [Math.round(chat.right), Math.round(rightResizer.left + 4), Math.round(files.left)],
    };
  })()`);
  assert.equal(dividers.sidebar, '0px', 'sidebar draws no side border');
  assert.equal(dividers.chat, '0px', 'chat draws no side border');
  assert.equal(dividers.files, '0px', 'files panel draws no side border');
  assert.deepEqual(dividers.leftLine, ['1px', '4px'], 'one hairline at the left boundary');
  assert.deepEqual(dividers.rightLine, ['1px', '4px'], 'one hairline at the right boundary');
  assert.equal(dividers.panelsAdjacent, true, 'no gutter between the panels');
  // Sidebar edge, hairline and chat edge must all land on the same pixel; a
  // gutter between them is what made the left divider look detached.
  assert.equal(new Set(dividers.leftSeam).size, 1, `left divider sits on the seam: ${dividers.leftSeam}`);
  assert.equal(new Set(dividers.rightSeam).size, 1, `right divider sits on the seam: ${dividers.rightSeam}`);

  assert.deepEqual(exceptions, [], 'no renderer exceptions during the drag');
});
