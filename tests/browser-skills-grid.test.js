// The skills page used to stack four full-width buttons under a three-line
// description, one skill per row. These assertions pin the replacement: a
// multi-column grid of ~100px cards, a working filter/sort toolbar, and the
// switch + icon actions that replaced the button column.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

const now = Date.now();
const seeds = [
  { id: 'alpha', name: 'Alpha 检索', description: '本地代码检索与正则匹配，搜索仓库里的符号、日志和配置。', useCount: 5, enabled: true, systemPrompt: true, updatedAt: now - 6 * 60000 },
  { id: 'beta', name: 'Beta 下载', description: '解析链接并下载媒体文件，支持分片与断点续传。', useCount: 42, enabled: true, systemPrompt: false, updatedAt: now - 5 * 60000 },
  { id: 'delta', name: 'Delta 转码', description: '把视频转成 H.264 / AAC，统一分辨率与码率。', useCount: 12, enabled: true, systemPrompt: false, updatedAt: now - 4 * 60000 },
  { id: 'epsilon', name: 'Epsilon 归档', description: '打包并归档旧项目，生成校验清单。', useCount: 7, enabled: false, systemPrompt: false, updatedAt: now - 3 * 60000 },
  { id: 'gamma', name: 'Gamma 文档', description: '按模板生成 Markdown 文档并同步到仓库。', useCount: 0, enabled: false, systemPrompt: false, updatedAt: now - 2 * 60000 },
  { id: 'zeta', name: 'Zeta 解析', description: '解析结构化文本与表格，输出 JSON。', useCount: 30, enabled: true, systemPrompt: false, updatedAt: now - 1 * 60000 },
];

test('real browser: skills render as a compact sortable grid', { skip: !browser, timeout: 150000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-skills-grid-'));
  const workspace = path.join(dir, 'workspace');
  process.env.IEXA_WORKSPACE = workspace;
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  for (const seed of seeds) {
    const skillDir = path.join(workspace, 'skills', seed.id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${seed.name}`,
      `description: ${seed.description}`,
      'version: 1.2.0',
      '---',
      '',
      `# ${seed.name}`,
      '',
      'Fixture body.',
      '',
    ].join('\n'));
  }
  fs.writeFileSync(path.join(workspace, '.iexa-skills.json'), JSON.stringify({
    skills: seeds.map(seed => ({
      id: seed.id, name: seed.name, description: seed.description, version: '1.2.0',
      source: 'session', enabled: seed.enabled, installedAt: now - 86400000,
      updatedAt: seed.updatedAt, useCount: seed.useCount, systemPrompt: seed.systemPrompt,
    })),
  }));

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
    const timer = setTimeout(() => reject(new Error('browser startup timeout')), 15000);
    proc.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 20000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 600));
    return result.result?.result?.value;
  }
  async function wait(expression, message) {
    for (let i = 0; i < 240; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch { /* transient during navigation */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }
  const cardIds = () => evaluate("[...document.querySelectorAll('#skillList .skill-card')].map(card => card.dataset.id)");

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1512, height: 978, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'", 'app shell');
  await evaluate("document.querySelector('.nav-btn[data-view=\"skills\"]').click()");
  await wait("document.getElementById('view-skills')?.classList.contains('active')", 'skills view');
  await wait("document.querySelectorAll('#skillList .skill-card').length === 6", 'six cards');

  // Geometry: several cards per row, each about the height of a token-usage
  // card, and the three actions on one horizontal line.
  const layout = await evaluate(`(() => {
    const list = document.getElementById('skillList');
    const cards = [...list.querySelectorAll('.skill-card')];
    const heights = cards.map(card => Math.round(card.getBoundingClientRect().height));
    const actionTops = [...cards[0].querySelectorAll('.skill-card-actions button')]
      .map(button => Math.round(button.getBoundingClientRect().top));
    return {
      columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
      listWidth: Math.round(list.getBoundingClientRect().width),
      heights,
      actionTops,
      legacyButtons: list.querySelectorAll('.btn-secondary').length,
      gridDisplay: getComputedStyle(list).display,
    };
  })()`);
  assert.ok(layout.columns >= 3, `three compact cards per row: ${JSON.stringify(layout)}`);
  assert.equal(layout.gridDisplay, 'grid');
  assert.ok(Math.max(...layout.heights) <= 130, `each card stays near 100px: ${JSON.stringify(layout.heights)}`);
  assert.equal(new Set(layout.actionTops).size, 1, 'actions sit on one row, not stacked');
  assert.equal(layout.legacyButtons, 0, 'no full-width button column remains');

  assert.deepEqual(await cardIds(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta'], 'default sort is by name');

  // Sorting by usage reorders without a reload.
  await evaluate(`(() => {
    const select = document.getElementById('skillSort');
    select.value = 'usage';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.deepEqual(await cardIds(), ['beta', 'zeta', 'delta', 'epsilon', 'alpha', 'gamma'], 'usage sort');

  // Filter chips narrow the grid; counts stay global.
  await evaluate("document.querySelector('[data-skill-filter=\"disabled\"]').click()");
  assert.deepEqual((await cardIds()).sort(), ['epsilon', 'gamma']);
  const counts = await evaluate(`(() => {
    document.querySelector('[data-skill-filter="all"]').click();
    return Object.fromEntries([...document.querySelectorAll('[data-skill-count]')]
      .map(node => [node.dataset.skillCount, node.textContent]));
  })()`);
  assert.deepEqual(counts, { all: '6', enabled: '4', disabled: '2', system: '1' });
  assert.equal((await cardIds()).length, 6);

  // The switch replaces the 禁用/启用 button and persists to the store.
  await evaluate("document.querySelector('#skillList .skill-card[data-id=\"alpha\"] .skill-switch').click()");
  await wait("document.querySelector('#skillList .skill-card[data-id=\"alpha\"] .skill-switch')?.getAttribute('aria-checked') === 'false'", 'alpha disabled');
  const storedDisabled = await evaluate("fetch('/api/skills').then(r => r.json()).then(d => d.skills.find(s => s.id === 'alpha').enabled)");
  assert.equal(storedDisabled, false);

  // The pin action toggles system-prompt membership and keeps its state visible.
  await evaluate("document.querySelector('#skillList .skill-card[data-id=\"beta\"] [data-act=\"sysprompt\"]').click()");
  await wait("document.querySelector('#skillList .skill-card[data-id=\"beta\"] [data-act=\"sysprompt\"]')?.getAttribute('aria-pressed') === 'true'", 'beta pinned');
  const storedPinned = await evaluate("fetch('/api/skills').then(r => r.json()).then(d => d.skills.find(s => s.id === 'beta').systemPrompt)");
  assert.equal(storedPinned, true);
  const pins = await evaluate(`(() => ({
    pinned: document.querySelector('.skill-card[data-id="beta"] [data-act="sysprompt"]').classList.contains('is-on'),
    alphaCardDisabled: document.querySelector('.skill-card[data-id="alpha"]').classList.contains('is-disabled'),
  }))()`);
  assert.deepEqual(pins, { pinned: true, alphaCardDisabled: true });

  assert.deepEqual(exceptions, [], 'no renderer exceptions while using the skills page');
});
