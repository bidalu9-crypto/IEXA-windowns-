// A pie is geometry, not a plot: it must have slices, a centre total and a
// legend, and it must NOT have axes or a grid. The same test then streams the
// block in fragments to prove the ring appears as its fence closes, not at
// finalize. Both halves share one server so the temp workspace is created and
// torn down once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const PIE = {
  type: 'pie',
  title: '流量来源',
  unit: '次',
  categories: ['直接访问', '搜索引擎', '社交媒体', '外部链接'],
  series: [{ name: '访问量', values: [4820, 3150, 1740, 890] }],
};

test('real browser: a pie is a ring with a legend, and it streams in', { skip: !browser, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-pie-'));
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
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* windows lock */ }
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 240));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 200; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof addMessage === 'function' && typeof renderMarkdownContent === 'function' && currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 700));

  // ---- 1. final render -----------------------------------------------------
  const painted = await evaluate(`(async () => {
    const message = addMessage('assistant', '', undefined, { streaming: false });
    const body = message.querySelector('.message-content');
    const src = '\`\`\`chart\\n' + JSON.stringify(${JSON.stringify(PIE)}) + '\\n\`\`\`';
    body._renderedMarkdownSource = null;
    renderMarkdownContent(body, src, true);
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => requestAnimationFrame(() => r()));
    const slices = [...body.querySelectorAll('.chart-slice')];
    return {
      card: !!body.querySelector('.chart-card'),
      banner: body.querySelectorAll('.chart-error').length,
      slices: slices.length,
      distinctPaths: new Set(slices.map((s) => s.getAttribute('d'))).size,
      distinctFills: new Set(slices.map((s) => getComputedStyle(s).fill)).size,
      total: body.querySelector('.chart-pie-total')?.textContent || null,
      caption: body.querySelector('.chart-pie-caption')?.textContent || null,
      shares: [...body.querySelectorAll('.chart-pie-share')].map((n) => n.textContent),
      axes: body.querySelectorAll('.chart-axis').length,
      grid: body.querySelectorAll('.chart-grid').length,
      legendSwatches: body.querySelectorAll('.chart-pie-swatch').length,
    };
  })()`);

  assert.equal(painted.card, true, 'the block became a chart card');
  assert.equal(painted.banner, 0, 'a valid pie shows no error banner');
  assert.equal(painted.slices, 4, 'one path per slice');
  assert.equal(painted.distinctPaths, 4, 'every slice has its own geometry');
  assert.equal(painted.distinctFills, 4, 'every slice has its own colour');
  assert.equal(painted.axes, 0, 'a ring has no axes');
  assert.equal(painted.grid, 0, 'a ring has no grid');
  assert.equal(painted.total, '10.6k 次', 'the centre shows the total with its unit');
  assert.equal(painted.caption, '访问量', 'the centre names the series');
  assert.deepEqual(painted.shares, ['45.5%', '29.7%', '16.4%', '8.4%'], 'each legend row carries its share');
  assert.equal(painted.legendSwatches, 4, 'one swatch per legend row');

  // ---- 2. the same block, arriving in fragments ----------------------------
  const streamed = await evaluate(`(async () => {
    const message = addMessage('assistant', '', undefined, { streaming: true });
    const body = message.querySelector('.message-content');
    const fence = '\`\`\`';
    const json = JSON.stringify(${JSON.stringify(PIE)});
    const full = '# 来源\\n\\n' + fence + 'chart\\n' + json + '\\n' + fence + '\\n\\n后面还有正文';
    const closeAt = 2 + 6 + 1 + json.length + 1 + 3;
    const steps = [];
    for (let index = 20; index <= full.length; index += 20) {
      body._renderedMarkdownSource = null;
      renderMarkdownContent(body, full.slice(0, index), false);
      await new Promise((r) => requestAnimationFrame(() => r()));
      steps.push({
        at: index,
        card: !!body.querySelector('.chart-card'),
        raw: !!body.querySelector('pre code.language-chart'),
        banner: body.querySelectorAll('.chart-error').length,
      });
    }
    return {
      steps: steps.length,
      closeAt,
      firstCardAt: (steps.find((s) => s.card) || {}).at || null,
      bannersBeforeClose: steps.filter((s) => s.banner > 0 && s.at < closeAt).length,
      cardsBeforeClose: steps.filter((s) => s.card && s.at < closeAt).length,
      bannerAtEnd: (steps[steps.length - 1] || {}).banner || 0,
    };
  })()`);

  assert.ok(streamed.firstCardAt !== null, 'the ring renders during the stream: ' + JSON.stringify(streamed));
  assert.equal(streamed.bannersBeforeClose, 0,
    'a half-written body never flashes an error: ' + JSON.stringify(streamed));
  assert.equal(streamed.cardsBeforeClose, 0,
    'nothing is drawn before the JSON is whole: ' + JSON.stringify(streamed));
  assert.equal(streamed.bannerAtEnd, 0, 'no banner once the block is valid');
});
