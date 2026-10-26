// Codex-style turn settling: once a turn ends, every activity block it produced
// (reasoning blocks and tool rails) folds behind one "用时 …" line, and the
// answer stands alone in the transcript. Nothing changes while the turn runs —
// the tools, the live sweep and the running indicators are the point of the
// turn. Expanding restores the original blocks untouched, with their own
// per-rail bars and per-block states intact.

const TURN_ACTIVITY_SELECTOR = '.thinking-block, .tool-steps';
const TURN_TEXT_SELECTOR = '.message-content';
const TURN_SETTLE_KEY = 'iexa-settle-turns';

/** Default on: a finished turn should read as one line plus its answer. */
function turnSettleEnabled() {
  const attr = document.documentElement.getAttribute('data-settle-turns');
  if (attr === 'on') return true;
  if (attr === 'off') return false;
  try { return localStorage.getItem(TURN_SETTLE_KEY) !== 'off'; } catch { return true; }
}

/**
 * Activity nodes owned by this message (never a nested message's).
 *
 * Working commentary counts as activity too. A turn that narrates, calls a tool,
 * narrates again and only then answers used to leave every narration paragraph
 * in the transcript after settling — the reader saw the summary line, then a wall
 * of "我先看一下…" before reaching the actual reply. Every answer block except
 * the last one is commentary: the last block is what the turn is delivering.
 */
function turnActivityOf(messageEl) {
  if (!messageEl) return [];
  const own = (node) => node.closest('.message') === messageEl;
  const blocks = [...messageEl.querySelectorAll(TURN_ACTIVITY_SELECTOR)].filter(own);
  const texts = [...messageEl.querySelectorAll(TURN_TEXT_SELECTOR)].filter(own);
  // No reasoning and no tools: this is a plain answer, and folding it would hide
  // the only thing the turn produced.
  if (!blocks.length) return [];
  const narration = texts.slice(0, Math.max(0, texts.length - 1));
  return [...blocks, ...narration].sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

function turnActivityStats(messageEl) {
  const nodes = turnActivityOf(messageEl);
  let calls = 0;
  let failed = 0;
  for (const node of nodes) {
    if (!node.classList.contains('tool-steps')) continue;
    for (const child of node.children) {
      if (!child.classList || !child.classList.contains('tool-block')) continue;
      calls += 1;
      if (child.classList.contains('is-error')) failed += 1;
    }
  }
  return { blocks: nodes.length, calls, failed };
}

function createTurnSummaryBar() {
  const bar = document.createElement('button');
  bar.type = 'button';
  bar.className = 'turn-summary';
  bar.setAttribute('aria-expanded', 'true');
  bar.innerHTML =
    '<span class="turn-summary-label">用时</span>' +
    '<span class="turn-summary-time">0 秒</span>' +
    '<span class="turn-summary-count"></span>' +
    '<span class="turn-summary-errors"></span>' +
    '<span class="turn-summary-chevron" aria-hidden="true"></span>';
  bar.addEventListener('click', () => toggleTurnActivity(bar.closest('.message')));
  return bar;
}

/** Repaint the bar's numbers from the message it belongs to. */
function refreshTurnSummary(messageEl) {
  if (!messageEl) return;
  const bar = messageEl.querySelector('.turn-summary');
  if (!bar) return;
  const stats = turnActivityStats(messageEl);
  const duration = typeof messageTurnDuration === 'function' ? messageTurnDuration(messageEl) : null;
  const labelEl = bar.querySelector('.turn-summary-label');
  const timeEl = bar.querySelector('.turn-summary-time');
  const hasTime = !!(duration && Number.isFinite(duration.ms) && duration.ms >= 0);
  if (labelEl) labelEl.textContent = hasTime ? '用时' : '过程';
  if (timeEl) {
    timeEl.hidden = !hasTime;
    if (hasTime) {
      timeEl.textContent = typeof formatTurnDuration === 'function'
        ? formatTurnDuration(duration.ms)
        : Math.round(duration.ms / 1000) + ' 秒';
    }
  }
  const countEl = bar.querySelector('.turn-summary-count');
  if (countEl) countEl.textContent = stats.calls ? stats.calls + ' 次调用' : '';
  const errorEl = bar.querySelector('.turn-summary-errors');
  if (errorEl) errorEl.textContent = stats.failed ? stats.failed + ' 个报错' : '';
  bar.classList.toggle('has-errors', stats.failed > 0);
}

function setTurnActivityCollapsed(messageEl, collapsed) {
  if (!messageEl) return false;
  const bar = messageEl.querySelector('.turn-summary');
  if (!bar) return false;
  liftToolArtifacts(messageEl);
  for (const node of turnActivityOf(messageEl)) {
    node.classList.toggle('turn-activity-hidden', collapsed);
  }
  messageEl.classList.add('is-activity-settled');
  messageEl.classList.toggle('is-activity-collapsed', collapsed);
  bar.setAttribute('aria-expanded', String(!collapsed));
  bar.title = collapsed ? '展开本轮的思考与工具调用' : '收起本轮的思考与工具调用';
  return collapsed;
}

/**
 * Fold a finished turn. Idempotent: a rebuilt message reuses the existing bar,
 * so replay can call this without caring whether it ran before.
 */
/**
 * A picture the model showed is a deliverable, not activity.
 *
 * The card is created as a child of the tool rail (`renderToolArtifactsAfterStep`
 * inserts it beside the step), so folding the rail took the image with it: the
 * final summary could never show a picture. Lift each card to sit beside its rail
 * before anything folds. Idempotent, so replay can call it on every settle.
 */
function liftToolArtifacts(messageEl) {
  if (!messageEl) return;
  const own = (node) => node.closest('.message') === messageEl;
  for (const rail of [...messageEl.querySelectorAll('.tool-steps')].filter(own)) {
    const cards = [...rail.children].filter((child) => child.classList && child.classList.contains('tool-artifacts'));
    if (!cards.length) continue;
    // One fragment keeps the cards in their original order after the rail.
    const fragment = document.createDocumentFragment();
    for (const card of cards) fragment.appendChild(card);
    rail.after(fragment);
  }
}

function settleTurnActivity(messageEl) {
  if (!messageEl || !turnSettleEnabled()) return false;
  liftToolArtifacts(messageEl);
  const nodes = turnActivityOf(messageEl);
  if (!nodes.length) return false;
  let bar = messageEl.querySelector('.turn-summary');
  if (!bar) {
    bar = createTurnSummaryBar();
    nodes[0].before(bar);
  }
  // Reasoning stays closed, so an expanded turn reads as a list of steps rather
  // than one wall of text followed by capsules.
  for (const node of nodes) {
    if (node.classList.contains('thinking-block')) node.open = false;
  }
  refreshTurnSummary(messageEl);
  // A reader who opened the chain by hand while the turn ran keeps it open; the
  // bar still carries the time, so nothing is hidden from them.
  const openedByHand = [...messageEl.querySelectorAll('.tool-steps > .task-summary')]
    .some((summary) => summary.dataset.userExpanded === 'true');
  return setTurnActivityCollapsed(messageEl, !openedByHand);
}

function expandTurnActivity(messageEl) { return setTurnActivityCollapsed(messageEl, false); }
function collapseTurnActivity(messageEl) { return setTurnActivityCollapsed(messageEl, true); }

function toggleTurnActivity(messageEl) {
  if (!messageEl) return false;
  return setTurnActivityCollapsed(messageEl, !messageEl.classList.contains('is-activity-collapsed'));
}

(() => {
  window.IexaTurnSummary = Object.freeze({
    settle: settleTurnActivity,
    expand: expandTurnActivity,
    collapse: collapseTurnActivity,
    toggle: toggleTurnActivity,
    refresh: refreshTurnSummary,
    isEnabled: turnSettleEnabled,
    setEnabled(enabled) {
      document.documentElement.setAttribute('data-settle-turns', enabled ? 'on' : 'off');
      try { localStorage.setItem(TURN_SETTLE_KEY, enabled ? 'on' : 'off'); } catch { /* this window still applies it */ }
      if (enabled) document.querySelectorAll('.message').forEach((el) => settleTurnActivity(el));
      else document.querySelectorAll('.message.is-activity-settled').forEach((el) => expandTurnActivity(el));
    },
  });
})();
