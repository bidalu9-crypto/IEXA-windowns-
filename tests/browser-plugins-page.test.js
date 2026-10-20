// The plugin page is the only place a user can see what an extension can do:
// its manifest version, its tools, its panels, and why it failed to load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

function seedPlugin(root, id, manifest, state) {
  const dir = path.join(root, '.iexa-plugins', id);
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'iexa-plugin.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), 'process.stdout.write(JSON.stringify({ output: "ok", success: true }));');
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<!doctype html><meta charset="utf-8"><body>ok</body>');
  return { dir, state };
}

test('real browser: plugin cards explain compatibility, tools and panels', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-plugins-page-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  seedPlugin(workspace, 'hello-dashboard', {
    apiVersion: 2,
    id: 'hello-dashboard',
    name: 'Hello Dashboard',
    version: '1.0.0',
    description: '可视化问候面板，并向 AI 提供生成问候语和保存便签的工具。',
    author: 'IEXA',
    main: 'index.js',
    ui: 'ui/index.html',
    contributions: { panels: [{ id: 'main', title: 'Dashboard', entry: 'ui/index.html' }] },
    tools: [
      { name: 'greet', description: '根据姓名生成一条问候语。', parameters: { name: { type: 'string' } }, required: ['name'] },
      { name: 'save_note', description: '将一条便签保存到插件独立数据目录。', parameters: { text: { type: 'string' }, pinned: { type: 'boolean' } } },
    ],
  });
  seedPlugin(workspace, 'broken-plugin', {
    apiVersion: 2,
    id: 'broken-plugin',
    name: 'Broken Plugin',
    version: '1.0',
    description: '',
    main: 'index.js',
    tools: [],
  });
  fs.writeFileSync(path.join(workspace, '.iexa-plugin-state.json'), JSON.stringify({
    plugins: { 'hello-dashboard': { enabled: true, installedAt: Date.now() }, 'broken-plugin': { enabled: false, installedAt: Date.now() } },
  }));

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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await evaluate("document.querySelector('.nav-btn[data-view=\"plugins\"]').click(); true");
  await wait("document.querySelectorAll('.plugin-card').length === 2");

  const summary = await evaluate(`Array.from(document.querySelectorAll('.plugin-stat')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim())`);
  assert.deepEqual(summary, ['2已安装', '1已启用', '2可用工具', '1可视化面板']);

  const healthy = await evaluate(`(() => {
    const card = document.querySelector('.plugin-card[data-plugin-id="hello-dashboard"]');
    return {
      version: card.querySelector('.plugin-version').textContent,
      compat: card.querySelector('.plugin-compat').textContent,
      tools: Array.from(card.querySelectorAll('.plugin-tool-row b')).map((el) => el.textContent),
      params: Array.from(card.querySelectorAll('.plugin-tool-schema')).map((el) => el.textContent),
      panels: Array.from(card.querySelectorAll('.plugin-panel-chip')).map((el) => el.textContent.trim()),
      caps: Array.from(card.querySelectorAll('.plugin-cap')).map((el) => el.textContent.trim()),
      note: card.querySelector('.plugin-foot-note').textContent.trim(),
    };
  })()`);
  assert.equal(healthy.version, 'v1.0.0');
  assert.equal(healthy.compat, '清单 v2');
  assert.deepEqual(healthy.tools, ['greet', 'save_note']);
  assert.deepEqual(healthy.params, ['1 参数', '2 参数']);
  assert.deepEqual(healthy.panels, ['Dashboard']);
  assert.deepEqual(healthy.caps, ['2 个工具', '1 个面板', '独立数据目录']);
  assert.match(healthy.note, /生效/);

  // Small informational text must clear AA, not just look quiet.
  const contrast = await evaluate(`(() => {
    const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = ([r, g, b]) => {
      const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const card = document.querySelector('.plugin-card[data-plugin-id="hello-dashboard"]');
    const bg = parse(getComputedStyle(card).backgroundColor);
    return {
      description: ratio(parse(getComputedStyle(card.querySelector('.plugin-tool-text small')).color), bg),
      footer: ratio(parse(getComputedStyle(card.querySelector('.plugin-foot-note')).color), bg),
      schema: ratio(parse(getComputedStyle(card.querySelector('.plugin-tool-schema')).color), bg),
    };
  })()`);
  for (const [key, value] of Object.entries(contrast)) assert.ok(value >= 4.5, `${key} contrast ${value.toFixed(2)} must clear AA`);

  const broken = await evaluate(`(() => {
    const card = document.querySelector('.plugin-card[data-plugin-id="broken-plugin"]');
    return {
      compat: card.querySelector('.plugin-compat').textContent,
      error: card.querySelector('.plugin-error')?.textContent.trim(),
      tools: card.querySelectorAll('.plugin-tool-row').length,
      toggleDisabled: card.querySelector('[data-plugin-enable]').disabled,
      caps: card.querySelectorAll('.plugin-cap').length,
      version: card.querySelector('.plugin-version')?.textContent || null,
    };
  })()`);
  assert.equal(broken.compat, '清单异常');
  assert.match(broken.error, /SemVer/);
  assert.equal(broken.tools, 0);
  assert.equal(broken.toggleDisabled, true);
  assert.equal(broken.caps, 0, 'an unreadable manifest must not claim capabilities it cannot verify');
  assert.equal(broken.version, null, 'an unreadable manifest has no version to show');

  // The console is a result surface; it stays out of the way until there is one.
  assert.equal(await evaluate("document.getElementById('pluginConsole').hidden"), true);
  await evaluate("setPluginOutput('greet → { greeting: \"hi\" }'); true");
  assert.equal(await evaluate("document.getElementById('pluginConsole').hidden"), false);
  await evaluate("document.getElementById('pluginConsoleClear').click(); true");
  assert.equal(await evaluate("document.getElementById('pluginConsole').hidden"), true);

  // Toggling must not replay the entrance animation or drop keyboard focus.
  await evaluate(`(() => {
    const card = document.querySelector('.plugin-card[data-plugin-id="hello-dashboard"]');
    card.querySelector('[data-plugin-enable]').focus();
    card.querySelector('[data-plugin-enable]').click();
    return true;
  })()`);
  await wait("document.querySelector('.plugin-card[data-plugin-id=\"hello-dashboard\"] .plugin-foot-note').textContent.includes('启用后')");
  assert.equal(await evaluate("document.querySelector('.plugin-card[data-plugin-id=\"hello-dashboard\"] [data-plugin-enable]').checked"), false);
  assert.equal(await evaluate("document.activeElement?.matches('.plugin-card[data-plugin-id=\"hello-dashboard\"] [data-plugin-enable]')"), true,
    'focus returns to the switch after the list repaints');
  assert.equal(await evaluate("!!document.querySelector('.plugin-list') && document.querySelector('.plugin-list').getAnimations().length === 0"), true);
  assert.equal(await evaluate("!!document.querySelector('.plugin-card[data-plugin-id=\"hello-dashboard\"]') && document.querySelector('.plugin-card[data-plugin-id=\"hello-dashboard\"]').getAnimations().length === 0"), true,
    'a toggle must not replay the entrance animation');
  assert.equal(await evaluate("document.querySelectorAll('.plugin-tool-row:disabled').length"), 2, 'disabled plugins keep their tools visible but inert');

  // Restore, then check the narrow layout does not overflow.
  await evaluate("document.querySelector('.plugin-card[data-plugin-id=\"hello-dashboard\"] [data-plugin-enable]').click(); true");
  await wait("document.querySelector('.plugin-card[data-plugin-id=\"hello-dashboard\"] .plugin-foot-note').textContent.includes('生效')");
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(await evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.plugin-tool-schema')).display"), 'none', 'the parameter chip gives way on a phone');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.plugin-sandbox-note')).display"), 'none');
});
