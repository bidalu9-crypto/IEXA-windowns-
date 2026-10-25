// =============================================================================
// Composer hint
//
// The native placeholder cannot animate, so an overlay carries the text and the
// native one is made transparent. The rotation mixes the live context usage,
// the selected site's balance and either the static hints (idle) or the shortcut
// tips (while a turn runs); as the context approaches its compaction threshold
// the composer itself turns into a red mist.
//
// Classic script: declarations only, wiring happens in initComposerHint().
// =============================================================================
const COMPOSER_HINT_INTERVAL = 2000;
const COMPOSER_HINT_SWAP_MS = 380;
const COMPOSER_HINT_STATIC = ['有问题，随便问', '输入 / 查看命令'];
// Only while a turn is running: with an idle composer Esc does nothing and the
// follow-up modifier has nothing to interrupt, so these would be lies.
const COMPOSER_HINT_SHORTCUTS = [
  () => `Ctrl+Shift+Enter 本条改为${composerHintFollowUpLabel()}`,
  () => '输入 / 打开技能与命令',
  () => 'Ctrl+K 打开命令面板',
  () => 'Esc 停止当前任务',
  () => 'Ctrl+Shift+S 截图标注',
];
const composerHintState = {
  input: null,
  hint: null,
  lines: [],
  active: 0,
  index: 0,
  timer: 0,
  swapTimer: 0,
  composing: false,
  lastText: '',
  signature: '',
  started: false,
};

function composerHintReducedMotion() {
  if (document.documentElement.dataset.motion === 'reduced') return true;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Context pressure, phrased the way the ring tooltip phrases it. */
function composerHintContextEntry() {
  try {
    if (typeof contextStatusBySession === 'undefined') return '';
    const sessionId = typeof currentSessionId === 'string' ? currentSessionId : '';
    if (!sessionId) return '';
    const context = contextStatusBySession.get(sessionId);
    if (!context) return '';
    const used = Math.max(0, Number(context.usedTokens) || 0);
    const windowTokens = Math.max(1, Number(context.contextWindow) || 128000);
    if (used <= 0) return '';
    return `上下文已用 ${Math.min(100, Math.round((used / windowTokens) * 100))}%`;
  } catch { return ''; }
}

/** The balance chip's value, if the selected profile reports one. */
function composerHintBalanceEntry() {
  try {
    if (typeof balanceView === 'undefined' || typeof formatBalanceMoney !== 'function') return '';
    const data = balanceView.data;
    if (!data || data.status !== 'ok') return '';
    const remaining = Number(data.remaining);
    if (!Number.isFinite(remaining)) return '';
    return `当前站点余额 ${formatBalanceMoney(remaining, data.currency)}`;
  } catch { return ''; }
}

/** Recomputed on every tick: the context and the balance both move. */
function composerHintEntries() {
  const entries = [];
  const context = composerHintContextEntry();
  if (context) entries.push(context);
  const balance = composerHintBalanceEntry();
  if (composerHintBusy()) {
    if (balance) entries.push(balance);
    COMPOSER_HINT_SHORTCUTS.forEach((entry) => entries.push(entry()));
    return entries;
  }
  entries.push(COMPOSER_HINT_STATIC[0]);
  if (balance) entries.push(balance);
  entries.push(COMPOSER_HINT_STATIC[1]);
  return entries;
}

/** `isProcessing` lives in app.js; the overlay only reads it. */
function composerHintBusy() {
  try { return typeof isProcessing !== 'undefined' && !!isProcessing; } catch { return false; }
}

/** What Ctrl/Cmd+Shift+Enter would do right now, in the setting's own words. */
function composerHintFollowUpLabel() {
  try {
    if (typeof followUpMode === 'undefined') return '排队';
    return followUpMode === 'queue' ? '立即插入' : '排队';
  } catch { return '排队'; }
}

/** Pin the overlay to the textarea's first line; it grows with the content. */
function positionComposerHint() {
  const { input, hint } = composerHintState;
  if (!input || !hint) return;
  const wrapper = input.parentElement;
  if (!wrapper) return;
  const outer = wrapper.getBoundingClientRect();
  const inner = input.getBoundingClientRect();
  hint.style.left = (inner.left - outer.left) + 'px';
  hint.style.top = (inner.top - outer.top) + 'px';
  hint.style.width = inner.width + 'px';
  hint.style.height = Math.max(20, Math.min(inner.height, 34)) + 'px';
}

function paintComposerHint(text, animate) {
  const { lines } = composerHintState;
  const value = String(text || '');
  if (!lines.length || value === composerHintState.lastText) return;
  composerHintState.lastText = value;
  const current = lines[composerHintState.active];
  const next = lines[1 - composerHintState.active];
  next.textContent = value;
  const instant = !animate || !current.textContent || composerHintReducedMotion();
  if (instant) {
    current.classList.remove('is-current', 'is-leaving');
    next.classList.remove('is-leaving');
    next.classList.add('is-current');
  } else {
    // Park the incoming line below before promoting it, so the transition runs
    // instead of jumping.
    next.classList.remove('is-current', 'is-leaving');
    void next.offsetWidth;
    current.classList.remove('is-current');
    current.classList.add('is-leaving');
    next.classList.add('is-current');
    clearTimeout(composerHintState.swapTimer);
    composerHintState.swapTimer = setTimeout(() => current.classList.remove('is-leaving'), COMPOSER_HINT_SWAP_MS);
  }
  composerHintState.active = 1 - composerHintState.active;
}

function rotateComposerHint() {
  const entries = composerHintEntries();
  if (!entries.length) return;
  if (entries.length === 1) { paintComposerHint(entries[0], false); return; }
  composerHintState.index = (composerHintState.index + 1) % entries.length;
  paintComposerHint(entries[composerHintState.index], true);
}

function stopComposerHintRotation() {
  if (composerHintState.timer) clearInterval(composerHintState.timer);
  composerHintState.timer = 0;
}

function startComposerHintRotation() {
  stopComposerHintRotation();
  const entries = composerHintEntries();
  composerHintState.signature = entries.join('\u0000');
  if (!entries.length) return;
  composerHintState.index = Math.min(composerHintState.index, entries.length - 1);
  paintComposerHint(entries[composerHintState.index], false);
  if (entries.length < 2) return;
  composerHintState.timer = setInterval(rotateComposerHint, COMPOSER_HINT_INTERVAL);
}

/** Visible only for an empty, enabled, non-composing composer. */
function syncComposerHintVisibility() {
  const { input, hint } = composerHintState;
  if (!input || !hint) return;
  const empty = !input.value.trim();
  const show = empty && !composerHintState.composing && !input.disabled;
  hint.classList.toggle('is-hidden', !show);
  if (!show) { stopComposerHintRotation(); return; }
  positionComposerHint();
  // Context and balance arrive asynchronously. Re-seed only when the list of
  // entries actually changed, so an in-flight rotation is never restarted by a
  // routine status refresh.
  const signature = composerHintEntries().join('\u0000');
  if (!composerHintState.timer || signature !== composerHintState.signature) startComposerHintRotation();
}

/**
 * Paint the red mist while the request approaches the compaction threshold.
 * `null` clears it. Called from the context ring's own update path so the two
 * readings can never disagree.
 */
function setComposerContextPressure(usedTokens, thresholdTokens, state) {
  const area = document.querySelector('.chat-input-area');
  if (!area) return;
  const used = Number(usedTokens);
  const threshold = Number(thresholdTokens);
  if (!Number.isFinite(used) || !Number.isFinite(threshold) || threshold <= 0) {
    area.classList.remove('is-context-warn', 'is-context-critical');
    syncComposerHintVisibility();
    return;
  }
  const ratio = used / threshold;
  const critical = state === 'compacting' || state === 'exhausted' || ratio >= 0.95;
  const warn = critical || state === 'near-limit' || ratio >= 0.75;
  area.classList.toggle('is-context-warn', warn && !critical);
  area.classList.toggle('is-context-critical', critical);
  // The percentage in the rotation just moved; let the overlay catch up.
  syncComposerHintVisibility();
}

function initComposerHint() {
  if (composerHintState.started) return;
  const input = document.getElementById('chatInput');
  const hint = document.getElementById('composerHint');
  if (!input || !hint) return;
  composerHintState.started = true;
  composerHintState.input = input;
  composerHintState.hint = hint;
  composerHintState.lines = Array.from(hint.querySelectorAll('.composer-hint-line'));
  if (!composerHintState.lines.length) return;

  input.classList.add('has-composer-hint');
  input.addEventListener('input', syncComposerHintVisibility);
  input.addEventListener('compositionstart', () => { composerHintState.composing = true; syncComposerHintVisibility(); });
  input.addEventListener('compositionend', () => { composerHintState.composing = false; syncComposerHintVisibility(); });
  window.addEventListener('resize', () => {
    if (!hint.classList.contains('is-hidden')) positionComposerHint();
  });
  // The textarea grows as the draft wraps; keep the overlay on its first line.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!hint.classList.contains('is-hidden')) positionComposerHint();
    }).observe(input);
  }

  syncComposerHintVisibility();
  window.IexaComposerHint = Object.freeze({
    refresh: syncComposerHintVisibility,
    setContextPressure: setComposerContextPressure,
  });
}
