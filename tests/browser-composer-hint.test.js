// The composer's empty state rotates through live facts, and the composer turns
// into a red mist as the request approaches its compaction threshold. Both are
// driven from the same context reading as the ring, so they cannot disagree.
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
  assert.equal(initial.transition, '0.32s, 0.26s', 'the swap is animated (transform, then a delayed fade)');
  assert.match(initial.placeholderColor, /rgba\(0, 0, 0, 0\)|transparent/, 'the native placeholder is hidden');
  assert.equal(initial.alignLeft, 0, 'the overlay starts at the textarea');
  assert.equal(initial.alignTop, 0, 'and shares its first line');
  assert.equal(initial.alignWidth, 0, 'and its width');

  // ---- it rotates while a turn runs ---------------------------------------
  await evaluate('setProcessing(true); true');
  const first = await evaluate("document.querySelector('#composerHint .composer-hint-line.is-current').textContent");
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
  await evaluate('setProcessing(false); true');

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

  // ---- shortcut tips replace the static hints while a turn runs ------------
  const idleEntries = await evaluate('composerHintEntries()');
  assert.ok(idleEntries.includes('有问题，随便问'), 'an idle composer keeps the plain invitation');
  assert.ok(!idleEntries.some((entry) => entry.includes('Ctrl+K')), 'and shows no shortcuts');

  await evaluate('setProcessing(true); true');
  const busyEntries = await evaluate('composerHintEntries()');
  assert.ok(busyEntries.includes('Ctrl+K 打开命令面板'), 'a running turn teaches the palette');
  assert.ok(busyEntries.some((entry) => /^Ctrl\+Shift\+Enter 本条改为(排队|立即插入)$/.test(entry)),
    'and the follow-up modifier, in the setting\'s own words');
  assert.ok(busyEntries.includes('Esc 停止当前任务'), 'and how to stop');
  assert.ok(!busyEntries.includes('有问题，随便问'), 'the invitation is replaced, not appended');
  await wait(`Array.from(document.querySelectorAll('#composerHint .composer-hint-line')).some((line) => /Ctrl\\+|Esc /.test(line.textContent))`);
  // The live reading joins the rotation only while a turn runs.
  await evaluate("handleContextStatus({ contextWindow: 200000, usedTokens: 152000, compactThreshold: 160000, state: 'ok' }); true");
  await wait(`Array.from(document.querySelectorAll('#composerHint .composer-hint-line')).some((line) => /上下文已用 76%/.test(line.textContent))`);

  await evaluate('setProcessing(false); true');
  const restoredEntries = await evaluate('composerHintEntries()');
  assert.ok(restoredEntries.includes('有问题，随便问'), 'the invitation comes back when the turn ends');
  assert.ok(!restoredEntries.some((entry) => entry.includes('Ctrl+K')), 'and the shortcuts leave');

  // ---- idle is one static line, not a rotation ----------------------------
  await evaluate("setProcessing(false); true");
  assert.deepEqual(await evaluate("composerHintEntries()"), ['有问题，随便问'],
    'an idle composer shows the invitation only');
  const idleLine = await evaluate("document.querySelector('#composerHint .composer-hint-line.is-current').textContent");
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal(await evaluate("document.querySelector('#composerHint .composer-hint-line.is-current').textContent"), idleLine,
    'and it does not rotate while nothing is running');

  // A turn in another conversation is not this composer's business.
  await evaluate("runtimeForSession('another-conversation').isProcessing = true; window.IexaComposerHint.refresh(); true");
  assert.deepEqual(await evaluate("composerHintEntries()"), ['有问题，随便问'],
    'a background turn must not flip the visible tips');
  // The swap in and out of a background session happens on every SSE event.
  // Replaying it must not repaint (or animate) the visible line.
  const before = await evaluate(`(() => {
    const line = document.querySelector('#composerHint .composer-hint-line.is-current');
    return { text: line.textContent, html: document.getElementById('composerHint').innerHTML };
  })()`);
  await evaluate(`(() => {
    const id = currentSessionId;
    for (let i = 0; i < 6; i += 1) {
      applySessionRuntime('another-conversation');
      applySessionRuntime(id);
    }
  })()`);
  const after = await evaluate(`(() => {
    const line = document.querySelector('#composerHint .composer-hint-line.is-current');
    return { text: line.textContent, html: document.getElementById('composerHint').innerHTML,
      leaving: !!document.querySelector('#composerHint .composer-hint-line.is-leaving') };
  })()`);
  assert.equal(after.text, before.text, 'the visible line did not change');
  assert.equal(after.leaving, false, 'and no swap animation was started');
  assert.equal(after.html, before.html, 'the overlay was not rebuilt');
  await evaluate("runtimeForSession('another-conversation').isProcessing = false; true");

  // ---- saving the trigger moves the ring, not just the panel --------------
  await evaluate("handleContextStatus({ contextWindow: 200000, usedTokens: 100000, compactThreshold: 160000, state: 'ok' }); true");
  assert.match(await evaluate("document.getElementById('contextProgressTooltip').textContent"), /自动压缩阈值 80%/);
  await evaluate("document.querySelector('.cc-chip[data-threshold=\"90\"]').click(); true");
  await wait(`/自动压缩阈值 90%/.test(document.getElementById('contextProgressTooltip').textContent)`);
  assert.match(await evaluate("document.getElementById('contextCompactionThresholdConfirm').textContent"), /已保存/,
    'the button confirms the save instead of staying silent');

  // ---- red mist near the compaction threshold ------------------------------
  // 65% of the window with an 80% threshold is five points away from the mist
  // band: this is the regression the screenshot reported ("70% and already red").
  await evaluate("handleContextStatus({ contextWindow: 200000, usedTokens: 130000, compactThreshold: 160000, state: 'ok' }); true");
  const early = await evaluate(`(() => {
    const area = document.querySelector('.chat-input-area');
    return { warn: area.classList.contains('is-context-warn'), critical: area.classList.contains('is-context-critical') };
  })()`);
  assert.deepEqual(early, { warn: false, critical: false },
    '65% of the window stays calm; the mist waits for the threshold band');

  // 76% of the window is four points from an 80% threshold: that is the band.
  await evaluate("handleContextStatus({ contextWindow: 200000, usedTokens: 152000, compactThreshold: 160000, state: 'ok' }); true");
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
  assert.equal(warn.warn, true, '76% of the window starts the mist');
  assert.equal(warn.critical, false);
  assert.notEqual(warn.shadow, 'none', 'the haze is a real shadow');
  assert.match(warn.background, /radial-gradient/, 'and a soft wash inside the field');
  // Chromium serialises color-mix() as color(srgb 0.79 0.57 0.58); plain
  // colours come back as rgb(119, 119, 127). Normalise both to 0-255.
  const border = warn.border.match(/[-\d.]+/g).map(Number).slice(-3).map((n) => (n <= 1 ? n * 255 : n));
  assert.ok(border[0] - border[1] > 18 && border[0] - border[2] > 18,
    `the border picks up the warning tone (got ${warn.border})`);

  // The same reading feeds the rotation, so the entry must join it while busy.
  await evaluate("setProcessing(true); true");
  await wait(`Array.from(document.querySelectorAll('#composerHint .composer-hint-line')).some((line) => /上下文已用 76%/.test(line.textContent))`);
  await evaluate("setProcessing(false); true");

  await evaluate("handleContextStatus({ contextWindow: 200000, usedTokens: 159000, compactThreshold: 160000, state: 'ok' }); true");
  const critical = await evaluate(`(() => {
    const area = document.querySelector('.chat-input-area');
    return {
      warn: area.classList.contains('is-context-warn'),
      critical: area.classList.contains('is-context-critical'),
      animation: getComputedStyle(area).animationDuration,
    };
  })()`);
  assert.equal(critical.critical, true, '79.5% of the window escalates: half a point from the threshold');
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
