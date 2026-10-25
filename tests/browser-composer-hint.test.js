// The composer's empty state rotates through live facts, and the composer turns
// into a red mist as the request approaches its compaction threshold. Both are
// driven from the same context reading as the ring, so they cannot disagree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

// Every place that empties the composer must repaint the overlay: assigning
// `.value` fires no input event, so the hint would stay hidden until the next
// keystroke.
test('every composer clear repaints the hint', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const clears = source.split("chatInput.value = '';").slice(1);
  assert.ok(clears.length >= 4, `expected the known clear sites, found ${clears.length}`);
  clears.forEach((tail, index) => {
    assert.match(tail.slice(0, 260), /IexaComposerHint\?\.refresh\?\.\(\)/,
      `clear site ${index + 1} does not refresh the hint`);
  });
});

test('real browser: the hint rotates and the composer mists near the limit', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-composer-hint-'));
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
    for (let index = 0; index < 140; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // Headless Chromium reports prefers-reduced-motion: reduce, which legitimately
  // turns the swap into an instant cut. Emulate a normal desktop so the motion
  // path is the one under test.
  await cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("!!window.IexaComposerHint && typeof currentSessionId !== 'undefined' && currentSessionId");

  // ---- the overlay owns the empty state ------------------------------------
  const initial = await evaluate(`(() => {
    const input = document.getElementById('chatInput');
    const hint = document.getElementById('composerHint');
    const active = hint.querySelector('.composer-hint-line.is-current');
    const inputBox = input.getBoundingClientRect();
    const hintBox = hint.getBoundingClientRect();
    return {
      marked: input.classList.contains('has-composer-hint'),
      hidden: hint.classList.contains('is-hidden'),
      text: active ? active.textContent : '',
      lines: hint.querySelectorAll('.composer-hint-line').length,
      transition: getComputedStyle(active).transitionDuration,
      placeholderColor: getComputedStyle(input, '::placeholder').color,
      alignLeft: Math.round(hintBox.left - inputBox.left),
      alignTop: Math.round(hintBox.top - inputBox.top),
      alignWidth: Math.round(hintBox.width - inputBox.width),
    };
  })()`);
  assert.equal(initial.marked, true, 'the textarea opts into the overlay');
  assert.equal(initial.hidden, false, 'an empty composer shows the hint');
  assert.equal(initial.lines, 2, 'two stacked lines carry the swap');
  assert.ok(initial.text.length > 0, 'a line is active');
  assert.equal(initial.transition, '0.32s, 0.32s', 'the swap is animated (transform and opacity)');
  assert.match(initial.placeholderColor, /rgba\(0, 0, 0, 0\)|transparent/, 'the native placeholder is hidden');
  assert.equal(initial.alignLeft, 0, 'the overlay starts at the textarea');
  assert.equal(initial.alignTop, 0, 'and shares its first line');
  assert.equal(initial.alignWidth, 0, 'and its width');

  // ---- it rotates ----------------------------------------------------------
  const first = initial.text;
  // Poll for the change instead of sleeping a fixed 2s: the outgoing line keeps
  // `.is-leaving` for only 380ms after the swap starts.
  await wait(`document.querySelector('#composerHint .composer-hint-line.is-current').textContent !== ${JSON.stringify(first)}`);
  const rotated = await evaluate(`(() => {
    const hint = document.getElementById('composerHint');
    const current = hint.querySelector('.composer-hint-line.is-current');
    const leaving = hint.querySelector('.composer-hint-line.is-leaving');
    return {
      text: current ? current.textContent : '',
      leavingText: leaving ? leaving.textContent : '',
      leavingTransform: leaving ? getComputedStyle(leaving).transform : 'none',
    };
  })()`);
  assert.notEqual(rotated.text, first, `the text rotated (still "${first}")`);
  assert.equal(rotated.leavingText, first, 'the outgoing line carries the previous text');
  assert.notEqual(rotated.leavingTransform, 'none', 'the outgoing line is moved, not cut');

  // ---- typing hides it -----------------------------------------------------
  await evaluate(`(() => {
    const input = document.getElementById('chatInput');
    input.value = '草稿';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait("document.getElementById('composerHint').classList.contains('is-hidden')");
  await evaluate(`(() => {
    const input = document.getElementById('chatInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait("!document.getElementById('composerHint').classList.contains('is-hidden')");

  // ---- a programmatic clear repaints on demand -----------------------------
  await evaluate(`(() => {
    const input = document.getElementById('chatInput');
    input.value = 'x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = '';
  })()`);
  await wait("document.getElementById('composerHint').classList.contains('is-hidden')");
  await evaluate("window.IexaComposerHint.refresh(); true");
  await wait("!document.getElementById('composerHint').classList.contains('is-hidden')");

  // ---- red mist near the compaction threshold ------------------------------
  await evaluate("handleContextStatus({ contextWindow: 200000, usedTokens: 130000, compactThreshold: 160000, state: 'ok' }); true");
  const warn = await evaluate(`(() => {
    const area = document.querySelector('.chat-input-area');
    const style = getComputedStyle(area);
    return {
      warn: area.classList.contains('is-context-warn'),
      critical: area.classList.contains('is-context-critical'),
      shadow: style.boxShadow,
      background: style.backgroundImage,
      border: style.borderTopColor,
    };
  })()`);
  assert.equal(warn.warn, true, '81% of the threshold starts the mist');
  assert.equal(warn.critical, false);
  assert.notEqual(warn.shadow, 'none', 'the haze is a real shadow');
  assert.match(warn.background, /radial-gradient/, 'and a soft wash inside the field');
  // Chromium serialises color-mix() as color(srgb 0.79 0.57 0.58); plain
  // colours come back as rgb(119, 119, 127). Normalise both to 0-255.
  const border = warn.border.match(/[-\d.]+/g).map(Number).slice(-3).map((n) => (n <= 1 ? n * 255 : n));
  assert.ok(border[0] - border[1] > 18 && border[0] - border[2] > 18,
    `the border picks up the warning tone (got ${warn.border})`);

  // The same reading feeds the rotation, so the entry must join it.
  await wait(`Array.from(document.querySelectorAll('#composerHint .composer-hint-line')).some((line) => /上下文已用 65%/.test(line.textContent))`);

  await evaluate("handleContextStatus({ contextWindow: 200000, usedTokens: 156000, compactThreshold: 160000, state: 'ok' }); true");
  const critical = await evaluate(`(() => {
    const area = document.querySelector('.chat-input-area');
    return {
      warn: area.classList.contains('is-context-warn'),
      critical: area.classList.contains('is-context-critical'),
      animation: getComputedStyle(area).animationDuration,
    };
  })()`);
  assert.equal(critical.critical, true, '97% of the threshold escalates');
  assert.equal(critical.warn, false, 'the two states are exclusive');
  assert.equal(critical.animation, '2.4s', 'the critical mist breathes faster');

  // ---- reset clears it -----------------------------------------------------
  await evaluate("resetContextStatus(); true");
  const cleared = await evaluate(`(() => {
    const area = document.querySelector('.chat-input-area');
    return { warn: area.classList.contains('is-context-warn'), critical: area.classList.contains('is-context-critical') };
  })()`);
  assert.deepEqual(cleared, { warn: false, critical: false }, 'a fresh session carries no mist');
});
