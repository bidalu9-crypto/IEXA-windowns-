// A tool body must collapse from its own header no matter which tab was last
// clicked. The tab buttons stopPropagation on the document handler, so this
// drives the real page instead of asserting the helper in isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: tool tabs keep the header collapse working', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-toggle-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_toggle';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '折叠验证', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '看一下命令', timestamp: at },
    {
      role: 'assistant',
      content: '执行完毕。',
      timestamp: at + 5000,
      transcript: {
        version: 1, turnId: 't1', revision: 1, status: 'done', valid: true,
        items: [
          { type: 'tool', callId: 'call_shell', name: 'shell_execute', sequence: 1, id: 't1:1', timestamp: at + 1200 },
          { type: 'text', start: 0, end: 5, sequence: 2, id: 't1:2', timestamp: at + 3900 },
        ],
      },
      toolCalls: [
        { id: 'call_shell', name: 'shell_execute', args: { command: 'npm test' }, result: { success: true, durationMs: 1200, output: 'all green' } },
      ],
    },
  ]));
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 120; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  if (!(await evaluate("document.querySelectorAll('.message').length"))) {
    await evaluate(`switchSession('${sessionId}', false)`);
  }
  await wait("document.querySelectorAll('.tool-block').length >= 1");

  const state = () => evaluate(`(() => {
    const block = document.querySelector('.tool-block');
    const body = block.querySelector('.tool-body');
    return {
      display: body.style.display,
      computed: getComputedStyle(body).display,
      expanded: block.classList.contains('is-expanded'),
      tab: block.dataset.activeToolTab || '',
      aria: block.querySelector('.tool-header').getAttribute('aria-expanded'),
    };
  })()`);

  // Open.
  await evaluate(`document.querySelector('.tool-block .tool-header').click(); true`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const opened = await state();
  assert.equal(opened.display, 'block', 'the header opens the body: ' + JSON.stringify(opened));
  // A settled call opens on its result, and the legacy Shell console must not
  // sit above the tab surface duplicating the command.
  const surface = await evaluate(`(() => {
    const block = document.querySelector('.tool-block');
    const pane = block.querySelector('[data-pane="output"]');
    return {
      tab: block.dataset.activeToolTab || '',
      outputVisible: pane ? !pane.hidden : false,
      output: pane ? pane.textContent : '',
      hasLegacyPanel: !!block.querySelector('.tool-detail-panel'),
      tabs: block.querySelectorAll('.tool-tab').length,
    };
  })()`);
  assert.equal(surface.hasLegacyPanel, false, 'the old Shell panel is gone: ' + JSON.stringify(surface));
  assert.equal(surface.tabs, 2, 'input/output tabs remain: ' + JSON.stringify(surface));
  assert.equal(surface.tab, 'output', 'a settled call opens on output: ' + JSON.stringify(surface));
  assert.equal(surface.outputVisible, true, 'the output pane is visible: ' + JSON.stringify(surface));
  assert.match(surface.output, /all green/, 'the output holds the result: ' + JSON.stringify(surface));

  // Switch to the output tab, then close from the header.
  await evaluate(`document.querySelector('.tool-block [data-tool-tab="output"]').click(); true`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const tabbed = await state();
  assert.equal(tabbed.tab, 'output');
  assert.equal(tabbed.computed, 'block', 'the body still shows the output pane: ' + JSON.stringify(tabbed));

  await evaluate(`document.querySelector('.tool-block .tool-header').click(); true`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const closed = await state();
  assert.equal(closed.display, 'none', 'the header collapses after a tab click: ' + JSON.stringify(closed));
  assert.equal(closed.expanded, false, 'the chevron state follows: ' + JSON.stringify(closed));
  assert.equal(closed.aria, 'false', 'aria-expanded follows: ' + JSON.stringify(closed));

  // Re-open and close again, twice, to catch a one-shot handler.
  for (let round = 0; round < 2; round += 1) {
    await evaluate(`document.querySelector('.tool-block .tool-header').click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await state()).display, 'block', 'round ' + round + ' opens');
    await evaluate(`document.querySelector('.tool-block .tool-header').click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await state()).display, 'none', 'round ' + round + ' closes');
  }
});
