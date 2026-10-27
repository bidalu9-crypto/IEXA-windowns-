// The three composer glyphs are drawn on the shared 24-grid: one optical
// weight, square boxes, and colour inherited from the control's state.
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

test('real browser: reasoning, compaction and checkpoint glyphs share one grid', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-glyphs-'));
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
    for (let index = 0; index < 120; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");

  const glyphs = await evaluate(`(() => {
    const read = (button, selector) => {
      const svg = document.querySelector(selector);
      const box = svg.getBoundingClientRect();
      const style = getComputedStyle(svg);
      return {
        href: svg.querySelector('use')?.getAttribute('href'),
        box: [Math.round(box.width), Math.round(box.height)],
        stroke: style.strokeWidth,
        fill: style.fill,
        color: style.color,
        viewBox: svg.viewBox?.baseVal?.width ?? 24,
      };
    };
    const button = document.getElementById('thinkingLevelBtn');
    return {
      reasoning: read(button, '#thinkingLevelBtn .ui-icon'),
      compact: read(null, '.context-compaction-btn .ui-icon'),
      buttonColor: getComputedStyle(button).color,
      checkpoint: { ...read(null, '#checkpointBtn .ui-icon'),
        label: document.querySelector('.checkpoint-label')?.textContent,
        labelBox: (() => { const r = document.querySelector('.checkpoint-label')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
        pill: (() => { const b = document.getElementById('checkpointBtn'); const r = b.getBoundingClientRect(); const s = getComputedStyle(b); return { w: Math.round(r.width), h: Math.round(r.height), radius: s.borderRadius, font: s.fontSize }; })(),
        iconButton: document.getElementById('checkpointBtn').classList.contains('ui-icon-button'),
        peerHeight: Math.round(document.getElementById('contextCompactionBtn').getBoundingClientRect().height),
      },
      dot: document.querySelector('#ui-reasoning circle')
        ? {
            fill: document.querySelector('#ui-reasoning circle').getAttribute('fill'),
            stroke: document.querySelector('#ui-reasoning circle').getAttribute('stroke'),
          }
        : null,
    };
  })()`);

  assert.equal(glyphs.reasoning.href, '#ui-reasoning');
  assert.equal(glyphs.compact.href, '#ui-compact');
  assert.equal(glyphs.checkpoint.href, '#ui-checkpoint');
  // Square boxes: a letterboxed box clips the path, which is exactly the bug
  // this test exists to catch.
  assert.deepEqual(glyphs.reasoning.box, [14, 14], 'reasoning glyph is square at 14px');
  assert.deepEqual(glyphs.compact.box, [14, 14], 'compaction glyph is square at 14px');
  assert.deepEqual(glyphs.checkpoint.box, [14, 14], 'checkpoint glyph matches the labelled pills at 14px');
  // A lone flag read as decoration; the pill carries its own name like its peers.
  assert.equal(glyphs.checkpoint.label, '检查点', 'the checkpoint control names itself');
  assert.ok(glyphs.checkpoint.labelBox[0] > 20 && glyphs.checkpoint.labelBox[1] > 8, 'the label is actually painted');
  assert.equal(glyphs.checkpoint.iconButton, false, 'it is a labelled pill, not an icon-only button');
  assert.equal(glyphs.checkpoint.pill.radius, '9999px');
  assert.equal(glyphs.checkpoint.pill.h, glyphs.checkpoint.peerHeight, 'same height as the neighbouring pills');
  assert.equal(glyphs.checkpoint.pill.font, await evaluate("getComputedStyle(document.getElementById('contextCompactionBtn')).fontSize"),
    'same type scale as the neighbouring pills');
  // One optical weight: all three inherit the same stroke, whatever the theme sets.
  assert.equal(glyphs.reasoning.stroke, glyphs.compact.stroke);
  assert.equal(glyphs.compact.stroke, glyphs.checkpoint.stroke);
  assert.equal(glyphs.reasoning.fill, 'none');
  // The spark dot is the only filled part; it must stay on currentColor.
  assert.deepEqual(glyphs.dot, { fill: 'currentColor', stroke: 'none' });
  assert.equal(glyphs.reasoning.color, glyphs.buttonColor, 'at rest the glyph follows the control');

  // A coloured level tints the label, not the glyph: every icon in the bar keeps
  // the same neutral ink so one pill can be highlighted without recolouring it.
  await evaluate("document.getElementById('thinkingLevelBtn').dataset.level = 'high'; true");
  const high = await evaluate(`(() => {
    const btn = document.getElementById('thinkingLevelBtn');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;color:var(--accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      icon: getComputedStyle(btn.querySelector('.thinking-level-icon')).color,
      label: getComputedStyle(document.getElementById('thinkingLevelLabel')).color,
      peer: getComputedStyle(document.querySelector('.context-compaction-icon')).color,
      accent,
    };
  })()`);
  assert.equal(high.icon, high.peer, 'the reasoning glyph keeps the toolbar ink');
  assert.equal(high.label, high.accent, 'the label carries the level colour');
  await evaluate("document.getElementById('thinkingLevelBtn').dataset.level = 'medium'; true");

  // The usage ring sits beside the balance; with no balance it takes that slot.
  const slots = await evaluate(`(() => {
    const bar = document.querySelector('.model-bar');
    const ring = document.getElementById('contextProgress');
    const visible = Array.from(bar.children).filter((el) => getComputedStyle(el).display !== 'none');
    return {
      betweenCheckpointAndBalance:
        ring.previousElementSibling === document.querySelector('.checkpoint-wrap')
        && ring.nextElementSibling === document.getElementById('balanceWrap'),
      lastVisible: visible[visible.length - 1].id,
    };
  })()`);
  assert.equal(slots.betweenCheckpointAndBalance, true, 'the ring sits between checkpoints and balance');
  assert.equal(slots.lastVisible, 'contextProgress', 'without a balance the ring holds the right edge');

  // Hovering any control lifts its glyph; only the transform changes.
  for (const [button, icon] of [
    ['#thinkingLevelBtn', '.thinking-level-icon'],
    ['#contextCompactionBtn', '.context-compaction-icon'],
    ['#permissionModeBtn', '.permission-mode-btn-icon'],
    ['#checkpointBtn', 'svg.ui-icon'],
    ['#contextProgress', '.context-progress-ring'],
  ]) {
    const center = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(button)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none' });
    await new Promise((r) => setTimeout(r, 260));
    const transform = await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(button)}).querySelector(${JSON.stringify(icon)})).transform`);
    assert.match(transform, /^matrix\(1\.16, 0, 0, 1\.16, 0, 0\)$/, `${button} lifts its glyph on hover: ${transform}`);
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' });
  await new Promise((r) => setTimeout(r, 260));
  // The ring carries its own base transform, so the release is read on a plain glyph.
  const parked = await evaluate("getComputedStyle(document.querySelector('#checkpointBtn svg.ui-icon')).transform");
  assert.equal(parked, 'none', 'the lift is released when the pointer leaves');

  // The app's own reduced-motion switch silences the lift.
  await evaluate("document.documentElement.dataset.motion = 'reduced'; true");
  const center = await evaluate(`(() => { const r = document.getElementById('checkpointBtn').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none' });
  await new Promise((r) => setTimeout(r, 260));
  const reduced = await evaluate("getComputedStyle(document.querySelector('#checkpointBtn svg.ui-icon')).transform");
  assert.equal(reduced, 'none', 'reduced motion keeps the glyph still');
  await evaluate("document.documentElement.dataset.motion = 'full'; true");
});
