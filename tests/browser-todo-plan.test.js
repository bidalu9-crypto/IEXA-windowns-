// The plan card used to strike through every completed line, which read as
// "cancelled" over CJK text. This pins the replacement: a segmented rail, dimmed
// rows instead of strikethrough, stable nodes across updates, and a card that
// folds itself when history is restored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the plan card tracks progress without striking text out', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-todo-plan-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
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
    await new Promise((r) => server.close(r));
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
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof renderTodoPlan === 'function' && typeof currentSessionId !== 'undefined' && !!currentSessionId");
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Mount a throwaway assistant message; the boot repaint is done by now.
  await evaluate(String.raw`(() => {
    document.querySelector('.welcome')?.remove();
    document.getElementById('view-chat').classList.remove('is-welcome');
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    msg.id = 'plan-fixture';
    msg.innerHTML = '<div class="tool-steps"></div><div class="message-content message-answer">DONE</div>';
    document.getElementById('chatMessages').appendChild(msg);
    renderTodoPlan(msg, [
      { content: 'Read the current task centre', status: 'completed' },
      { content: 'Round-trip the same line twice', status: 'completed' },
      { content: 'Round-trip the same line twice', status: 'completed' },
      { content: 'Rebuild the plan card', status: 'in_progress' },
      { content: 'Verify the glass on a phone', status: 'pending' },
    ]);
  })()`);

  // The card belongs to the activity, not to the answer: it sits between them.
  assert.deepEqual(await evaluate(`(() => {
    const msg = document.getElementById('plan-fixture');
    const order = Array.from(msg.children).map((node) => node.className.split(' ')[0]);
    return order;
  })()`), ['tool-steps', 'todo-plan', 'message-content']);

  const card = () => evaluate(`(() => {
    const panel = document.getElementById('plan-fixture').querySelector('.todo-plan');
    const rail = panel.querySelector('.todo-plan-rail');
    const rows = Array.from(panel.querySelectorAll('.todo-plan-item'));
    const head = panel.querySelector('.todo-plan-head');
    const body = panel.querySelector('.todo-plan-body');
    return {
      rows: rows.length,
      duplicates: rows.filter((row) => row.textContent.trim() === 'Round-trip the same line twice').length,
      segments: rail.children.length,
      doneSegments: Array.from(rail.children).filter((s) => s.classList.contains('is-done')).length,
      activeSegments: Array.from(rail.children).filter((s) => s.classList.contains('is-active')).length,
      decoration: getComputedStyle(rows[0].querySelector('.todo-plan-text')).textDecorationLine,
      activeWeight: getComputedStyle(rows[3]).fontWeight,
      completedWeight: getComputedStyle(rows[0]).fontWeight,
      expanded: head.getAttribute('aria-expanded'),
      controls: head.getAttribute('aria-controls'),
      bodyId: body.id,
      live: panel.querySelector('.todo-plan-sr').textContent,
      count: panel.querySelector('.todo-plan-count').textContent,
      segmentWidth: Math.round(rail.children[0].getBoundingClientRect().width),
      rowHeight: Math.round(rows[0].getBoundingClientRect().height),
    };
  })()`);

  const initial = await card();
  assert.equal(initial.rows, 5, 'every row renders');
  assert.equal(initial.duplicates, 2, 'identical lines are not silently merged');
  assert.equal(initial.segments, 5, 'one segment per row');
  assert.equal(initial.doneSegments, 3);
  assert.equal(initial.activeSegments, 1);
  assert.equal(initial.decoration, 'none', 'completed text is dimmed, never struck out');
  assert.equal(initial.completedWeight, '400', 'completed rows keep normal weight');
  assert.ok(Number(initial.activeWeight) > 400, 'the active row carries the emphasis');
  assert.equal(initial.expanded, 'true');
  assert.equal(initial.controls, initial.bodyId, 'the toggle points at its own body');
  assert.match(initial.live, /3\/5/, 'the live region reads progress: ' + initial.live);
  assert.equal(initial.count, '3/5');
  assert.equal(initial.segmentWidth, 18, 'segments are chips, not stretching bars');

  // A second snapshot must update the same nodes, so the spinner never restarts.
  const stable = await evaluate(`(() => {
    const msg = document.getElementById('plan-fixture');
    const first = msg.querySelector('.todo-plan');
    const row = msg.querySelector('.todo-plan-item.is-in_progress');
    row.dataset.probe = 'kept';
    msg.querySelector('.todo-plan').__probe = 'same-panel';
    renderTodoPlan(msg, [
      { content: 'Read the current task centre', status: 'completed' },
      { content: 'Round-trip the same line twice', status: 'completed' },
      { content: 'Round-trip the same line twice', status: 'completed' },
      { content: 'Rebuild the plan card', status: 'completed' },
      { content: 'Verify the glass on a phone', status: 'in_progress' },
    ]);
    return {
      panelKept: msg.querySelector('.todo-plan').__probe === 'same-panel',
      rowKept: !!msg.querySelector('.todo-plan-item[data-probe="kept"]'),
      samePanelNode: msg.querySelector('.todo-plan') === first,
    };
  })()`);
  assert.deepEqual(stable, { panelKept: true, rowKept: true, samePanelNode: true });

  const advanced = await card();
  assert.equal(advanced.doneSegments, 4);
  assert.equal(advanced.activeSegments, 1);
  assert.equal(advanced.count, '4/5');

  // Long lines clamp at two lines and keep the full text in the title.
  const clamping = await evaluate(`(() => {
    const msg = document.getElementById('plan-fixture');
    const long = 'A very long plan line that keeps going and going so it cannot fit on one row ' + 'and keeps wrapping further '.repeat(6);
    renderTodoPlan(msg, [{ content: long, status: 'pending' }]);
    const text = msg.querySelector('.todo-plan-text');
    const style = getComputedStyle(text);
    return { title: text.title === long.trim(), lines: Math.round(text.getBoundingClientRect().height / parseFloat(style.lineHeight)) };
  })()`);
  assert.equal(clamping.title, true, 'the full line stays reachable: ' + JSON.stringify(clamping));
  assert.ok(clamping.lines <= 2, 'a long row clamps at two lines: ' + clamping.lines);

  // Folding is a real state change, not a hidden element that still eats clicks.
  const folded = await evaluate(`(() => {
    const panel = document.querySelector('.todo-plan');
    const head = panel.querySelector('.todo-plan-head');
    head.click();
    const collapsed = panel.classList.contains('is-collapsed');
    const expanded = head.getAttribute('aria-expanded');
    return new Promise((resolve) => setTimeout(() => resolve({
      collapsed,
      expanded,
      height: Math.round(panel.getBoundingClientRect().height),
      chevron: getComputedStyle(panel.querySelector('.todo-plan-chevron .ui-icon')).transform,
    }), 420));
  })()`);
  assert.equal(folded.collapsed, true);
  assert.equal(folded.expanded, 'false');
  assert.ok(folded.height < 56, 'a folded plan is one row: ' + folded.height);

  // Restored history folds finished plans; an unfinished one stays readable.
  const restore = await evaluate(`(() => {
    const host = document.createElement('div');
    host.className = 'message assistant';
    document.getElementById('chatMessages').appendChild(host);
    renderTodoPlan(host, [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'completed' },
    ], { restored: true });
    const finished = host.querySelector('.todo-plan').classList.contains('is-collapsed');

    const host2 = document.createElement('div');
    host2.className = 'message assistant';
    document.getElementById('chatMessages').appendChild(host2);
    renderTodoPlan(host2, [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'pending' },
    ], { restored: true });
    const open = !host2.querySelector('.todo-plan').classList.contains('is-collapsed');
    return { finished, open };
  })()`);
  assert.deepEqual(restore, { finished: true, open: true });

  // The card follows the theme tokens in dark mode too.
  const themed = await evaluate(`(() => {
    document.documentElement.dataset.theme = 'dark';
    const panel = document.querySelector('.todo-plan');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;background:var(--bg-secondary)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { card: getComputedStyle(panel).backgroundColor, expected };
  })()`);
  assert.equal(themed.card, themed.expected, 'the card surface is a theme token');
});
