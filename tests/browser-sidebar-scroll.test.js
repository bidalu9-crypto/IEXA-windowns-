// The sidebar used to be two independent scrollers: the nav had max-height 46%
// and the session list kept the rest. Expanding 「更多」 therefore ate the list's
// space instead of simply extending the column, which is worst exactly where the
// window is short (not maximised).
//
// The contract now: one scroller from the new-chat button down to the last
// session; the expanded 「更多」 list keeps a scroll window of its own, and the
// wheel only feeds it while the pointer is inside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const TITLES = Array.from({ length: 14 }, (_, index) => `会话 ${index + 1}`);

function seedWorkspace(dir) {
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: 'sess_1',
    sessions: TITLES.map((title, index) => ({
      id: `sess_${index + 1}`,
      title,
      titleSource: 'manual',
      created: now - index * 1000,
      updated: now - index * 1000,
      messageCount: 0,
      projectRoot: 'E:\\IEXA-WIN',
      projectName: 'IEXA-WIN',
      pinned: false,
    })),
  }));
  return workspace;
}

test('real browser: sidebar scrolls as one block, 更多 keeps its own window', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-sidebar-scroll-'));
  process.env.IEXA_WORKSPACE = seedWorkspace(dir);
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  const proc = spawn(browser, [
    '--headless=new',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${path.join(dir, 'profile')}`,
    'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((response) => response.json());
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 800));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  const wheel = (point, deltaY) => cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, pointerType: 'mouse',
  });
  const centerOf = (selector) => evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // 720px tall: the shape a non-maximised window has, which is where the old
  // split scroller was worst.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'");
  await wait(`document.querySelectorAll('.session-item').length === ${TITLES.length}`);

  const box = (selector) => `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const style = getComputedStyle(el);
    return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, width: el.scrollWidth, clientWidth: el.clientWidth, overflowY: style.overflowY };
  })()`;

  const shell = await evaluate(box('#sidebarScroll'));
  assert.equal(shell.overflowY, 'auto', 'the whole column is the scroller');
  assert.ok(shell.height > shell.client + 8, 'fourteen sessions overflow one scroller');
  assert.ok(shell.width <= shell.clientWidth + 1, 'no sideways overflow');

  // Nav and list are ordinary flow: neither keeps a scrollbar of its own.
  for (const selector of ['.sidebar-nav', '.sessions-list']) {
    const part = await evaluate(box(selector));
    assert.equal(part.overflowY, 'visible', `${selector} is not a second scroller`);
    assert.ok(part.height <= part.client + 1, `${selector} never scrolls internally`);
  }

  // Structure: the new-chat button and the list live in the scroller; the footer
  // stays pinned outside it.
  assert.equal(await evaluate("document.getElementById('shellNewThread').parentElement.id"), 'sidebarScroll');
  assert.equal(await evaluate("document.querySelector('.sidebar-footer').parentElement.id"), 'sidebar');

  const listBefore = (await evaluate(box('.sessions-list'))).client;

  await evaluate("document.querySelector('#sidebarMore summary').click(); true");
  await wait("document.getElementById('sidebarMore').open === true");
  await new Promise((resolve) => setTimeout(resolve, 250));

  const listAfter = (await evaluate(box('.sessions-list'))).client;
  assert.equal(listAfter, listBefore, 'expanding 更多 must not squeeze the session list');

  const panel = await evaluate(box('#sidebarMore > .sidebar-secondary'));
  assert.equal(panel.overflowY, 'auto', 'the expanded 更多 list scrolls on its own');
  assert.ok(panel.height > panel.client + 8, 'eleven destinations exceed the panel window');

  // A flex column squeezes shrinkable children the moment it overflows; the
  // new-chat button used to collapse to its text height here.
  const newThread = await evaluate("Math.round(document.getElementById('shellNewThread').getBoundingClientRect().height)");
  assert.ok(newThread >= 34, `the new-chat button collapsed to ${newThread}px`);

  // Two bars a few pixels apart are a coin toss for the pointer, so the nested
  // one is inset and the main one is wide enough to actually hit.
  const bars = await evaluate(`(() => {
    const barWidth = (el) => el.offsetWidth - el.clientWidth;
    const outer = document.getElementById('sidebarScroll');
    const nested = document.querySelector('#sidebarMore > .sidebar-secondary');
    const row = document.querySelector('.session-item');
    const o = outer.getBoundingClientRect(), p = nested.getBoundingClientRect();
    return {
      outerLeft: Math.round(o.right - barWidth(outer)),
      outerWidth: barWidth(outer),
      panelRight: Math.round(p.right),
      rowGap: Math.round(o.right - barWidth(outer) - row.getBoundingClientRect().right),
    };
  })()`);
  assert.ok(bars.outerWidth >= 9, `the sidebar bar is ${bars.outerWidth}px, too thin to grab`);
  assert.ok(bars.outerLeft - bars.panelRight >= 12,
    `the 更多 bar sits ${bars.outerLeft - bars.panelRight}px from the sidebar bar`);
  assert.ok(bars.rowGap >= 5, `rows run ${bars.rowGap}px from the scrollbar`);

  // The nested bar hangs off the summary's chevron, so the submenu reads as a
  // column under that arrow instead of a second, unrelated scrollbar.
  const alignment = await evaluate(`(() => {
    const summary = document.querySelector('#sidebarMore summary');
    const s = summary.getBoundingClientRect();
    const right = s.right - parseFloat(getComputedStyle(summary).paddingRight);
    const left = right - parseFloat(getComputedStyle(summary, '::after').width);
    const panel = document.querySelector('#sidebarMore > .sidebar-secondary');
    const p = panel.getBoundingClientRect();
    const barWidth = panel.offsetWidth - panel.clientWidth - 1;
    return { chevron: (left + right) / 2, bar: p.right - barWidth / 2 };
  })()`);
  assert.ok(Math.abs(alignment.chevron - alignment.bar) <= 2,
    `the 更多 bar centre is at ${alignment.bar}px, the chevron at ${alignment.chevron}px`);

  // Wheel inside the panel: the panel moves, the sidebar does not.
  const sidebarBefore = (await evaluate(box('#sidebarScroll'))).top;
  const panelPoint = await centerOf('#sidebarMore > .sidebar-secondary');
  await wheel(panelPoint, 180);
  await wait("document.querySelector('#sidebarMore > .sidebar-secondary').scrollTop > 0");
  assert.equal((await evaluate(box('#sidebarScroll'))).top, sidebarBefore,
    'the wheel over 更多 must not drag the whole sidebar');

  // Wheel outside it: the sidebar moves, the panel stays where it was.
  // The pointer has to sit on something that is genuinely outside the expanded
  // list — the primary nav buttons above it, not the nav's geometric centre,
  // which lands inside the panel once the panel is open.
  const panelTop = (await evaluate(box('#sidebarMore > .sidebar-secondary'))).top;
  const navPoint = await centerOf('.sidebar-primary');
  await wheel(navPoint, 240);
  await wait("document.getElementById('sidebarScroll').scrollTop > 0");
  assert.equal((await evaluate(box('#sidebarMore > .sidebar-secondary'))).top, panelTop,
    'the wheel outside 更多 must not scroll its list');
});
