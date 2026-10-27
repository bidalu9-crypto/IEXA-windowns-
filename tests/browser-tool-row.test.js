// A tool row is the only place that says what a call did, and the rail is
// narrow on small windows. This drives the real page at 520px and measures the
// two halves of the row: the title must stay whole, the argument summary is
// the part allowed to ellipsize.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a narrow rail keeps the whole tool title', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-toolrow-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_toolrow';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '工具行', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '跑一下测试', timestamp: at },
    {
      role: 'assistant',
      content: '跑完了。',
      status: 'done',
      timestamp: at + 3000,
      durationMs: 3000,
      usage: { inputTokens: 100, outputTokens: 20 },
      transcript: {
        version: 1, turnId: 't1', revision: 1, status: 'done', valid: true,
        items: [
          { type: 'tool', callId: 'call_long', name: 'shell_execute', sequence: 1, id: 't1:1', timestamp: at + 500 },
          { type: 'tool', callId: 'call_edit', name: 'file_edit', sequence: 2, id: 't1:2', timestamp: at + 1500 },
        ],
      },
      toolCalls: [
        {
          id: 'call_long',
          name: 'shell_execute',
          args: { command: 'npx tsc --noEmit && node --test tests/browser-stream-perf.test.js tests/stream-incremental.test.js', shell: 'powershell', tool_title: '新增流式预算测试' },
          result: { success: true, durationMs: 4870, output: 'ok' },
        },
        {
          id: 'call_edit',
          name: 'file_edit',
          args: { path: 'src/renderer/services/ToolStreamView.js', tool_title: '跑流式预算' },
          result: { success: true, durationMs: 189, output: 'ok' },
        },
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
    for (let index = 0; index < 140; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // Narrow enough that the rail has to make a choice, wide enough to hold the
  // title itself; 520px is a realistic half-screen window.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 820, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await wait("document.querySelectorAll('.message').length >= 2");
  // Build a live rail: this is the path the screenshot came from, where the
  // model supplies a tool_title and the row must still show all of it.
  await evaluate(`(() => {
    addMessage('assistant', '', null, { streaming: true });
    handleToolStart('call_live_1', 'shell_execute');
    handleToolInput('shell_execute', {
      command: 'npx tsc --noEmit && node --test tests/browser-stream-perf.test.js tests/stream-incremental.test.js',
      shell: 'powershell',
      tool_title: '新增流式预算测试',
    }, 'call_live_1');
    handleToolStart('call_live_2', 'file_edit');
    handleToolInput('file_edit', {
      path: 'src/renderer/services/ToolStreamView.js',
      tool_title: '跑流式预算',
    }, 'call_live_2');
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await wait("document.querySelectorAll('.activity-row .tool-name').length >= 2");

  const rows = await evaluate(`Array.from(document.querySelectorAll('.activity-row')).slice(-2).map((row) => {
    const name = row.querySelector('.tool-name');
    const meta = row.querySelector('.tool-meta');
    const rect = row.getBoundingClientRect();
    return {
      title: (name.firstChild ? name.firstChild.textContent : name.textContent).trim(),
      nameClient: name.clientWidth,
      nameScroll: name.scrollWidth,
      nameEllipsis: getComputedStyle(name).textOverflow,
      metaClient: meta ? meta.clientWidth : 0,
      metaScroll: meta ? meta.scrollWidth : 0,
      metaEllipsis: meta ? getComputedStyle(meta).textOverflow : '',
      rowWidth: Math.round(rect.width),
    };
  })`);
  console.log('ROWS', JSON.stringify(rows, null, 1));

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.nameScroll <= row.nameClient + 1,
      `title "${row.title}" is clipped: ${row.nameScroll} > ${row.nameClient}`);
    assert.equal(row.nameEllipsis, 'ellipsis', 'the title keeps the ellipsis only as a last resort');
  }
  // The command is the part that must give way, so at least one row shows an
  // ellipsized summary — proving the space came from the summary, not the title.
  assert.ok(rows.some((row) => row.metaScroll > row.metaClient + 1), 'the argument summary yields first');
  assert.equal(rows[0].title, '新增流式预算测试');

  // Half a window: the summary is hidden below 760px, so the title owns the
  // row and must still fit without an ellipsis.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 520, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const narrow = await evaluate(`Array.from(document.querySelectorAll('.activity-row')).slice(-2).map((row) => {
    const name = row.querySelector('.tool-name');
    return {
      title: (name.firstChild ? name.firstChild.textContent : name.textContent).trim(),
      client: name.clientWidth,
      scroll: name.scrollWidth,
    };
  })`);
  for (const row of narrow) {
    assert.ok(row.scroll <= row.client + 1, 'narrow title ' + row.title + ' clipped: ' + row.scroll + ' > ' + row.client);
  }
});
