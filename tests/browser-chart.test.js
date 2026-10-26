// Charts are model-generated data rendered as SVG. This pins the whole path:
// markdown → chart card, hover, table view, failure fallback, and the fact that
// nothing here needs the sanitizer to be relaxed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const chartBlock = (spec) => '```chart\n' + JSON.stringify(spec, null, 2) + '\n```';

const lineSpec = {
  type: 'line',
  title: '接口响应时间',
  xLabel: '并发',
  yLabel: '毫秒',
  unit: 'ms',
  categories: ['10', '50', '100', '200'],
  series: [
    { name: 'p50', values: [12, 18, 26, 41] },
    { name: 'p99', values: [40, 70, 130, 260] },
  ],
  note: '数据来自压测脚本',
};

const barSpec = {
  type: 'bar',
  title: '各模块耗时',
  categories: ['解析', '校验', '写盘'],
  series: [{ name: '耗时', values: [12, 5, 30] }],
};

test('real browser: a chart block becomes an interactive card', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-chart-ui-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_chart_ui';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '图表', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  const body = [
    '先看折线图：',
    '',
    chartBlock(lineSpec),
    '',
    '再看柱状图：',
    '',
    chartBlock(barSpec),
    '',
    '下面这个类型不支持，应当保留原文：',
    '',
    chartBlock({ type: 'pie', title: '坏图', categories: ['a'], series: [{ name: 'x', values: [1] }] }),
    '',
    '普通代码块不受影响：',
    '',
    '```js\nconst a = 1;\n```',
  ].join('\n');
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '画个图', timestamp: at },
    { role: 'assistant', content: body, status: 'done', timestamp: at + 2000 },
  ]));
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
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* locked */ }
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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000);
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
    for (let index = 0; index < 140; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId === '" + sessionId + "'");
  await wait("document.querySelectorAll('.chart-card').length === 2");

  // Two cards, and the invalid one left its source readable.
  const shape = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.chart-card')];
    return {
      cards: cards.length,
      types: cards.map((card) => card.dataset.chartType),
      titles: cards.map((card) => card.querySelector('.chart-title').textContent),
      svgs: cards.map((card) => card.querySelectorAll('svg.chart-svg').length),
      lines: cards.map((card) => card.querySelectorAll('.chart-line').length),
      bars: cards.map((card) => card.querySelectorAll('.chart-bar').length),
      legends: cards.map((card) => card.querySelectorAll('.chart-legend-item').length),
      // A rendered chart must not leave its raw code block behind.
      leftoverChartCode: document.querySelectorAll('pre code.language-chart').length,
      errors: [...document.querySelectorAll('.chart-error')].map((node) => node.textContent),
      jsBlocks: document.querySelectorAll('pre code.language-js').length,
    };
  })()`);
  assert.equal(shape.cards, 2);
  assert.deepEqual(shape.types, ['line', 'bar']);
  assert.deepEqual(shape.titles, ['接口响应时间', '各模块耗时']);
  assert.deepEqual(shape.svgs, [1, 1]);
  assert.equal(shape.lines[0], 2, 'one polyline per series');
  assert.equal(shape.bars[1], 3, 'one bar per category');
  assert.deepEqual(shape.legends, [2, 0], 'only multi-series charts get a legend');
  assert.equal(shape.leftoverChartCode, 1, 'only the invalid chart keeps its source');
  assert.equal(shape.errors.length, 1);
  assert.match(shape.errors[0], /图表无法显示/);
  assert.match(shape.errors[0], /不支持的图表类型/);
  assert.equal(shape.jsBlocks, 1, 'ordinary code blocks are untouched');

  // Table view: real values, and the SVG is hidden while it shows.
  await evaluate("document.querySelector('.chart-card .chart-toggle').click(); true");
  await wait("document.querySelector('.chart-card .chart-table') !== null");
  const table = await evaluate(`(() => {
    const card = document.querySelector('.chart-card');
    const rows = [...card.querySelectorAll('.chart-table tbody tr')].map((tr) => [...tr.children].map((cell) => cell.textContent));
    return {
      head: [...card.querySelectorAll('.chart-table thead th')].map((th) => th.textContent),
      rows,
      bodyHidden: card.querySelector('.chart-body').hidden,
      label: card.querySelector('.chart-toggle').textContent,
      pressed: card.querySelector('.chart-toggle').getAttribute('aria-pressed'),
    };
  })()`);
  assert.deepEqual(table.head, ['并发', 'p50', 'p99']);
  assert.deepEqual(table.rows[0], ['10', '12 ms', '40 ms']);
  assert.equal(table.bodyHidden, true);
  assert.equal(table.label, '图表');
  assert.equal(table.pressed, 'true');

  // Back to the chart, then hover a point for the tooltip.
  await evaluate("document.querySelector('.chart-card .chart-toggle').click(); true");
  await wait("document.querySelector('.chart-card .chart-body').hidden === false");
  const hovered = await evaluate(`(() => {
    const card = document.querySelector('.chart-card');
    const svg = card.querySelector('svg.chart-svg');
    const box = svg.getBoundingClientRect();
    const hit = svg.querySelector('rect[fill="transparent"]');
    const hitBox = hit.getBoundingClientRect();
    const target = { clientX: hitBox.left + hitBox.width * 0.62, clientY: hitBox.top + hitBox.height / 2 };
    hit.dispatchEvent(new PointerEvent('pointermove', { ...target, bubbles: true }));
    const tip = card.querySelector('.chart-tooltip');
    return {
      visible: !tip.hidden,
      head: tip.querySelector('.chart-tooltip-head')?.textContent || '',
      rows: [...tip.querySelectorAll('.chart-tooltip-row')].map((row) => row.textContent),
      guide: svg.querySelector('.chart-guide').getAttribute('visibility'),
      boxWidth: Math.round(box.width),
    };
  })()`);
  assert.equal(hovered.visible, true, 'the tooltip appears on hover');
  assert.equal(hovered.head, '100');
  assert.equal(hovered.rows.length, 2);
  assert.match(hovered.rows[0], /p50/);
  assert.match(hovered.rows[0], /26 ms/);
  assert.equal(hovered.guide, 'visible');
  assert.ok(hovered.boxWidth > 200, 'the chart has real width: ' + hovered.boxWidth);

  // Theme switch keeps the chart, and the palette follows the theme tokens.
  const before = await evaluate("getComputedStyle(document.querySelector('.chart-card')).getPropertyValue('--chart-c2').trim()");
  await evaluate("document.documentElement.dataset.theme = 'dark'; true");
  await new Promise((r) => setTimeout(r, 300));
  const after = await evaluate("getComputedStyle(document.querySelector('.chart-card')).getPropertyValue('--chart-c2').trim()");
  assert.notEqual(after, before, 'the series palette changes with the theme');
  assert.equal(await evaluate("document.querySelectorAll('.chart-card').length"), 2, 'no chart is lost on a theme switch');

  // Re-rendering the same message must not duplicate cards.
  await evaluate(`(() => {
    const el = document.querySelectorAll('.message.assistant .message-content')[0];
    window.IexaChart.enhance(el);
    window.IexaChart.enhance(el);
    return true;
  })()`);
  assert.equal(await evaluate("document.querySelectorAll('.chart-card').length"), 2, 'enhance is idempotent');

  // A narrow window re-draws rather than clipping.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 600));
  const narrow = await evaluate(`(() => {
    const svg = document.querySelector('.chart-card svg.chart-svg');
    const card = document.querySelector('.chart-card');
    return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, width: Math.round(svg.getBoundingClientRect().width) };
  })()`);
  assert.equal(narrow.overflow, false, 'the chart does not force horizontal scrolling');
  assert.ok(narrow.width > 200, 'the chart still has usable width: ' + narrow.width);
});
