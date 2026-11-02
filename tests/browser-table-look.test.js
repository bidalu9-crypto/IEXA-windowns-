// A chat table must read like the reference chat UI: one rounded container and
// rules between rows only. The old styling drew a vertical rule between every
// column, tinted alternate rows and pinned a shaded header — a two-column spec
// sheet came out looking like a spreadsheet.
//
// This is measured on computed style, not on the stylesheet text, because the
// point is what reaches the pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a table is one rounded panel with row rules only', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-table-look-'));
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

  const doc = [
    '| 项 | 值 |',
    '| --- | --- |',
    '| 系统 | Microsoft Windows 10 专业版 |',
    '| 版本 | 10.0.19045 (22H2) |',
    '| 架构 | 64 位 |',
  ].join('\n');

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 820, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof addMessage === 'function' && typeof renderMarkdownContent === 'function' && currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 700));

  await evaluate(`(() => {
    const message = addMessage('assistant', '', undefined, { streaming: false });
    const body = message.querySelector('.message-content');
    body._renderedMarkdownSource = null;
    renderMarkdownContent(body, ${JSON.stringify(doc)}, true);
    return true;
  })()`);
  await wait("!!document.querySelector('.markdown-table-wrap thead th')");

  const style = await evaluate(`(() => {
    const wrap = document.querySelector('.markdown-table-wrap');
    const table = wrap.querySelector('table');
    const th = table.querySelector('thead th');
    const td = table.querySelector('tbody td');
    const second = table.querySelectorAll('tbody tr')[1];
    const last = table.querySelectorAll('tbody tr')[table.querySelectorAll('tbody tr').length - 1];
    const cs = (el) => getComputedStyle(el);
    return {
      radius: parseFloat(cs(wrap).borderTopLeftRadius),
      outerBorder: cs(wrap).borderTopWidth,
      thRight: cs(th).borderRightWidth,
      tdRight: cs(td).borderRightWidth,
      tdBottom: cs(td).borderBottomWidth,
      lastBottom: cs(last.querySelector('td')).borderBottomWidth,
      headerPosition: cs(th).position,
      headerBg: cs(th).backgroundColor,
      zebra: cs(second).backgroundColor,
      padding: cs(td).paddingTop,
    };
  })()`);

  assert.equal(style.thRight, '0px', 'no vertical rule in the header: ' + JSON.stringify(style));
  assert.equal(style.tdRight, '0px', 'no vertical rule between columns: ' + JSON.stringify(style));
  assert.equal(style.headerPosition, 'static', 'the header is not a pinned band: ' + JSON.stringify(style));
  assert.match(style.headerBg, /rgba?\(0, 0, 0, 0\)|transparent/,
    'the header carries no tinted block: ' + JSON.stringify(style));
  assert.match(style.zebra, /rgba?\(0, 0, 0, 0\)|transparent/,
    'alternate rows are not shaded: ' + JSON.stringify(style));
  assert.equal(style.tdBottom, '1px', 'rows are separated by a rule: ' + JSON.stringify(style));
  assert.equal(style.lastBottom, '0px', 'the last row has no trailing rule: ' + JSON.stringify(style));
  assert.ok(style.radius >= 10, 'the container is rounded: ' + JSON.stringify(style));
  assert.ok(parseFloat(style.padding) >= 10, 'cells breathe: ' + JSON.stringify(style));
});
