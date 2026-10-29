// The conversation/trajectory switch, the two composer docks and the collapsed
// turn-changes card are all rendered by scripts that only wire themselves up
// from `ensure()`. Unit tests call the API directly, so they cannot catch a tab
// that exists in the markup but has no click listener — this test drives the
// real page instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: trajectory tab, composer docks and the folded turn card', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-docks-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_docks';
  const at = Date.now() - 120_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '停靠验证', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '把界面改好', timestamp: at },
    {
      role: 'assistant',
      content: '先看代码，再改三处。',
      status: 'done',
      timestamp: at + 4000,
      durationMs: 4000,
      thinking: '先读文件',
      usage: { inputTokens: 1200, outputTokens: 240 },
      transcript: {
        version: 1, turnId: 't1', revision: 1, status: 'done', valid: true,
        items: [
          { type: 'thinking', start: 0, end: 4, sequence: 1, id: 't1:1', timestamp: at + 100, durationMs: 900 },
          { type: 'tool', callId: 'call_todo', name: 'todo_write', sequence: 2, id: 't1:2', timestamp: at + 1200 },
          { type: 'tool', callId: 'call_edit', name: 'file_edit', sequence: 3, id: 't1:3', timestamp: at + 2400 },
          { type: 'text', start: 0, end: 10, sequence: 4, id: 't1:4', timestamp: at + 3900 },
        ],
      },
      toolCalls: [
        { id: 'call_todo', name: 'todo_write', args: { todos: [{ content: '读代码', status: 'completed' }, { content: '改界面', status: 'in_progress' }, { content: '跑测试', status: 'pending' }] }, result: { success: true, durationMs: 8, todos: [{ content: '读代码', status: 'completed' }, { content: '改界面', status: 'in_progress' }, { content: '跑测试', status: 'pending' }] } },
        { id: 'call_edit', name: 'file_edit', args: { path: 'src/renderer/app.js' }, result: { success: true, durationMs: 45, output: 'ok' } },
      ],
      deliverables: [
        { path: 'src/renderer/app.js', absolutePath: 'src/renderer/app.js', added: 12, removed: 3, before: 'a\nb', after: 'a\nB' },
        { path: 'src/renderer/styles/dock.css', absolutePath: 'src/renderer/styles/dock.css', added: 40, removed: 0, before: '', after: '.dock-panel{}' },
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
  const exceptions = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  // The shared Chrome can serve the first page of a pass before the renderer has
  // finished wiring its modules; acting on a half-initialised app throws inside
  // evaluate and shows up as a one-second failure. Wait for the real entry points.
  await wait("document.readyState === 'complete' && typeof switchSession === 'function' && typeof renderSessionList === 'function'");
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  const boot = await evaluate(`({ items: document.querySelectorAll('.session-item').length, sid: typeof currentSessionId !== 'undefined' ? currentSessionId : 'none', msg: document.querySelectorAll('.message').length })`);
  console.log('BOOT', JSON.stringify(boot));
  console.log('API', await evaluate(`fetch('/api/sessions/sess_docks').then(async (r) => r.status + ' ' + (await r.text()).slice(0, 300)).catch((e) => 'ERR ' + e.message)`));
  if (!boot.msg) {
    const switched = await evaluate(`(() => { try { switchSession('sess_docks', false); return 'ok'; } catch (error) { return 'ERR ' + error.message; } })()`);
    console.log('SWITCH', switched);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    console.log('AFTER', JSON.stringify(await evaluate(`({ sid: typeof currentSessionId !== 'undefined' ? currentSessionId : 'none', msg: document.querySelectorAll('.message').length, body: document.body.innerText.slice(0, 200) })`)));
  }
  await wait("document.querySelectorAll('.message').length >= 2");

  // Both tabs are real buttons with a listener.
  const tabs = await evaluate(`Array.from(document.querySelectorAll('[data-chat-view]')).map((el) => el.dataset.chatView)`);
  assert.deepEqual(tabs, ['conversation', 'trajectory']);

  // Clicking 轨迹 must switch the pane and build the ledger from persisted data.
  await evaluate(`document.querySelector('[data-chat-view="trajectory"]').click(); true`);
  await wait("document.getElementById('trajectoryView').hidden === false");
  const trajectory = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.trajectory-row'));
    return {
      rows: rows.length,
      kinds: [...new Set(rows.map((row) => row.dataset.kind))].sort(),
      messagesHidden: document.querySelector('.chat-messages-area').hidden,
      count: document.getElementById('trajectoryCount').textContent,
    };
  })()`);
  assert.ok(trajectory.rows >= 4, 'ledger rows: ' + trajectory.rows + ' ' + JSON.stringify(trajectory.kinds));
  assert.deepEqual(trajectory.kinds, ['assistant', 'thinking', 'tool', 'user']);
  assert.equal(trajectory.messagesHidden, true);

  // The refresh button has to re-read the persisted session, not re-render the
  // snapshot taken when the conversation was mounted. Append a turn behind the
  // page's back, click 刷新, and require the ledger to grow.
  const beforeRefresh = Number(trajectory.count);
  const sessionFile = path.join(workspace, '.iexa-sessions', sessionId + '.json');
  const stored = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  stored.push({ role: 'user', content: '再补一条要求', timestamp: at + 9000 });
  fs.writeFileSync(sessionFile, JSON.stringify(stored));
  await evaluate(`document.getElementById('trajectoryRefresh').click(); true`);
  await wait(`Number(document.getElementById('trajectoryCount').textContent) > ${beforeRefresh}`);
  const afterRefresh = await evaluate(`({ count: Number(document.getElementById('trajectoryCount').textContent), label: document.getElementById('trajectoryRefresh').textContent, disabled: document.getElementById('trajectoryRefresh').disabled })`);
  assert.ok(afterRefresh.count > beforeRefresh, 'refresh re-read the session: ' + beforeRefresh + ' -> ' + afterRefresh.count);
  assert.equal(afterRefresh.disabled, false, 'the refresh button is usable again');
  assert.notEqual(afterRefresh.label, 'Refreshing…');

  // Selecting a tool row opens the inspector with its input.
  await evaluate(`document.querySelector('.trajectory-row[data-call-id="call_edit"]').click(); true`);
  await wait("document.getElementById('trajectoryInspector').hidden === false");
  const inspector = await evaluate(`document.getElementById('trajectoryInspector').textContent`);
  assert.match(inspector, /src\/renderer\/app\.js/);

  // Back to the conversation.
  await evaluate(`document.querySelector('[data-chat-view="conversation"]').click(); true`);
  await wait("document.getElementById('trajectoryView').hidden === true");

  // The plan dock sits above the composer, collapsed with per-status counts.
  const plan = await evaluate(`(() => {
    const dock = document.getElementById('planDock');
    if (!dock) return null;
    return {
      hidden: dock.hidden,
      text: dock.querySelector('.dock-progress')?.textContent || '',
      listVisible: !dock.querySelector('.dock-list').hidden,
      inComposer: dock.parentElement?.id === 'composerDock',
    };
  })()`);
  assert.ok(plan, 'plan dock rendered');
  assert.equal(plan.hidden, false);
  assert.equal(plan.inComposer, true);
  assert.match(plan.text, /已完成/);
  assert.equal(plan.listVisible, false, 'plan starts collapsed');

  // Toggling opens the checklist, and the close button hides the dock.
  await evaluate(`document.querySelector('#planDock .dock-toggle').click(); true`);
  await wait("!document.querySelector('#planDock .dock-list').hidden");
  const items = await evaluate(`document.querySelectorAll('#planDock .dock-list-item').length`);
  assert.equal(items, 3);
  await evaluate(`document.querySelector('#planDock .dock-dismiss').click(); true`);
  await wait("document.getElementById('planDock').hidden === true");

  // A long turn-changes card is folded to its summary line by default.
  const card = await evaluate(`(() => {
    const panel = document.querySelector('.turn-deliverables');
    if (!panel) return null;
    const body = panel.querySelector('.turn-deliverables-body');
    return {
      collapsed: panel.classList.contains('is-collapsed'),
      bodyDisplay: body ? getComputedStyle(body).display : '',
      files: panel.querySelectorAll('.turn-deliverables .file-action-card').length,
    };
  })()`);
  assert.ok(card, 'turn deliverables rendered');
  assert.equal(card.collapsed, false, 'two compact cards stay visible');
  assert.equal(card.files, 2);

  // A queued prompt is a chip above the composer, not a bubble in the transcript.
  const queue = await evaluate(`(() => {
    promptQueue = Array.from({ length: 5 }, (_, index) => ({
      id: 'q' + index, sessionId: currentSessionId, text: '第 ' + (index + 1) + ' 条排队消息',
      displayText: '第 ' + (index + 1) + ' 条排队消息', attachments: [], mode: 'queue',
    }));
    updateComposerForQueue();
    const dock = document.getElementById('queueDock');
    return {
      hidden: dock.hidden,
      rows: dock.querySelectorAll('.dock-list li').length,
      more: dock.querySelector('.dock-more')?.hidden === false,
      inComposer: dock.parentElement?.id === 'composerDock',
      transcriptBubbles: document.querySelectorAll('.message.is-queued').length,
    };
  })()`);
  assert.equal(queue.hidden, false);
  assert.equal(queue.inComposer, true);
  assert.equal(queue.rows, 3, 'three chips stay visible');
  assert.equal(queue.more, true, '+N more is offered');
  assert.equal(queue.transcriptBubbles, 0, 'nothing is added to the transcript');

  // A tool call expands into the input/output/diff tabs instead of a raw block.
  const toolCard = await evaluate(`(() => {
    const block = document.querySelector('.tool-block');
    if (!block) return null;
    const header = block.querySelector('.tool-header');
    if (header) header.click();
    return {
      tabs: block.querySelectorAll('.tool-tabs .tool-tab').length,
      labels: [...block.querySelectorAll('.tool-tabs .tool-tab')].map((tab) => tab.textContent.trim()),
    };
  })()`);
  assert.ok(toolCard, 'a tool block is rendered');
  assert.ok(toolCard.tabs >= 2, 'tool tabs: ' + toolCard.tabs);

  assert.deepEqual(exceptions, [], 'the page must boot without uncaught errors');
});
