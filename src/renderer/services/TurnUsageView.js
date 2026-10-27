// Turn duration and usage — split out of app.js.
// Live turn timer, per-message usage receipt, context ring and the token usage page.
//
// Classic script: top-level declarations join the same global scope as
// app.js, so callers keep working unchanged. Keep this file free of load-time
// side effects — it evaluates before app.js and before the DOM is ready.

function formatTurnDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return total + ' ' + IexaI18n.t('duration.sec');
  if (total < 3600) {
    return Math.floor(total / 60) + ' ' + IexaI18n.t('duration.min') + ' ' + String(total % 60).padStart(2, '0') + ' ' + IexaI18n.t('duration.sec');
  }
  return Math.floor(total / 3600) + ' ' + IexaI18n.t('duration.hour') + ' ' + String(Math.floor((total % 3600) / 60)).padStart(2, '0') + ' ' + IexaI18n.t('duration.min') + ' ' + String(total % 60).padStart(2, '0') + ' ' + IexaI18n.t('duration.sec');
}

/**
 * Elapsed time for one assistant turn.
 *
 * A live turn keeps only its start stamp; the elapsed value is recomputed from
 * the clock so a backgrounded tab cannot drift. A finished turn records both
 * stamps, and a restored turn reads the duration the server persisted.
 */
function messageTurnDuration(messageEl) {
  if (!messageEl) return null;
  const stored = messageEl.dataset.durationMs;
  if (stored) {
    const value = Number(stored);
    if (Number.isFinite(value) && value >= 0) return { ms: value, running: false, startedAt: 0 };
  }
  const startedAt = Number(messageEl.dataset.turnStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const finishedAt = Number(messageEl.dataset.turnFinishedAt);
  const finished = Number.isFinite(finishedAt) && finishedAt > 0;
  return {
    ms: Math.max(0, (finished ? finishedAt : Date.now()) - startedAt),
    running: !finished,
    startedAt,
  };
}

function renderTurnDurationMarkup(duration) {
  const running = !!(duration && duration.running);
  return `<span class="message-usage-duration${running ? ' is-running' : ''}"${running ? ` data-started-at="${duration.startedAt}"` : ''} role="timer">` +
    `<em>${IexaI18n.t('usage.duration')}</em> <span class="message-usage-duration-value">${formatTurnDuration(duration.ms)}</span></span>`;
}

// One shared ticker; a turn only owns a single element, so the interval is
// started on demand and released as soon as nothing is running.
const liveTurnDurations = new Set();

let liveTurnDurationTimer = 0;

function registerLiveTurnDuration(node) {
  if (!node || !node.classList.contains('is-running')) return;
  liveTurnDurations.add(node);
  if (liveTurnDurationTimer) return;
  liveTurnDurationTimer = window.setInterval(tickLiveTurnDurations, 1000);
}

function unregisterLiveTurnDuration(node) {
  if (node) liveTurnDurations.delete(node);
  if (liveTurnDurations.size || !liveTurnDurationTimer) return;
  window.clearInterval(liveTurnDurationTimer);
  liveTurnDurationTimer = 0;
}

function tickLiveTurnDurations() {
  const now = Date.now();
  liveTurnDurations.forEach((node) => {
    const startedAt = Number(node.dataset.startedAt);
    if (!node.classList.contains('is-running') || !Number.isFinite(startedAt) || startedAt <= 0) {
      liveTurnDurations.delete(node);
      return;
    }
    const valueEl = node.querySelector('.message-usage-duration-value');
    if (valueEl) valueEl.textContent = formatTurnDuration(now - startedAt);
  });
  if (!liveTurnDurations.size && liveTurnDurationTimer) {
    window.clearInterval(liveTurnDurationTimer);
    liveTurnDurationTimer = 0;
  }
}

/** Freeze the live counter at completion; later re-renders read the final value. */
function freezeTurnDuration(messageEl) {
  if (!messageEl) return;
  const startedAt = Number(messageEl.dataset.turnStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return;
  if (Number(messageEl.dataset.turnFinishedAt) > 0) return;
  const finishedAt = Date.now();
  const elapsed = Math.max(0, finishedAt - startedAt);
  messageEl.dataset.turnFinishedAt = String(finishedAt);
  messageEl.dataset.durationMs = String(elapsed);
  const node = messageEl.querySelector('.message-usage-duration.is-running');
  if (!node) return;
  node.classList.remove('is-running');
  node.removeAttribute('data-started-at');
  unregisterLiveTurnDuration(node);
  const valueEl = node.querySelector('.message-usage-duration-value');
  if (valueEl) valueEl.textContent = formatTurnDuration(elapsed);
}

function ensureMessageUsage(messageEl) {
  if (!messageEl) return null;
  let usageEl = messageEl.querySelector('.message-usage');
  if (!usageEl) {
    usageEl = document.createElement('div');
    usageEl.className = 'message-usage';
    const footer = messageEl.querySelector('.assistant-message-footer');
    const actions = messageEl.querySelector('.assistant-message-actions');
    if (footer && actions) footer.insertBefore(usageEl, actions); else messageEl.appendChild(usageEl);
  }
  return usageEl;
}

function renderMessageUsage(usageEl, inputTokens, outputTokens, cacheReadTokens, options) {
  // `pending` is the first paint of a turn: the model has not reported tokens
  // yet, so only the live elapsed counter is shown.
  const pending = !!(options && options.pending);
  const input = Number(inputTokens) || 0;
  const output = Number(outputTokens) || 0;
  const cacheRead = Number(cacheReadTokens);
  const messageEl = usageEl.closest('.message.assistant');
  const duration = messageTurnDuration(messageEl);
  // The previous running element is about to be replaced; drop it from the
  // ticker first or the interval would keep writing into a detached node.
  const previous = usageEl.querySelector('.message-usage-duration.is-running');
  if (previous) unregisterLiveTurnDuration(previous);
  const parts = [];
  if (!pending) {
    parts.push(`<svg class="message-usage-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="12" width="3" height="7" rx="1" stroke="currentColor" stroke-width="1.7"/>
      <rect x="10.5" y="8" width="3" height="11" rx="1" stroke="currentColor" stroke-width="1.7"/>
      <rect x="17" y="4" width="3" height="15" rx="1" stroke="currentColor" stroke-width="1.7"/>
    </svg>`);
    parts.push(`<span title="${IexaI18n.t('usage.inputTitle', { count: input.toLocaleString() })}">${formatTokenCount(input)} <em>${IexaI18n.t('usage.inputShort')}</em></span>`);
    parts.push('<i aria-hidden="true"></i>');
    parts.push(`<span title="${IexaI18n.t('usage.outputTitle', { count: output.toLocaleString() })}">${formatTokenCount(output)} <em>${IexaI18n.t('usage.outputShort')}</em></span>`);
    if (cacheReadTokens !== undefined && cacheReadTokens !== null && Number.isFinite(cacheRead)) {
      parts.push('<i aria-hidden="true"></i>');
      const cache = Math.max(0, Math.round(cacheRead));
      // Share of the prompt that came from cache. input already contains the
      // cached span, so this is a plain ratio - the same reading providers give.
      const share = input > 0 ? Math.round(Math.min(1, cache / input) * 100) : 0;
      parts.push(`<span class="message-usage-cache" title="${IexaI18n.t('usage.cacheTitle', { count: cache.toLocaleString(), share })}">${formatTokenCount(cache)} <em>${IexaI18n.t('usage.cacheShort')}</em> <span class="message-usage-cache-share">(${share}%)</span></span>`);
    }
    // Streaming rate, measured inside provider streams only: tool runs, approval
    // waits and user pauses are not generation time.
    // Version 1 divided output by the whole stream, prefill included, so those
    // records cannot produce an honest rate; they show none.
    const rateVersion = Number(messageEl && messageEl.dataset.generationRateVersion);
    const generationMs = Number(messageEl && messageEl.dataset.generationMs);
    const firstTokenMs = Number(messageEl && messageEl.dataset.firstTokenMs);
    if (rateVersion === 2 && output > 0 && Number.isFinite(generationMs) && generationMs >= 500) {
      const rate = output / (generationMs / 1000);
      if (rate >= 0.05) {
        const text = rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
        const prefill = Number.isFinite(firstTokenMs) && firstTokenMs > 0
          ? IexaI18n.t('usage.prefill', { seconds: (firstTokenMs / 1000).toFixed(1) })
          : '';
        parts.push('<i aria-hidden="true"></i>');
        parts.push(`<span class="message-usage-rate" title="${IexaI18n.t('usage.rateTitle', { count: output.toLocaleString(), seconds: (generationMs / 1000).toFixed(1), prefill })}">${text} tok/s</span>`);
      }
    }
  }
  if (duration) {
    if (parts.length) parts.push('<i aria-hidden="true"></i>');
    parts.push(renderTurnDurationMarkup(duration));
  }
  const timestamp = Number(messageEl && messageEl.dataset.timestamp);
  const timeText = formatMessageTimestamp(timestamp);
  if (timeText) {
    parts.push(`<time class="message-usage-time" datetime="${new Date(timestamp).toISOString()}" title="${IexaI18n.t('usage.generatedAt', { time: new Date(timestamp).toLocaleString() })}">${timeText}</time>`);
  }
  usageEl.innerHTML = parts.join('');
  if (duration && duration.running) registerLiveTurnDuration(usageEl.querySelector('.message-usage-duration'));
}

function formatContextTokens(tokens) {
  return formatTokenCount(tokens);
}

/** Last known request size per session; a reopen repaints from it. */
const contextStatusBySession = new Map();

function resetContextStatus() {
  if (!contextProgress || !contextProgressValue || !contextProgressTooltip) return;
  contextProgress.dataset.state = 'ok';
  contextProgressValue.style.strokeDasharray = '0 100';
  const percentLabel = document.getElementById('contextProgressPercent');
  if (percentLabel) percentLabel.textContent = '0%';
  const detail = IexaI18n.t('context.noRequests');
  contextProgress.title = detail;
  contextProgressTooltip.textContent = detail;
  window.IexaComposerHint?.setContextPressure?.(null);
}

/**
 * Paint the carried status for the session the user just opened, so a restart
 * continues the conversation's context instead of showing a fresh one.
 *
 * `context` undefined means "no new information" (cached runtime switch);
 * `null` means the server reports no accounting for this session and the
 * renderer's copy must be dropped.
 */
function applySessionContextStatus(sessionId, context) {
  const provided = context !== undefined;
  if (sessionId && provided) {
    if (context) contextStatusBySession.set(sessionId, context);
    else contextStatusBySession.delete(sessionId);
  }
  const known = (provided ? context : null) || (sessionId ? contextStatusBySession.get(sessionId) : null);
  if (!known) { resetContextStatus(); return; }
  if (sessionId) contextStatusBySession.set(sessionId, known);
  handleContextStatus(known, sessionId);
}

function handleContextStatus(context, sessionId) {
  if (!context || !contextProgress || !contextProgressValue || !contextProgressTooltip) return;
  const owner = sessionId || currentSessionId;
  if (owner) contextStatusBySession.set(owner, context);
  // Background task pressure belongs to its own runtime. Do not repaint the
  // selected conversation's context ring on every foreign SSE event, and do
  // not let a background session become the value a later switch re-applies.
  if (currentSessionId !== visibleSessionId) return;
  if (owner && owner !== visibleSessionId) return;
  latestContextStatus = context;
  const windowTokens = Math.max(1, Number(context.contextWindow) || 128000);
  const usedTokens = Math.max(0, Number(context.usedTokens) || 0);
  const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
  const state = context.state || 'ok';
  contextProgress.dataset.state = state;
  contextProgressValue.style.strokeDasharray = percent + ' 100';
  const percentLabel = document.getElementById('contextProgressPercent');
  if (percentLabel) percentLabel.textContent = percent + '%';
  const source = context.estimated ? IexaI18n.t('context.estimated') : IexaI18n.t('context.measured');
  const thresholdTokens = Math.max(1, Number(context.compactThreshold) || Math.round(windowTokens * 0.8));
  const thresholdPercent = Math.min(100, Math.round((thresholdTokens / windowTokens) * 100));
  let statusText = state === 'compacting' ? IexaI18n.t('context.compacting') :
    state === 'compacted' ? IexaI18n.t('context.compacted') :
    state === 'near-limit' ? IexaI18n.t('context.nearLimit') :
    state === 'exhausted' ? IexaI18n.t('context.exhausted') : IexaI18n.t('context.usage');
  const detail = IexaI18n.t('context.detail', {
    status: statusText,
    used: formatContextTokens(usedTokens),
    total: formatContextTokens(windowTokens),
    percent,
    source,
    threshold: thresholdPercent,
  });
  contextProgress.title = detail;
  contextProgressTooltip.textContent = detail;
  // The composer mists as this percentage approaches the threshold percentage,
  // so the ring the user is reading and the field agree.
  window.IexaComposerHint?.setContextPressure?.(usedTokens, thresholdTokens, state, windowTokens);
}

function formatTokenCount(value) {
  const n = Math.max(0, Number(value) || 0);
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  // Pick the unit after rounding, so 999,999 renders as 1M rather than 1000K.
  const k = n / 1000;
  if (k < 999.5) return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'K';
  const m = n / 1e6;
  if (m < 999.5) return (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : String(Math.round(m))) + 'M';
  const b = n / 1e9;
  return (b < 10 ? b.toFixed(1).replace(/\.0$/, '') : String(Math.round(b))) + 'B';
}

// Kept as the name the token page and its tests already use.
function formatUsageNumber(value) {
  return formatTokenCount(value);
}

function formatEstimatedCost(value) {
  if (value === null || value === undefined || value === '') return IexaI18n.t('cost.notConfigured');
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) return IexaI18n.t('cost.notConfigured');
  if (cost === 0) return '$0.00';
  if (cost < 1e-8) return `$${cost.toExponential(2)}`;
  const digits = cost < 0.0001 ? Math.min(12, Math.max(8, -Math.floor(Math.log10(cost)) + 4)) : cost < 0.01 ? 6 : 2;
  return `$${cost.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// 缓存占输入侧（输入 + 缓存）token 的比例：≥10% 取整，<10% 保留一位小数。
function formatUsagePercent(part, whole) {
  const value = Math.max(0, Number(part) || 0);
  const base = Math.max(0, Number(whole) || 0);
  if (base <= 0 || value <= 0) return '0%';
  const pct = (value / base) * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}
