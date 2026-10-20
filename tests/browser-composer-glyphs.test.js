// The three composer glyphs are drawn on the shared 24-grid: one optical
// weight, square boxes, and colour inherited from the control's state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
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
      checkpoint: read(null, '#checkpointBtn .ui-icon'),
      buttonColor: getComputedStyle(button).color,
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
  assert.equal(glyphs.checkpoint.href, '#ui-branch');
  // Square boxes: a letterboxed box clips the path, which is exactly the bug
  // this test exists to catch.
  assert.deepEqual(glyphs.reasoning.box, [14, 14], 'reasoning glyph is square at 14px');
  assert.deepEqual(glyphs.compact.box, [14, 14], 'compaction glyph is square at 14px');
  assert.deepEqual(glyphs.checkpoint.box, [16, 16], 'checkpoint glyph keeps the toolbar size');
  // One optical weight: all three inherit the same stroke, whatever the theme sets.
  assert.equal(glyphs.reasoning.stroke, glyphs.compact.stroke);
  assert.equal(glyphs.compact.stroke, glyphs.checkpoint.stroke);
  assert.equal(glyphs.reasoning.fill, 'none');
  // The spark dot is the only filled part; it must stay on currentColor.
  assert.deepEqual(glyphs.dot, { fill: 'currentColor', stroke: 'none' });
  assert.equal(glyphs.reasoning.color, glyphs.buttonColor, 'the glyph follows the control state');

  // Selecting the top level must tint the glyph through the same token.
  await evaluate("document.getElementById('thinkingLevelBtn').dataset.level = 'high'; true");
  const high = await evaluate(`(() => {
    const svg = document.querySelector('#thinkingLevelBtn .ui-icon');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;color:var(--accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { icon: getComputedStyle(svg).color, accent };
  })()`);
  assert.equal(high.icon, high.accent, 'the high level paints the glyph with the accent');
});
