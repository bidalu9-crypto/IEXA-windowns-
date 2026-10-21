// DeepSeek Harness puts the workspace above the composer on the new-session
// page. This runs the real app and checks that the same entry exists, that it
// hands off to the existing project picker, and that it disappears once the
// conversation starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the landing project chip lists and switches projects', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-hero-workspace-'));
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof syncHeroWorkspace === 'function' && document.getElementById('view-chat')?.classList.contains('is-welcome')");
  await new Promise((r) => setTimeout(r, 250));

  // The chip only exists while the hero is up, and it sits on the composer column.
  const base = await evaluate(`(() => {
    const wrap = document.getElementById('heroWorkspace');
    const chip = document.getElementById('heroWorkspaceChip');
    const card = document.querySelector('.chat-input-area').getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    const style = getComputedStyle(wrap);
    return {
      visible: style.display !== 'none',
      label: document.getElementById('heroWorkspaceLabel').textContent,
      state: chip.dataset.state,
      expanded: chip.getAttribute('aria-expanded'),
      hasPopup: chip.getAttribute('aria-haspopup'),
      offset: Math.round(box.left - card.left),
      gap: Math.round(card.top - box.bottom),
      height: Math.round(box.height),
    };
  })()`);
  assert.equal(base.visible, true, 'the chip is part of the landing');
  assert.equal(base.label, '打开项目文件夹');
  assert.equal(base.state, 'empty');
  assert.equal(base.expanded, 'false');
  assert.equal(base.hasPopup, 'menu');
  assert.equal(base.offset, 8, 'the chip is inset from the card edge, like the reference');
  assert.ok(base.gap >= 4 && base.gap <= 12, 'the chip sits just above the card: ' + base.gap);
  assert.ok(base.height >= 28 && base.height <= 32, 'a compact 30px control: ' + base.height);

  // Seed a few recents, then open the menu.
  await evaluate(`(() => {
    projectRecent = ['E:\\\\IEXA-WIN', 'D:\\\\projects\\\\api-panel', 'C:\\\\scratch'];
    projectRoot = 'E:\\\\IEXA-WIN'; projectName = 'IEXA-WIN';
    syncHeroWorkspace();
    document.getElementById('heroWorkspaceChip').click();
    return true;
  })()`);
  await wait("!document.getElementById('heroWorkspaceMenu').hidden");

  const menu = await evaluate(`(() => {
    const el = document.getElementById('heroWorkspaceMenu');
    const box = el.getBoundingClientRect();
    const chip = document.getElementById('heroWorkspaceChip');
    return {
      side: el.dataset.side,
      items: Array.from(el.querySelectorAll('.hero-workspace-item')).map((item) => ({
        action: item.dataset.heroAction,
        name: item.querySelector('.hero-workspace-item-name').textContent,
        current: item.dataset.current === 'true',
        role: item.getAttribute('role'),
      })),
      groups: Array.from(el.querySelectorAll('.hero-workspace-group')).map((g) => g.textContent),
      separators: el.querySelectorAll('.hero-workspace-sep').length,
      insideViewport: box.top >= 0 && box.bottom <= innerHeight,
      focused: document.activeElement?.dataset.heroAction || null,
      chipLabel: document.getElementById('heroWorkspaceLabel').textContent,
      expanded: chip.getAttribute('aria-expanded'),
    };
  })()`);
  assert.equal(menu.side, 'top', 'the menu opens away from the composer');
  assert.equal(menu.insideViewport, true);
  assert.deepEqual(menu.groups, ['最近项目']);
  assert.deepEqual(menu.items.map((item) => item.action), ['project', 'project', 'project', 'open', 'close']);
  assert.deepEqual(menu.items.map((item) => item.name), ['IEXA-WIN', 'api-panel', 'scratch', '打开项目文件夹…', '关闭项目']);
  assert.equal(menu.items[0].current, true, 'the open project is marked');
  assert.equal(menu.items.filter((item) => item.role === 'menuitem').length, 5);
  assert.equal(menu.separators, 1);
  assert.equal(menu.focused, 'project', 'focus lands on the first entry');
  assert.equal(menu.chipLabel, 'IEXA-WIN');
  assert.equal(menu.expanded, 'true');

  // Keyboard: ArrowDown moves, Escape closes and returns focus to the chip.
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(await evaluate("document.activeElement?.dataset.heroAction"), 'project',
    'ArrowDown walks to the second project');

  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await evaluate("document.getElementById('heroWorkspaceMenu').hidden"), true);
  assert.equal(await evaluate("document.activeElement?.id"), 'heroWorkspaceChip', 'focus returns to the chip');

  // Choosing a project delegates to the existing opener and repaints the chip.
  await evaluate(`(() => {
    window.__opened = null;
    window.openProjectPath = async (value) => { window.__opened = value; };
    document.getElementById('heroWorkspaceChip').click();
    return true;
  })()`);
  await wait("!document.getElementById('heroWorkspaceMenu').hidden");
  await evaluate("document.querySelector('.hero-workspace-item[data-hero-action=\"project\"][data-path=\"D:\\\\\\\\projects\\\\\\\\api-panel\"]').click(); true");
  await wait("window.__opened === 'D:\\\\projects\\\\api-panel'");
  assert.equal(await evaluate("document.getElementById('heroWorkspaceMenu').hidden"), true, 'picking closes the menu');

  // The chip is a landing affordance: the first message removes it.
  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input) === '/api/chat') {
        return new Response('event: text\ndata: {"content":"ok"}\n\nevent: done\ndata: {}\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
    chatInput.value = 'hello'; void sendMessage();
    return true;
  })()`);
  await wait("!document.getElementById('view-chat').classList.contains('is-welcome')");
  assert.equal(await evaluate("getComputedStyle(document.getElementById('heroWorkspace')).display"), 'none',
    'the project chip belongs to the hero only');
});
