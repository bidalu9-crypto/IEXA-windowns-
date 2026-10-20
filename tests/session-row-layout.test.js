// Regression guard for the session list rows.
//
// Original defect: .session-project-items was a grid with an implicit auto
// column. A session title is white-space:nowrap, so its max-content width sized
// the whole column: every row became as wide as the LONGEST title (measured
// 538px inside a 275px list) and the list clipped the overflow. The active row
// therefore looked like a rectangle with its right corners sliced off, and no
// title ever reached the ellipsis because every title box had the full
// max-content width available.
//
// The test asserts geometry, not CSS source: rows fill the list exactly, all
// rows are identical, nothing overflows horizontally, and long titles truncate
// with an ellipsis while short ones do not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

const TITLES = [
  '短标题',
  '中等长度标题',
  '待命协助 C 盘清理任务',
  '这是一个非常非常非常非常非常非常长的会话标题用于验证省略号是否生效',
];

function seedWorkspace(dir) {
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: 'sess_3',
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

test('real browser: session rows keep one width and ellipsise long titles', { skip: !browser, timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rows-'));
  process.env.IEXA_WORKSPACE = seedWorkspace(dir);
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'", 'app shell');
  await wait("document.querySelectorAll('.session-item').length === 4", 'session rows');

  const measure = () => evaluate(`(() => {
    const list = document.querySelector('.sessions-list');
    const listBox = list.getBoundingClientRect();
    const searchBox = document.querySelector('.search-box').getBoundingClientRect();
    return {
      list: { left: listBox.left, right: listBox.right, width: listBox.width, client: list.clientWidth, scroll: list.scrollWidth },
      search: { left: searchBox.left, right: searchBox.right },
      rows: [...document.querySelectorAll('.session-item')].map(row => {
        const box = row.getBoundingClientRect();
        const title = row.querySelector('.session-item-title');
        const style = getComputedStyle(title);
        return {
          text: title.textContent,
          titleAttr: title.getAttribute('title'),
          left: box.left, right: box.right, width: box.width,
          titleClient: title.clientWidth,
          titleScroll: title.scrollWidth,
          overflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
          radius: getComputedStyle(row).borderRadius,
        };
      }),
    };
  })()`);

  for (const width of [300, 240]) {
    await evaluate(`document.getElementById('sidebar').style.width = '${width}px'`);
    await new Promise(resolve => setTimeout(resolve, 400));
    const shot = await measure();
    const context = `sidebar ${width}px`;

    // 1. Every row is exactly as wide as the list's content box.
    for (const row of shot.rows) {
      assert.ok(Math.abs(row.width - shot.list.client) <= 1, `${context}: row "${row.text.slice(0, 6)}" is ${row.width}px inside a ${shot.list.client}px list`);
      assert.ok(row.right <= shot.list.right + 1, `${context}: row "${row.text.slice(0, 6)}" is clipped by the list`);
      assert.ok(row.left >= shot.list.left - 1, `${context}: row starts before the list`);
    }

    // 2. Uniform width: the widest and narrowest row agree.
    const widths = shot.rows.map(row => Math.round(row.width));
    assert.equal(new Set(widths).size, 1, `${context}: rows disagree on width (${widths.join(', ')})`);

    // 3. No horizontal overflow, so no sideways scrollbar in the session list.
    assert.equal(shot.list.scroll, shot.list.client, `${context}: session list scrolls horizontally`);

    // 4. The search field shares the rows' left and right edges.
    assert.ok(Math.abs(shot.search.left - shot.list.left) <= 1, `${context}: search box left ${shot.search.left} vs rows ${shot.list.left}`);
    assert.ok(Math.abs(shot.search.right - shot.list.right) <= 1, `${context}: search box right ${shot.search.right} vs rows ${shot.list.right}`);

    // 5. Long titles ellipsise; short ones stay intact.
    const long = shot.rows[3];
    const short = shot.rows[0];
    assert.equal(long.whiteSpace, 'nowrap', `${context}: long title wraps`);
    assert.equal(long.overflow, 'ellipsis', `${context}: long title has no ellipsis`);
    assert.ok(long.titleScroll > long.titleClient, `${context}: long title should be truncated (${long.titleScroll} > ${long.titleClient})`);
    assert.ok(short.titleScroll <= short.titleClient, `${context}: short title should not be truncated`);
    assert.equal(long.titleAttr, long.text, `${context}: truncated title must expose the full text as a tooltip`);
  }

  // 6. Hovering a truncated title glides the text; leaving restores the ellipsis.
  const marquee = await evaluate(`(() => {
    const title = [...document.querySelectorAll('.session-item-title')].find(el => el.scrollWidth > el.clientWidth + 2);
    if (!title) return null;
    title.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    return { text: title.textContent, active: title.classList.contains('is-marquee'), shift: title.style.getPropertyValue('--marquee-shift'), animation: getComputedStyle(title).animationName, overflow: getComputedStyle(title).textOverflow };
  })()`);
  assert.ok(marquee, 'a truncated title exists to marquee');
  assert.equal(marquee.active, true, 'hovering a truncated title starts the glide');
  assert.match(marquee.shift, /^-\d+px$/, 'the glide distance is measured from the overflow');
  assert.equal(marquee.animation, 'session-title-marquee');
  assert.equal(marquee.overflow, 'clip', 'the ellipsis gives way while the text moves');
  assert.equal(await evaluate(`(() => {
    const title = [...document.querySelectorAll('.session-item-title')].find(el => el.classList.contains('is-marquee'));
    title.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    return title.classList.contains('is-marquee');
  })()`), false, 'leaving the title stops the glide');

  // 7. The three row actions live behind one dots trigger.
  await evaluate("document.querySelector('.session-item-more').click(); true");
  await wait("!!document.querySelector('.session-menu')", 'session menu');
  const menu = await evaluate(`(() => {
    const el = document.querySelector('.session-menu');
    const box = el.getBoundingClientRect();
    const dots = document.querySelector('.session-item-more');
    return {
      labels: [...el.querySelectorAll('.session-menu-item span')].map(span => span.textContent),
      role: el.getAttribute('role'),
      expanded: dots.getAttribute('aria-expanded'),
      inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
      focused: document.activeElement === el.querySelector('.session-menu-item'),
    };
  })()`);
  assert.deepEqual(menu.labels, ['置顶会话', '存档会话', '删除会话']);
  assert.equal(menu.role, 'menu');
  assert.equal(menu.expanded, 'true');
  assert.equal(menu.inside, true, 'the menu stays inside the viewport');
  assert.equal(menu.focused, true, 'opening focuses the first action');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert.equal(await evaluate("!!document.querySelector('.session-menu')"), false, 'Escape closes the menu');
  assert.equal(await evaluate("document.activeElement === document.querySelector('.session-item-more')"), true, 'focus returns to the trigger');

  assert.deepEqual(exceptions, [], 'no renderer exceptions while measuring');
});
