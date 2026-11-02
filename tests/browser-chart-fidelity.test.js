// A chart must read like the reference visuals: a line whose value axis fits the
// data instead of being pinned to zero, no ruled axis edges, a ring per
// measurement, every category labelled when it fits, units on the axis.
//
// One browser test per file: `dist/main/server` resolves its workspace at import
// time, so a second test in the same process would reuse the first one's deleted
// directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const LINE = {
  type: 'line', title: '油价变化趋势', note: '演示数据，并非真实历史油价',
  categories: ['7月', '8月', '9月', '10月', '11月'], unit: '元',
  series: [{ name: '92号汽油', values: [8.1, 8.3, 8.2, 8.6, 8.91] }],
};

const BAR = {
  type: 'bar', title: '不同型号汽油价格', categories: ['89号', '92号', '95号'], unit: '元',
  series: [{ name: '价格', values: [8.27, 8.91, 9.65] }],
};

test('real browser: a line chart fits its data and reads like the reference', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-fidelity-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({ sessions: [] }));
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  let socket;
  let page;
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (page) await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* lock */ }
  });

  page = await launchPage();
  socket = page.socket;

  let sequence = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000);
    waiting.set(id, { resolve, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 240));
    return result.result?.result?.value;
  };
  const wait = async (expression) => {
    for (let index = 0; index < 200; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof addMessage === 'function' && typeof renderMarkdownContent === 'function' && currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 700));

  // Each render appends a message, so always read the newest card.
  const render = (spec) => evaluate(`(async () => {
    const message = addMessage('assistant', '', undefined, { streaming: false });
    const body = message.querySelector('.message-content');
    body._renderedMarkdownSource = null;
    renderMarkdownContent(body, '\`\`\`chart\\n' + JSON.stringify(${JSON.stringify(spec)}) + '\\n\`\`\`', true);
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => requestAnimationFrame(() => r()));
    return document.querySelectorAll('.chart-card').length;
  })()`);

  await render(LINE);
  const line = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.chart-card')].pop();
    const labels = [...card.querySelectorAll('.chart-axis-label')].map((n) => n.textContent);
    const points = [...card.querySelectorAll('.chart-point')];
    const style = points[0] ? getComputedStyle(points[0]) : null;
    return {
      axisLines: card.querySelectorAll('.chart-axis').length,
      ticks: labels.filter((value) => /元$/.test(value)),
      cats: labels.filter((value) => /月$/.test(value)),
      pointCount: points.length,
      pointFill: style ? style.fill : null,
      pointStroke: style ? style.strokeWidth : null,
      gridDash: getComputedStyle(card.querySelector('.chart-grid')).strokeDasharray,
    };
  })()`);

  // The whole point of the fix: 8.1–8.91 must not be drawn against a zero axis.
  assert.equal(line.ticks.includes('0元'), false, 'the value axis starts at the data: ' + line.ticks.join(','));
  assert.match(line.ticks[0], /^8/, 'the first tick sits inside the data range: ' + line.ticks[0]);
  assert.ok(line.ticks.length >= 4, 'the axis keeps enough ticks: ' + line.ticks.join(','));
  for (const tick of line.ticks) assert.match(tick, /元$/, 'every tick carries its unit: ' + tick);
  assert.equal(line.axisLines, 0, 'no ruled axis edges');
  assert.notEqual(line.gridDash, 'none', 'gridlines stay dashed');
  assert.equal(line.pointCount, LINE.series[0].values.length, 'one ring per measurement');
  assert.equal(line.pointStroke, '2px', 'rings, not solid discs');
  assert.deepEqual(line.cats, LINE.categories, 'every category is labelled when it fits');

  // A bar encodes magnitude, so its zero baseline is correct and must survive.
  await render(BAR);
  const bar = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.chart-card')].pop();
    return [...card.querySelectorAll('.chart-axis-label')].map((n) => n.textContent).filter((v) => /元$/.test(v));
  })()`);
  assert.equal(bar.includes('0元'), true, 'a bar chart keeps its zero baseline: ' + bar.join(','));
});
