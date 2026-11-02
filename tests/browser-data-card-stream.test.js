// A ```data-card block is replaced as soon as its fence closes, mid-stream — not
// when the turn ends. Traffic after it must neither duplicate nor destroy it.
//
// Separate file from the chart fidelity test on purpose: `dist/main/server`
// resolves its workspace path at import time, so one test per browser file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const CARD = {
  title: '广东今日油价', unit: '元/升', badge: '实时数据示例',
  items: [
    { label: '92号汽油', value: 8.91, tone: 'up' },
    { label: '95号汽油', value: 9.65 },
    { label: '89号汽油', value: 8.27 },
    { label: '0号柴油', value: 8.6 },
  ],
  note: '以上为演示数据',
};

test('real browser: a data card appears as soon as its fence closes', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-cardstream-'));
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

  const doc = '```data-card\n' + JSON.stringify(CARD, null, 2) + '\n```\n\n后面还有正文。';

  const result = await evaluate(`(async () => {
    const message = addMessage('assistant', '', undefined, { streaming: true });
    const body = message.querySelector('.message-content');
    const doc = ${JSON.stringify(doc)};
    // The closing fence of the block: everything before it is the fenced body.
    const fenceEnd = doc.indexOf('\\n\`\`\`') + 4;
    const states = [];
    let cardFirstAt = -1;
    let rawSteps = 0;
    let errSteps = 0;
    for (let index = 24; index <= fenceEnd + 24; index += 24) {
      const cut = Math.min(index, doc.length);
      body._renderedMarkdownSource = null;
      renderMarkdownContent(body, doc.slice(0, cut), false);
      await new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => requestAnimationFrame(() => r()));
      const hasCard = !!body.querySelector('.data-card');
      if (cardFirstAt < 0 && hasCard) cardFirstAt = cut;
      if (body.querySelector('code.language-data-card')) rawSteps += 1;
      if (body.querySelector('.chart-error')) errSteps += 1;
      states.push(cut + ':' + (hasCard ? 'card' : body.querySelector('code.language-data-card') ? 'raw' : 'none'));
    }
    // Finish the message: the trailing prose must not tear the card down.
    body._renderedMarkdownSource = null;
    renderMarkdownContent(body, doc, false);
    await new Promise((r) => requestAnimationFrame(() => r()));
    const card = body.querySelector('.data-card');
    return {
      fenceEnd,
      cardFirstAt,
      rawSteps,
      errSteps,
      cardsAfterMoreText: body.querySelectorAll('.data-card').length,
      title: card ? card.querySelector('.data-card-title').textContent : null,
      values: card ? [...card.querySelectorAll('.data-card-value')].map((n) => n.textContent) : [],
      states: states.slice(-6),
    };
  })()`);

  assert.ok(result.cardFirstAt > 0, 'the card rendered mid-stream: ' + JSON.stringify(result));
  // The fence is only complete once its closing backticks arrive, and the loop
  // advances in 24-character slices, so "at the first opportunity" means within
  // one slice of the fence's end.
  assert.ok(result.cardFirstAt - result.fenceEnd <= 24,
    'it appeared at the first frame after the fence closed: ' + result.cardFirstAt + ' vs ' + result.fenceEnd);
  assert.equal(result.errSteps, 0, 'a half-written card never showed an error');
  assert.equal(result.cardsAfterMoreText, 1, 'later text did not duplicate or destroy the card');
  assert.equal(result.title, '广东今日油价', 'the surviving card still reads correctly');
  assert.deepEqual(result.values, ['8.91', '9.65', '8.27', '8.6'], 'every value survived the stream');
});
