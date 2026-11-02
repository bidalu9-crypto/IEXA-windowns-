// A Markdown table must take its rounded card while rows are still arriving,
// not when the turn ends. Three properties are asserted together, because fixing
// one without the others reintroduces either the delay or the flicker:
//
//   1. the wrapper exists during streaming (the reported defect);
//   2. the wrapper node keeps its identity across deltas (no unwrap/rewrap);
//   3. rows keep growing inside it (patch must not skip the subtree).
//
// The per-frame budget is measured too: wrapping on every delta must stay cheap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a streaming table keeps its card and keeps growing', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-stream-table-'));
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
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 200));
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof addMessage === 'function' && typeof renderMarkdownContent === 'function' && currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 900));

  // Long enough to take the chunked streaming path rather than a whole render.
  const filler = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 段正文，把回复撑到长回复的量级，让分块渲染分支生效。`).join('\n\n');
  const doc = filler + '\n\n| 项 | 值 |\n| --- | --- |\n| 系统 | Windows 10 |\n| 内存 | 32 GB |\n| 显卡 | RTX 2060 |\n\n完。';

  const report = await evaluate(`(async () => {
    const message = addMessage('assistant', '', undefined, { streaming: true });
    const body = message.querySelector('.message-content');
    const full = ${JSON.stringify(doc)};
    const samples = [];
    const frameTimes = [];
    for (let index = 60; index <= full.length; index += 12) {
      body._renderedMarkdownSource = null;
      const started = performance.now();
      renderMarkdownContent(body, full.slice(0, index), false);
      frameTimes.push(performance.now() - started);
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const wrap = body.querySelector('.markdown-table-wrap');
      // A token stamped once proves the node survived: a rebuilt wrapper would
      // lose the expando.
      if (wrap && !wrap.__iexaStamped) wrap.__iexaStamped = true;
      const table = body.querySelector('.markdown-table-wrap table');
      samples.push({
        at: index,
        wrapped: Boolean(wrap),
        kept: wrap ? wrap.__iexaStamped === true : false,
        rows: table ? table.querySelectorAll('tbody tr').length : 0,
        rawTable: Boolean(body.querySelector('table:not(.markdown-table-wrap table)')),
      });
    }
    const wrapped = samples.filter((sample) => sample.wrapped);
    const usable = frameTimes.slice(2).sort((a, b) => a - b);
    const finalPass = body.querySelectorAll('.markdown-table-wrap').length;
    return {
      totalSteps: samples.length,
      wrappedSteps: wrapped.length,
      firstWrapAt: wrapped.length ? wrapped[0].at : null,
      keptToken: wrapped.filter((sample) => sample.kept).length,
      rowsFirst: wrapped.length ? wrapped[0].rows : 0,
      rowsLast: wrapped.length ? wrapped[wrapped.length - 1].rows : 0,
      unwrappedTables: samples.filter((sample) => sample.rawTable).length,
      p95: Math.round((usable[Math.floor(usable.length * 0.95)] || 0) * 100) / 100,
      max: Math.round(Math.max(...frameTimes.slice(2)) * 100) / 100,
      finalWrappers: finalPass,
    };
  })()`);

  assert.ok(report.wrappedSteps > 0, 'the table is wrapped while streaming, not only at the end: ' + JSON.stringify(report));
  assert.equal(report.keptToken, report.wrappedSteps, 'the wrapper survives every delta: ' + JSON.stringify(report));
  assert.ok(report.rowsFirst >= 1, 'it wraps once the header is complete: ' + JSON.stringify(report));
  assert.ok(report.rowsLast > report.rowsFirst, 'rows keep arriving inside the wrapper: ' + JSON.stringify(report));
  assert.equal(report.unwrappedTables, 0, 'no bare table is left outside a wrapper: ' + JSON.stringify(report));
  assert.equal(report.finalWrappers, 1, 'exactly one wrapper at the end: ' + JSON.stringify(report));
  assert.ok(report.p95 <= 8, 'wrapping stays inside the frame budget: ' + JSON.stringify(report));
});
