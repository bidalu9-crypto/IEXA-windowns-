// Real browser: the context insights page renders against a seeded workspace,
// switches ranges, and degrades to an empty state without pretending to have data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const DAY = 24 * 60 * 60 * 1000;

function seed(root) {
  const dir = path.join(root, '.iexa-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const sessions = {
    sess_insights_a: [
      { role: 'user', content: '帮我看看这个仓库的结构' },
      {
        role: 'assistant', content: '看完了，主要分三层。', timestamp: now - 2 * DAY,
        usage: { inputTokens: 120000, outputTokens: 2400, cacheReadInputTokens: 110000 },
        durationMs: 30000, generationMs: 9000, firstTokenMs: 6000,
        toolCalls: [
          { result: { durationMs: 1200, output: 'src/main' } },
          { result: { durationMs: 800, output: 'src/renderer' } },
        ],
      },
      {
        role: 'assistant', content: '补充一下依赖。', timestamp: now - DAY,
        usage: { inputTokens: 260000, outputTokens: 3600, cacheReadInputTokens: 250000 },
        durationMs: 42000, generationMs: 12000, firstTokenMs: 8000,
        toolCalls: [{ result: { durationMs: 2400, output: 'package.json' } }],
      },
    ],
    sess_insights_b: [
      { role: 'user', content: '写一个脚本' },
      {
        role: 'assistant', content: '好了。', timestamp: now - 3 * 60 * 60 * 1000,
        usage: { inputTokens: 48000, outputTokens: 900, cacheReadInputTokens: 40000 },
        durationMs: 15000, generationMs: 5000, firstTokenMs: 3000,
        toolCalls: [{ result: { durationMs: 400, output: 'ok' } }],
      },
    ],
  };
  for (const [id, messages] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ messages }, null, 2));
  }
  fs.writeFileSync(path.join(root, '.iexa-sessions.json'), JSON.stringify({
    sessions: [
      { id: 'sess_insights_a', title: '仓库结构', created: now - 2 * DAY, updated: now - DAY, messageCount: 3, modelBinding: { profileId: 'p1', provider: 'openai', model: 'fixture-model' } },
      { id: 'sess_insights_b', title: '写脚本', created: now, updated: now, messageCount: 2, modelBinding: { profileId: 'p1', provider: 'openai', model: 'fixture-model' } },
    ],
    activeSessionId: 'sess_insights_a',
  }, null, 2));
  fs.writeFileSync(path.join(root, '.iexa-settings.json'), JSON.stringify({
    profiles: [{ id: 'p1', name: 'Fixture', provider: 'openai', model: 'fixture-model', apiKey: 'FIXTURE-KEY', contextWindow: 128000, maxOutputTokens: 512, tokenPrice: { input: 1, output: 2, cacheRead: 0.1 } }],
    activeProfileId: 'p1',
  }, null, 2));
}

test('real browser: the insights page renders, switches ranges and empties cleanly', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-insights-browser-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  seed(workspace);
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof initUsageInsights === 'function' && typeof currentSessionId !== 'undefined'");

  await evaluate("document.querySelector('.nav-btn[data-view=\"token-calculator\"]').click(); true");
  await wait("document.querySelectorAll('.insights-card').length === 6");
  await new Promise((r) => setTimeout(r, 500));

  const layout = await evaluate(`(() => {
    const cards = document.querySelectorAll('.insights-card').length;
    const metrics = Array.from(document.querySelectorAll('.insights-metric'));
    const donuts = document.querySelectorAll('.insights-donut').length;
    const bars = Array.from(document.querySelectorAll('.insights-bar-token')).map((el) => Math.round(el.getBoundingClientRect().height));
    const heat = document.querySelectorAll('.insights-heat-grid i').length;
    const sessions = document.querySelectorAll('.insights-session').length;
    const rings = Array.from(document.querySelectorAll('.insights-session-ring')).map((el) => getComputedStyle(el).backgroundImage);
    return {
      cards, metrics: metrics.map((el) => el.querySelector('strong').textContent),
      donuts, bars, heat, sessions, rings,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  })()`);

  assert.equal(layout.cards, 6, 'metrics, trend, token, time, activity and sessions');
  assert.equal(layout.donuts, 2, 'token and time rings');
  assert.equal(layout.metrics.length, 6, 'six metric tiles');
  assert.ok(layout.metrics[0].includes('2'), 'two sessions in range: ' + layout.metrics[0]);
  assert.ok(layout.metrics.some((value) => value.includes('¥')), 'a price is shown when one is configured: ' + layout.metrics.join(' | '));
  assert.ok(layout.bars.length >= 7 && layout.bars.every((height) => height > 0), 'bars have height: ' + JSON.stringify(layout.bars));
  assert.ok(layout.heat >= 42, 'the heatmap spans at least six weeks: ' + layout.heat);
  assert.equal(layout.sessions, 2);
  assert.ok(layout.rings.every((image) => image.includes('conic-gradient')), 'session rings are painted: ' + JSON.stringify(layout.rings));
  assert.equal(layout.overflow, false);

  // The legend must agree with its own ring: every label has a colour and a
  // share, and colours are unique within one donut (the two rings use separate
  // palettes, so comparing across them would be meaningless).
  const legends = await evaluate(`(() => ['.insights-card-token', '.insights-card-time'].map((selector) =>
    Array.from(document.querySelector(selector).querySelectorAll('.insights-legend li')).map((li) => ({
      label: li.querySelector('.insights-legend-label').textContent,
      ratio: li.querySelector('.insights-legend-pct').textContent,
      color: getComputedStyle(li.querySelector('i')).backgroundColor,
    }))))()`);
  assert.equal(legends.length, 2);
  for (const legend of legends) {
    assert.ok(legend.length >= 3, 'several sources are listed');
    assert.ok(legend.every((entry) => entry.ratio.endsWith('%')), 'each legend row carries a share');
    assert.equal(new Set(legend.map((entry) => entry.color)).size, legend.length, 'no two rows share a colour: ' + JSON.stringify(legend));
  }

  // Range switching re-queries and repaints the trend heading.
  const heading = () => evaluate("document.querySelector('.insights-card-trend h3').textContent");
  assert.match(await heading(), /近 7 天/);
  await evaluate("document.querySelector('.insights-ranges [data-range=\"24h\"]').click(); true");
  await wait("document.querySelector('.insights-ranges [data-range=\"24h\"]').getAttribute('aria-selected') === 'true'");
  await wait("!!document.querySelector('.insights-card-trend h3') && document.querySelector('.insights-card-trend h3').textContent.includes('24 小时')");
  await evaluate("document.querySelector('.insights-ranges [data-range=\"all\"]').click(); true");
  await wait("document.querySelector('.insights-ranges [data-range=\"all\"]').getAttribute('aria-selected') === 'true'");
  await wait("!!document.querySelector('.insights-card-trend h3') && document.querySelector('.insights-card-trend h3').textContent.includes('全部')");

  // Dark theme repaints without losing the cards.
  await evaluate("document.documentElement.dataset.theme='dark'; true");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await evaluate("document.querySelectorAll('.insights-card').length"), 6);
  const darkSurface = await evaluate("getComputedStyle(document.querySelector('.insights-card')).backgroundColor");
  assert.notEqual(darkSurface, 'rgb(255, 255, 255)', 'the card follows the dark surface');
  // Empty state: clear the sessions and reload the view.
  await evaluate("window.__emptyInsights = true; true");
  fs.rmSync(path.join(workspace, '.iexa-sessions'), { recursive: true, force: true });
  await evaluate("insightsState.data = null; insightsState.range = '7d'; void loadUsageInsights(true); true");
  await wait("!!document.querySelector('.insights-empty')");
  assert.match(await evaluate("document.querySelector('.insights-empty').textContent"), /还没有调用记录/);
});
