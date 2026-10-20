// =============================================================================
// IEXA PC - Frontend Application
// Handles chat UI, SSE streaming, tool display, and settings
// =============================================================================

const API_BASE = '';

// Shared application UI icons. The SVG symbols live in index.html; this helper
// keeps dynamic UI free from emoji fonts and consistent with static controls.
function uiIcon(name, label = '') {
  const safeName = String(name || 'info').replace(/[^a-z0-9-]/gi, '');
  const safeLabel = escapeHtml ? escapeHtml(label) : String(label || '');
  return `<svg class="ui-icon ui-icon-${safeName}" focusable="false"${label ? ` role="img" aria-label="${safeLabel}"` : ' aria-hidden="true"'}><use href="#ui-${safeName}"></use></svg>`;
}

// =============================================================================
// Markdown + code highlighting
// =============================================================================
const renderSafeMarkdown = window.SafeMarkdown.renderSafeMarkdown;

// Trusted UI templates use data actions; SafeMarkdown strips all data-* attributes.
// Capture preserves the former stopPropagation behavior on nested cards/downloads.
const rendererActions = Object.freeze({
  sendQuick: (value) => sendQuick(value),
  refreshModelSelector: () => refreshModelSelector(),
  showProfileEditor: () => showProfileEditor(),
  fetchModels: () => fetchModels(),
  saveProfile: () => saveProfile(),
  hideProfileEditor: () => hideProfileEditor(),
  saveWebDAVConfig: () => saveWebDAVConfig(),
  testWebDAV: () => testWebDAV(),
  syncNow: () => syncNow(),
  switchSession: (value) => switchSession(value),
  openSearchHit: (value) => openSearchHit(value),
  startRename: (value) => startRename(value),
  deleteSession: (value) => deleteSession(value),
  archiveSession: (value) => setSessionArchived(value, true),
  toggleSessionPin: (value) => toggleSessionPin(value),
  toggleToolBody: (value) => toggleToolBody(value),
  removeAttachment: (value) => removeAttachment(value),
  activateProfile: (value) => activateProfile(value),
  editProfile: (value) => editProfile(value),
  deleteProfile: (value) => deleteProfile(value),
  deleteTokenUsage: (value) => deleteTokenUsage(value),
  clearTokenUsage: () => clearTokenUsage(),
  rewindCheckpoint: (value) => rewindCheckpoint(value),
  exportDiagnostics: () => exportDiagnostics(),
  stop: () => {},
});
document.addEventListener('click', (event) => {
  const control = event.target.closest?.('[data-ui-action]');
  if (!control || control.closest('.message-content')) return;
  const action = Object.hasOwn(rendererActions, control.dataset.uiAction) && rendererActions[control.dataset.uiAction];
  if (!action) return;
  event.stopPropagation();
  Promise.resolve().then(() => action(control.dataset.uiArg || '')).catch(console.error);
}, true);
document.addEventListener('change', (event) => {
  if (event.target.dataset.uiChange === 'select-profile-model' && event.target.value) {
    document.getElementById('profileEditorModel').value = event.target.value;
  }
});

// Post-process rendered markdown: wrap code blocks with a header (lang + copy button)
function enhanceCodeBlocks(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('pre code').forEach((codeEl) => {
    if (codeEl.closest('.code-block-wrapper')) return; // already enhanced

    const pre = codeEl.parentElement;
    const lang = (codeEl.className.match(/language-([\w+-]+)/) || [])[1] || 'code';

    // Build wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    // Header: language label + copy button
    const header = document.createElement('div');
    header.className = 'code-block-header';
    const langLabel = document.createElement('span');
    langLabel.className = 'code-block-lang';
    langLabel.textContent = lang;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-block-copy';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', async () => {
      const text = codeEl.innerText;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '已复制';
      } catch (err) {
        // Fallback for older environments
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        copyBtn.textContent = '已复制';
      }
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1600);
    });
    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    // Move pre into wrapper
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
}

// Post-process rendered markdown tables: keep wide tables readable inside chat.
function enhanceTables(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('table').forEach((table) => {
    if (table.parentElement && table.parentElement.classList.contains('markdown-table-wrap')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-table-wrap';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', '数据表格，可横向滚动');
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

// State
let isProcessing = false;
let currentAssistantMsg = null;
let currentToolBlocks = {};
let eventSource = null;
// One compact task bar summarizes the active tool run; individual capsules stay folded.
let currentTaskTimer = null;
let currentTaskStartedAt = 0;
let currentTaskSummary = null;
let currentTaskToolCount = 0;

// Monotonic ID for each streaming turn. Prevents a closing, older SSE
// response from changing the state of a newly auto-started queued turn.
let activeChatTurnToken = 0;

// Thinking level (iOS-style: off / low / medium / high / xhigh / max / ultra)
const THINKING_LEVELS = {
  off: { id: 'off', label: '关闭', desc: '不启用额外思考' },
  low: { id: 'low', label: '低', desc: '快速轻量推理' },
  medium: { id: 'medium', label: '标准', desc: '平衡速度与深度' },
  high: { id: 'high', label: '高', desc: '更深入的长思考' },
  xhigh: { id: 'xhigh', label: '超高', desc: '最大化推理深度' },
  max: { id: 'max', label: '最大', desc: '使用模型允许的最大思考' },
  ultra: { id: 'ultra', label: 'Ultra', desc: '更强的深度推理模式' },
};
let currentThinkingLevel = localStorage.getItem('iexa-thinking-level') || 'medium';
if (!THINKING_LEVELS[currentThinkingLevel]) currentThinkingLevel = 'medium';

// iOS-style prompt queue: keep chatting while a task runs; auto-run after it ends.
/** @type {{ id: string, sessionId: string, text: string, displayText: string, attachments: any[] }[]} */
let promptQueue = [];
let isDrainingQueue = false;
/** When true, stop current turn and do not auto-drain remaining queue. */
let suppressQueueDrain = false;

// Codex-style follow-up routing while a turn is live:
//   queue     → keep the bubble pending and run it after this turn
//   steer     → append it to the running turn at the next step boundary
//   interrupt → cancel this turn, then run the new prompt
// VS Code Codex defaults to `queue`; Ctrl/Cmd+Shift+Enter flips it for one send.
const FOLLOW_UP_MODES = ['queue', 'steer', 'interrupt'];
const FOLLOW_UP_MODE_META = {
  queue: { label: '队列', title: '队列：当前任务结束后执行（Ctrl+Shift+Enter 临时改为插入）' },
  steer: { label: '插入', title: '插入：当前步骤结束后接入本轮（Ctrl+Shift+Enter 临时改为排队）' },
  interrupt: { label: '中断', title: '中断：停止当前任务并立即执行（Ctrl+Shift+Enter 临时改为排队）' },
};
let followUpMode = localStorage.getItem('iexa-follow-up-mode') || 'queue';
if (!FOLLOW_UP_MODES.includes(followUpMode)) followUpMode = 'queue';
function oppositeFollowUpMode() {
  return followUpMode === 'queue' ? 'steer' : 'queue';
}
function isFollowUpModifier(event) {
  return !!(event && (event.ctrlKey || event.metaKey) && event.shiftKey);
}

// Session state
let currentSessionId = '';
// The conversation mounted in the visible chat area. Background SSE work may
// temporarily load another runtime, but must never replace this DOM surface.
let visibleSessionId = '';
let sessionsCache = [];
const conversationClientId = sessionStorage.getItem('iexa-conversation-client-id') ||
  (globalThis.crypto?.randomUUID?.() || `client_${Date.now()}_${Math.random().toString(36).slice(2)}`);
sessionStorage.setItem('iexa-conversation-client-id', conversationClientId);
const sessionSyncSnapshot = new Map();
let conversationEventSource = null;
let conversationEventQueue = Promise.resolve();
let sessionSyncTimer = null;
let sessionSyncInFlight = false;
let queuedSessionSync = false;
let queuedSessionSyncSessionId = '';
let pendingCurrentSessionSync = false;
// Ignore late /api/sessions/:id responses after the user has selected another
// chat. Without this fence a slower earlier switch can repaint the new surface.
let sessionViewEpoch = 0;
let sessionCreateRequest = 0;
let activatedSessionId = '';
let sessionActivationQueue = Promise.resolve();

// DOM Elements
// The visible chat surface belongs only to the selected conversation. Other
// sessions render directly into their detached fragment, so streaming updates
// never move or repaint the conversation the user is reading or typing in.
const visibleChatMessages = document.getElementById('chatMessages');
let chatMessages = visibleChatMessages;
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
  const voiceBtn = document.getElementById('voiceBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');
const contextProgress = document.getElementById('contextProgress');
const contextProgressValue = document.getElementById('contextProgressValue');
const contextProgressTooltip = document.getElementById('contextProgressTooltip');
let latestContextStatus = null;
let isNearChatBottom = true;

// One independent UI runtime per conversation. The server already owns one
// AgentLoop per sessionId; this cache gives each SSE stream its own DOM, tool
// steps, thinking panel and processing state instead of cancelling on switch.
const sessionRuntimes = new Map();
const LIVE_TURN_DOM_OWNERSHIP_MS = 5000;

function runtimeForSession(sessionId) {
  let runtime = sessionRuntimes.get(sessionId);
  if (!runtime) {
    runtime = { fragment: document.createDocumentFragment(), historyReady: false };
    sessionRuntimes.set(sessionId, runtime);
  }
  return runtime;
}

function protectLiveTurnDom(sessionId = currentSessionId) {
  if (!sessionId) return;
  runtimeForSession(sessionId).historyReady = true;
  runtimeForSession(sessionId).liveTurnDomOwnedUntil = Date.now() + LIVE_TURN_DOM_OWNERSHIP_MS;
}

/** Number of transcript bubbles currently mounted for a session. */
function countRenderedMessages(sessionId) {
  if (!sessionId) return 0;
  if (sessionId === visibleSessionId) return visibleChatMessages.querySelectorAll('.message').length;
  const runtime = sessionRuntimes.get(sessionId);
  return runtime ? runtime.fragment.querySelectorAll('.message').length : 0;
}

function applySessionRuntime(sessionId) {
  const runtime = runtimeForSession(sessionId);
  isProcessing = !!runtime.isProcessing;
  currentAssistantMsg = runtime.currentAssistantMsg || null;
  currentToolBlocks = runtime.currentToolBlocks || {};
  currentTaskTimer = runtime.currentTaskTimer || null;
  currentTaskStartedAt = runtime.currentTaskStartedAt || 0;
  currentTaskSummary = runtime.currentTaskSummary || null;
  currentTaskToolCount = runtime.currentTaskToolCount || 0;
  activeChatTurnToken = runtime.activeChatTurnToken || 0;
  latestContextStatus = runtime.latestContextStatus || null;
  isNearChatBottom = runtime.isNearChatBottom !== false;
  promptQueue = runtime.promptQueue || [];
  isDrainingQueue = !!runtime.isDrainingQueue;
  suppressQueueDrain = !!runtime.suppressQueueDrain;
  return runtime;
}

function snapshotActiveSessionRuntime(detachSurface = false) {
  if (!currentSessionId) return;
  const runtime = runtimeForSession(currentSessionId);
  // Only a user-initiated session switch moves visible DOM into storage.
  // Background SSE updates render against the detached fragment directly.
  if (detachSurface && currentSessionId === visibleSessionId) {
    while (chatMessages.firstChild) runtime.fragment.appendChild(chatMessages.firstChild);
    // A cold-start/history mount owns the viewport until its lazy layout has
    // settled. Do not persist the transient top position observed mid-mount.
    if (!(runtime.historyFollowLatestUntil > Date.now()) && !runtime.forceHistoryLatest) {
      runtime.scrollTop = visibleChatMessages.scrollTop;
    }
  }
  runtime.isProcessing = isProcessing;
  runtime.currentAssistantMsg = currentAssistantMsg;
  runtime.currentToolBlocks = currentToolBlocks;
  runtime.currentTaskTimer = currentTaskTimer;
  runtime.currentTaskStartedAt = currentTaskStartedAt;
  runtime.currentTaskSummary = currentTaskSummary;
  runtime.currentTaskToolCount = currentTaskToolCount;
  runtime.activeChatTurnToken = activeChatTurnToken;
  runtime.latestContextStatus = latestContextStatus;
  runtime.isNearChatBottom = isNearChatBottom;
  runtime.promptQueue = promptQueue;
  runtime.isDrainingQueue = isDrainingQueue;
  runtime.suppressQueueDrain = suppressQueueDrain;
  sessionRuntimes.set(currentSessionId, runtime);
}

function mountSessionRuntime(sessionId, surface = visibleChatMessages) {
  const runtime = runtimeForSession(sessionId);
  while (surface.firstChild) surface.removeChild(surface.firstChild);
  surface.appendChild(runtime.fragment);
  chatMessages = surface;
  applySessionRuntime(sessionId);
  if (surface === visibleChatMessages && Number.isFinite(runtime.scrollTop) && !(runtime.historyFollowLatestUntil > Date.now()) && !runtime.forceHistoryLatest) {
    visibleChatMessages.scrollTop = runtime.scrollTop;
  }
}

// History is rendered with lazy layout (content-visibility, Markdown tables,
// paged tool output). A single rAF can target the estimated height, then the
// browser lays out older content and leaves the viewport above the real end.
// Re-pin for a few frames until scrollHeight stops changing.
let historyScrollGeneration = 0;
let cancelHistoryScrollPositioning = null;
function scrollHistoryToLatest(sessionId = currentSessionId) {
  if (!sessionId || sessionId !== currentSessionId || sessionId !== visibleSessionId) return;
  if (typeof cancelHistoryScrollPositioning === 'function') cancelHistoryScrollPositioning();
  const generation = ++historyScrollGeneration;
  const runtime = typeof runtimeForSession === 'function' ? runtimeForSession(sessionId) : null;
  // Keep this intent alive across metadata refreshes and runtime snapshots.
  if (runtime) {
    runtime.historyFollowLatestUntil = Date.now() + 6000;
    runtime.forceHistoryLatest = true;
    // EventSource/focus synchronization can immediately report the current
    // session as changed during cold start. Keep that metadata refresh from
    // rebuilding the just-mounted history surface for a short settling window.
    runtime.startupHistoryLockUntil = Date.now() + 5000;
  }
  let frame = 0;
  let previousHeight = -1;
  let lastHeightChangeAt = performance.now();
  const startedAt = performance.now();
  let resizeObserver = null;
  const timers = [];
  let mutationObserver = null;
  const previousOverflowAnchor = visibleChatMessages.style.overflowAnchor;
  visibleChatMessages.style.overflowAnchor = 'none';
  visibleChatMessages.classList.add('is-positioning-history');
  let cancelled = false;
  const cleanup = (preservePositioning = false) => {
    if (cancelled) return;
    cancelled = true;
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    timers.splice(0).forEach((timer) => window.clearTimeout(timer));
    if (!preservePositioning) {
      visibleChatMessages.classList.remove('is-positioning-history');
      visibleChatMessages.style.overflowAnchor = previousOverflowAnchor;
    }
    if (cancelHistoryScrollPositioning === cleanup) cancelHistoryScrollPositioning = null;
  };
  if (typeof cancelHistoryScrollPositioning !== 'undefined') cancelHistoryScrollPositioning = () => cleanup(false);
  const pin = () => {
    if (generation !== historyScrollGeneration || sessionId !== currentSessionId || sessionId !== visibleSessionId) return false;
    visibleChatMessages.scrollTop = Math.max(0, visibleChatMessages.scrollHeight - visibleChatMessages.clientHeight);
    if (runtime) runtime.scrollTop = visibleChatMessages.scrollTop;
    return true;
  };
  const finish = () => {
    if (generation !== historyScrollGeneration) return;
    pin();
    cleanup(false);
    visibleChatMessages.style.overflowAnchor = previousOverflowAnchor;
  if (runtime) {
    runtime.scrollTop = visibleChatMessages.scrollTop;
    runtime.historyFollowLatestUntil = 0;
    runtime.startupHistoryLockUntil = 0;
  }
    isNearChatBottom = true;
    updateScrollToBottomButton();
  };
  const settle = () => {
    if (cancelled || generation !== historyScrollGeneration) return;
    if (sessionId !== currentSessionId || sessionId !== visibleSessionId) {
      cleanup(false);
      return;
    }
    pin();
    const height = visibleChatMessages.scrollHeight;
    frame += 1;
    if (height !== previousHeight) {
      previousHeight = height;
      lastHeightChangeAt = performance.now();
    }
    const now = performance.now();
    if (frame < 8 || (now - lastHeightChangeAt < 220 && now - startedAt < 4200)) {
      requestAnimationFrame(settle);
      return;
    }
    finish();
  };
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      if (generation !== historyScrollGeneration) return;
      lastHeightChangeAt = performance.now();
      pin();
    });
    resizeObserver.observe(visibleChatMessages);
    if (visibleChatMessages.lastElementChild) resizeObserver.observe(visibleChatMessages.lastElementChild);
  }
  if (typeof MutationObserver === 'function') {
    mutationObserver = new MutationObserver(() => {
      if (generation !== historyScrollGeneration) return;
      lastHeightChangeAt = performance.now();
      requestAnimationFrame(pin);
    });
    mutationObserver.observe(visibleChatMessages, { childList: true, subtree: true, characterData: true });
  }
  [0, 50, 150, 300, 600, 1000, 1500, 2500, 4000].forEach((delay) => {
    timers.push(window.setTimeout(() => {
      if (generation !== historyScrollGeneration) return;
      pin();
      if (delay >= 4000) finish();
    }, delay));
  });
  requestAnimationFrame(settle);
}

function restoreVisibleSessionRuntime(sessionId) {
  currentSessionId = sessionId;
  chatMessages = visibleChatMessages;
  applySessionRuntime(sessionId);
}

function withSessionRuntime(sessionId, work) {
  if (!sessionId || sessionId === currentSessionId) return work();
  const previousVisibleSessionId = currentSessionId;
  const previousSurface = chatMessages;
  snapshotActiveSessionRuntime();
  currentSessionId = sessionId;
  const runtime = runtimeForSession(sessionId);
  chatMessages = sessionId === visibleSessionId ? visibleChatMessages : runtime.fragment;
  applySessionRuntime(sessionId);
  try { return work(); }
  finally {
    snapshotActiveSessionRuntime();
    currentSessionId = previousVisibleSessionId;
    chatMessages = previousSurface;
    applySessionRuntime(previousVisibleSessionId);
    // The visible session's controls were never touched while the background
    // fragment updated. Avoid rebuilding the composer/sidebar for every SSE
    // delta, which steals focus and makes concurrent chats visibly jump.
  }
}

function syncActiveSessionUI() {
  const runtime = sessionRuntimes.get(currentSessionId);
  const processing = runtime ? !!runtime.isProcessing : isProcessing;
  isProcessing = processing;
  stopBtn.style.display = processing ? 'flex' : 'none';
  sendBtn.style.display = 'flex';
  sendBtn.disabled = false;
  chatInput.disabled = false;
  if (typeof attachBtn !== 'undefined' && attachBtn) attachBtn.disabled = false;
  statusDot.className = processing ? 'status-dot processing' : 'status-dot';
  statusText.textContent = processing ? '处理中...' : '就绪';
  if (latestContextStatus) applySessionContextStatus(currentSessionId);
  else resetContextStatus();
  updateComposerForQueue();
  updateScrollToBottomButton();
  renderSessionList();
}

// =============================================================================
// Navigation
// =============================================================================

// Inactive views stay mounted but are zero-sized (`.view` in styles.css), which
// means the chat surface has no scrollable overflow while it is hidden: the
// browser clamps scrollTop to 0 and the transcript would come back at its first
// message. Remember the offset - and whether the user was following the newest
// message - before the view is deactivated, and put it back once the view has
// geometry again.
let chatViewScrollMemory = null;

function chatViewIsActive() {
  const view = document.getElementById('view-chat');
  return !view || view.classList.contains('active');
}

function captureChatViewScroll() {
  if (!visibleChatMessages || !chatViewIsActive()) return;
  // A surface whose content fits its viewport reports equal heights; sampling
  // then would store the collapsed offset instead of the user's place.
  if (visibleChatMessages.scrollHeight <= visibleChatMessages.clientHeight) return;
  chatViewScrollMemory = {
    sessionId: currentSessionId,
    top: visibleChatMessages.scrollTop,
    atBottom: isChatNearBottom(),
  };
}

function restoreChatViewScroll() {
  const memory = chatViewScrollMemory;
  chatViewScrollMemory = null;
  if (!memory || memory.sessionId !== currentSessionId) return;
  const apply = () => {
    if (!chatViewIsActive() || memory.sessionId !== currentSessionId) return;
    if (memory.atBottom) {
      scrollToBottom(true);
      return;
    }
    visibleChatMessages.scrollTop = memory.top;
    isNearChatBottom = isChatNearBottom();
    updateScrollToBottomButton();
  };
  // The reactivated view needs one frame of layout before scrollTop sticks.
  requestAnimationFrame(apply);
}

// The stylesheet only suppresses motion when the OS asks for it and the user
// has not overridden with "full" (see the reduced-motion blocks in
// workbench.css). Ask the same question here: adding the entry class when no
// animation can run leaves it on the pane for 400ms, and the next switch then
// pays for a forced layout to restart an animation nobody sees.
function viewAnimationsEnabled() {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  return !reduced || getMotionMode() === 'full';
}

// Each pane refreshes its own data on first show. The map exists so the click
// handler stays a switch instead of eight ifs, and so the refresh can be run
// after the frame instead of inside the click task.
const VIEW_REFRESH = {
  settings: () => loadSettings(),
  skills: () => loadSkillsList(),
  soul: () => loadSoul(),
  'token-calculator': () => loadTokenUsage(),
  // Paint the cached rows first; a response that matches what is already on
  // screen then changes no DOM at all.
  jobs: () => { renderJobs(); loadJobs(); },
  mcp: () => loadMcpServers(),
  plugins: () => loadPlugins(),
  sync: () => loadMobileBridge(),
};

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    const chatWasActive = chatViewIsActive();
    if (view !== 'chat' && chatWasActive) captureChatViewScroll();
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const panel = document.getElementById(`view-${view}`);
    if (panel) {
      panel.classList.add('active');
      // Replay the entry animation on every switch, but never on first paint:
      // a running animation puts the whole view on its own composited layer,
      // and anything measured during that window comes back a subpixel off.
      //
      // The reflow is only needed when the class is still applied (a second
      // switch inside the 180ms animation). Doing it unconditionally forced a
      // synchronous layout of the whole pane - for the chat transcript that is
      // tens of thousands of nodes - before the frame could be committed, which
      // is the stall that made switching feel heavy. With motion off entirely
      // there is nothing to restart, so the class is not applied at all.
      if (viewAnimationsEnabled()) {
        const restart = panel.classList.contains('is-entering');
        panel.classList.remove('is-entering');
        if (restart) void panel.offsetWidth;
        panel.classList.add('is-entering');
        const clearEntering = () => panel.classList.remove('is-entering');
        panel.addEventListener('animationend', clearEntering, { once: true });
        setTimeout(clearEntering, 400);
      } else {
        panel.classList.remove('is-entering');
      }
    }
    if (view === 'chat' && !chatWasActive) restoreChatViewScroll();
    closeMobileDrawers();
    syncJobsPolling();

    // Load the pane's data. This stays in the click task on purpose: moving it
    // behind requestAnimationFrame was measured and changed nothing - the
    // switch already pays for the pane's layout, and the fetches are async
    // anyway - while it made "click then look" race the loader.
    const refresh = VIEW_REFRESH[view];
    if (refresh) refresh();
  });
});

// =============================================================================
// SOUL.md — persistent assistant identity and personality
// =============================================================================

let soulSaving = false;
let soulState = { metadata: { name: 'IEXA', style: '', lang: 'auto' }, body: '' };
let soulSaveFeedbackTimer = null;

function soulName() {
  return String(soulState?.metadata?.name || '').trim() || 'IEXA';
}

function estimateSoulTokens(text) {
  let count = 0;
  let inWord = false;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0) || 0;
    const cjk = (code >= 0x3400 && code <= 0x4DBF)
      || (code >= 0x4E00 && code <= 0x9FFF)
      || (code >= 0x20000 && code <= 0x323AF)
      || (code >= 0x3040 && code <= 0x31FF)
      || (code >= 0xAC00 && code <= 0xD7AF)
      || (code >= 0x1100 && code <= 0x11FF)
      || (code >= 0x3130 && code <= 0x318F)
      || (code >= 0x3000 && code <= 0x303F)
      || (code >= 0xFF00 && code <= 0xFFEF);
    if (cjk) {
      if (inWord) { count++; inWord = false; }
      count++;
    } else if (/\s/u.test(char)) {
      if (inWord) { count++; inWord = false; }
    } else {
      inWord = true;
    }
  }
  return count + (inWord ? 1 : 0);
}

function soulFormValue() {
  return {
    metadata: {
      name: document.getElementById('soulName')?.value || 'IEXA',
      style: document.getElementById('soulStyle')?.value || '',
      lang: document.getElementById('soulLanguage')?.value || 'auto',
    },
    body: document.getElementById('soulBody')?.value || '',
  };
}

function applySoulIdentity() {
  const name = soulName();
  const brand = document.getElementById('brandName');
  if (brand) brand.textContent = name;
  document.querySelectorAll('.message.assistant .message-label').forEach((label) => { label.textContent = name; });
  const welcome = chatMessages?.querySelector('.welcome');
  if (welcome) {
    const title = welcome.querySelector('h2');
    if (title) title.textContent = '今天想构建什么？';
  }
}

function updateSoulPreview() {
  const value = soulFormValue();
  const name = String(value.metadata.name || '').trim() || 'IEXA';
  const style = String(value.metadata.style || '').trim();
  const nameEl = document.getElementById('soulPreviewName');
  const styleEl = document.getElementById('soulPreviewStyle');
  if (nameEl) nameEl.textContent = name;
  if (styleEl) styleEl.textContent = style || '未设置风格';
  const body = document.getElementById('soulBody');
  const count = estimateSoulTokens(body?.value || '');
  const countEl = document.getElementById('soulTokenCount');
  const saveBtn = document.getElementById('soulSaveBtn');
  if (countEl) {
    countEl.textContent = `约 ${formatTokenCount(count)} tokens`;
    countEl.classList.remove('is-over-limit');
  }
  if (saveBtn) saveBtn.disabled = soulSaving;
}

/** Keep the personality editor compact for short prompts and grow it naturally
 * as the user adds new lines. The containing Soul page supplies the scroll. */
function autoResizeSoulBody() {
  const body = document.getElementById('soulBody');
  if (!body) return;
  body.style.height = 'auto';
  body.style.height = `${Math.max(220, body.scrollHeight)}px`;
}

function showSoulResult(message, isError = false) {
  const result = document.getElementById('soulResult');
  if (!result) return;
  result.textContent = message;
  result.classList.toggle('is-error', isError);
  result.style.display = 'block';
}

/** Immediate, visible save feedback beside the toolbar action. The detailed
 * message remains in the page footer as a secondary status record. */
function setSoulSaveFeedback(message = '', state = '') {
  const status = document.getElementById('soulSaveStatus');
  const button = document.getElementById('soulSaveBtn');
  const label = button?.querySelector('.soul-save-button-label');
  if (soulSaveFeedbackTimer) {
    clearTimeout(soulSaveFeedbackTimer);
    soulSaveFeedbackTimer = null;
  }
  if (status) {
    status.textContent = message;
    status.className = `soul-save-status${state ? ` is-${state}` : ''}`;
  }
  if (button) {
    button.classList.toggle('is-saving', state === 'saving');
    button.classList.toggle('is-saved', state === 'success');
    button.classList.toggle('is-error', state === 'error');
    button.setAttribute('aria-busy', String(state === 'saving'));
  }
  if (label) label.textContent = state === 'saving' ? '保存中…' : state === 'success' ? '已保存' : state === 'error' ? '保存失败' : '保存';
  if (state === 'success' || state === 'error') {
    soulSaveFeedbackTimer = setTimeout(() => setSoulSaveFeedback(), 2600);
  }
}

function populateSoulForm(data) {
  soulState = {
    metadata: {
      name: data?.metadata?.name || 'IEXA',
      style: data?.metadata?.style || '',
      lang: data?.metadata?.lang || 'auto',
    },
    body: data?.body || '',
  };
  const name = document.getElementById('soulName');
  const style = document.getElementById('soulStyle');
  const lang = document.getElementById('soulLanguage');
  const body = document.getElementById('soulBody');
  if (name) name.value = soulState.metadata.name;
  if (style) style.value = soulState.metadata.style;
  if (lang) {
    const hasOption = [...lang.options].some((option) => option.value === soulState.metadata.lang);
    lang.value = hasOption ? soulState.metadata.lang : 'auto';
  }
  if (body) body.value = soulState.body;
  const path = document.getElementById('soulFilePath');
  if (path) path.textContent = data?.path ? `SOUL.md · ${data.path}` : '';
  updateSoulPreview();
  autoResizeSoulBody();
  applySoulIdentity();
}

async function loadSoul() {
  void window.iexaPromptSettings?.loadScope();
  try {
    const response = await fetch(`${API_BASE}/api/soul`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '灵魂配置加载失败');
    populateSoulForm(data);
    const result = document.getElementById('soulResult');
    if (result) result.style.display = 'none';
  } catch (error) {
    showSoulResult(error?.message || String(error), true);
  }
}

async function saveSoul() {
  const value = soulFormValue();
  if (soulSaving) return;
  soulSaving = true;
  const button = document.getElementById('soulSaveBtn');
  if (button) button.disabled = true;
  setSoulSaveFeedback('正在写入 SOUL.md', 'saving');
  try {
    const response = await fetch(`${API_BASE}/api/soul`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '灵魂配置保存失败');
    populateSoulForm(data);
    setSoulSaveFeedback('已保存', 'success');
    showSoulResult('已保存。后续对话将使用新的身份和人格。');
  } catch (error) {
    setSoulSaveFeedback('保存失败', 'error');
    showSoulResult(error?.message || String(error), true);
  } finally {
    soulSaving = false;
    updateSoulPreview();
  }
}

async function restoreSoul() {
  if (!(await window.IexaDialogs.confirm('恢复默认灵魂？当前身份和人格提示词将被替换。'))) return;
  try {
    const response = await fetch(`${API_BASE}/api/soul/restore`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '恢复默认灵魂失败');
    populateSoulForm(data);
    showSoulResult('已恢复默认灵魂。');
  } catch (error) {
    showSoulResult(error?.message || String(error), true);
  }
}

function initSoulUI() {
  if (window.IexaPromptSettings && !window.iexaPromptSettings) window.iexaPromptSettings = new window.IexaPromptSettings({ apiBase: API_BASE, getSessionId: () => currentSessionId });
  ['soulName', 'soulStyle', 'soulLanguage', 'soulBody'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => {
      if (id === 'soulBody') autoResizeSoulBody();
      updateSoulPreview();
    });
    document.getElementById(id)?.addEventListener('change', updateSoulPreview);
  });
  document.getElementById('soulSaveBtn')?.addEventListener('click', () => saveSoul());
  document.getElementById('soulRestoreBtn')?.addEventListener('click', () => restoreSoul());
}

// =============================================================================
// Search
// =============================================================================

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    performSearch();
  }
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchClear.style.display = q ? 'flex' : 'none';
  if (!q) {
    searchResults.style.display = 'none';
    sessionsList.style.display = '';
  }
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.style.display = 'none';
  searchResults.style.display = 'none';
  sessionsList.style.display = '';
  searchInput.focus();
});

async function performSearch() {
  const q = searchInput.value.trim();
  if (!q) {
    searchResults.style.display = 'none';
    sessionsList.style.display = '';
    return;
  }

  try {
    const resp = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`);
    const data = await resp.json();
    const results = data.results || [];

    if (results.length === 0) {
      searchResults.innerHTML = '<div class="search-no-results">未找到结果</div>';
    } else {
      searchResults.innerHTML = results.map(r => `
        <div class="search-result-item" data-ui-action="switchSession" data-ui-arg="${escapeHtml(r.session.id)}">
          <div class="search-result-title">${escapeHtml(r.session.title)}</div>
          ${r.matches.map(m => `
            <div class="search-result-snippet${Number.isInteger(m.index) && m.index >= 0 ? ' is-hittable' : ''}"
              ${Number.isInteger(m.index) && m.index >= 0 ? `role="button" tabindex="0" title="跳转到这条消息" data-ui-action="openSearchHit" data-ui-arg="${escapeHtml(r.session.id)}:${m.index}"` : ''}><span class="search-role">${m.role === 'user' ? uiIcon('user') : m.role === 'title' ? uiIcon('edit') : uiIcon('bot')}</span> ${highlightMatch(m.snippet, q)}</div>
          `).join('')}
        </div>
      `).join('');
    }

    searchResults.style.display = 'block';
    sessionsList.style.display = 'none';
    searchClear.style.display = 'flex';
  } catch (err) {
    console.error('Search failed:', err);
  }
}

function highlightMatch(text, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  return escapeHtml(text).replace(regex, '<em>$1</em>');
}

/**
 * Open the session a search snippet came from and scroll to that message.
 *
 * The persisted transcript is authoritative, while the DOM exposes
 * `data-message-index` for every rendered message. Switching sessions can take
 * a frame or two (history fetch + mount), so poll briefly instead of guessing a
 * fixed delay, then flash the target so the eye lands on the right turn.
 */
async function openSearchHit(value) {
  const raw = String(value || '');
  const separator = raw.lastIndexOf(':');
  if (separator <= 0) return;
  const sessionId = raw.slice(0, separator);
  const messageIndex = Number(raw.slice(separator + 1));
  if (!sessionId) return;
  await switchSession(sessionId);
  if (!Number.isInteger(messageIndex) || messageIndex < 0) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    const target = chatMessages.querySelector(`.message[data-message-index="${messageIndex}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.remove('search-hit-flash');
      void target.offsetWidth; // restart the animation when the same hit is clicked twice
      target.classList.add('search-hit-flash');
      window.setTimeout(() => target.classList.remove('search-hit-flash'), 2400);
      return;
    }
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }
}

searchResults.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const snippet = event.target.closest?.('.search-result-snippet[data-ui-action]');
  if (!snippet) return;
  event.preventDefault();
  openSearchHit(snippet.dataset.uiArg).catch(console.error);
});

// =============================================================================
// Chat Input
// =============================================================================

const chatComposition = window.IexaComposerInput.bind(chatInput);
chatInput.addEventListener('keydown', (e) => {
  if (chatComposition.isComposing(e)) return;
  if (e.key === 'Enter' && (!e.shiftKey || isFollowUpModifier(e))) {
    const menu = document.getElementById('slashMenu');
    if (menu && menu.style.display !== 'none' && menu.querySelector('.slash-item')) {
      return; // handled by slash menu listener
    }
    e.preventDefault();
    sendMessage(e);
  }
});

// Auto-resize textarea (capsule stays compact, grows up to max)
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
  updateSlashMenu();
});

chatInput.addEventListener('keydown', (e) => {
  if (chatComposition.isComposing(e)) return;
  const menu = document.getElementById('slashMenu');
  if (menu && menu.style.display !== 'none' && menu.querySelector('.slash-item')) {
    if (e.key === 'Escape') {
      hideSlashMenu();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && menu.querySelector('.slash-item.active'))) {
      const active = menu.querySelector('.slash-item.active') || menu.querySelector('.slash-item');
      if (active) {
        e.preventDefault();
        if (active.dataset.kind === 'command') runSlashCommand(active.dataset.value || '');
        else applySlashSkill(active.dataset.value || '');
      }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menu.querySelectorAll('.slash-item')];
      let idx = items.findIndex((el) => el.classList.contains('active'));
      if (idx < 0) idx = 0;
      else idx = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items.forEach((el) => el.classList.remove('active'));
      items[idx].classList.add('active');
    }
  }
});

// Native streaming speech input: explicit lifecycle prevents stuck starts/stops.
(() => {
  let recognition = null, voiceState = 'idle', baseText = '', interimText = '', internalUpdate = false, stopTimer = null;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const setVoiceState = (state, message) => {
    voiceState = state;
    if (!voiceBtn) return;
    voiceBtn.dataset.voiceState = state; voiceBtn.classList.toggle('is-listening', state === 'listening' || state === 'starting' || state === 'stopping');
    voiceBtn.classList.toggle('is-stopping', state === 'stopping');
    voiceBtn.setAttribute('aria-label', state === 'listening' || state === 'starting' ? '停止语音输入' : '开始语音输入');
    voiceBtn.title = message || (state === 'listening' ? '停止语音输入' : state === 'starting' ? '正在启动语音输入' : '语音输入');
    voiceBtn.setAttribute('aria-pressed', String(state === 'listening' || state === 'starting' || state === 'stopping'));
  };
  if (!SpeechRecognition) { voiceBtn?.setAttribute('hidden', ''); return; }
  recognition = new SpeechRecognition(); recognition.continuous = true; recognition.interimResults = true; recognition.lang = navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : (navigator.language || 'en-US');
  recognition.onstart = () => { clearTimeout(stopTimer); if (voiceState === 'stopping') { recognition.abort(); return; } voiceState = 'listening'; baseText = chatInput.value.trimEnd(); interimText = ''; setVoiceState('listening', '正在聆听，点击停止'); chatInput.classList.add('is-voice-live'); chatInput.focus(); };
  recognition.onresult = event => { let finalText = '', liveText = ''; for (let i = event.resultIndex; i < event.results.length; i++) { const text = event.results[i][0].transcript; if (event.results[i].isFinal) finalText += text; else liveText += text; } if (finalText) baseText = `${baseText}${baseText ? ' ' : ''}${finalText}`; interimText = liveText; internalUpdate = true; chatInput.value = `${baseText}${interimText ? `${baseText ? ' ' : ''}${interimText}` : ''}`; chatInput.dispatchEvent(new Event('input', { bubbles: true })); internalUpdate = false; };
  recognition.onerror = event => { clearTimeout(stopTimer); const intentional = voiceState === 'stopping' || event.error === 'aborted'; voiceState = 'idle'; chatInput.classList.remove('is-voice-live'); if (!intentional) { setVoiceState('error', event.error === 'not-allowed' ? '麦克风权限被拒绝' : `语音输入失败：${event.error}`); statusText.textContent = event.error === 'not-allowed' ? '请在系统设置中允许麦克风访问。' : `语音输入失败：${event.error}`; } else setVoiceState('idle', '语音输入'); };
  recognition.onend = () => { clearTimeout(stopTimer); const wasStopping = voiceState === 'stopping'; voiceState = 'idle'; interimText = ''; chatInput.classList.remove('is-voice-live'); setVoiceState('idle', wasStopping ? '语音输入已停止' : '语音输入'); };
  voiceBtn?.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (voiceState === 'listening' || voiceState === 'starting') { voiceState = 'stopping'; setVoiceState('stopping', '正在停止语音输入'); try { recognition.stop(); } catch {} stopTimer = setTimeout(() => { try { recognition.abort(); } catch {} voiceState = 'idle'; chatInput.classList.remove('is-voice-live'); setVoiceState('idle', '语音输入已停止'); }, 700); return; } if (voiceState === 'stopping') return; setVoiceState('starting', '正在启动语音输入'); try { recognition.start(); } catch { setVoiceState('error', '语音输入启动失败'); } });
  window.addEventListener('beforeunload', () => { try { recognition.abort(); } catch {} });
})();

sendBtn.addEventListener('click', sendMessage);
document.getElementById('followUpModeBtn')?.addEventListener('click', () => {
  const index = FOLLOW_UP_MODES.indexOf(followUpMode);
  followUpMode = FOLLOW_UP_MODES[(index + 1) % FOLLOW_UP_MODES.length];
  localStorage.setItem('iexa-follow-up-mode', followUpMode);
  renderFollowUpMode();
  updateComposerForQueue();
});
stopBtn.addEventListener('click', stopProcessing);

function sendQuick(text) {
  pendingAttachments = [];
  renderAttachPreview();
  chatInput.value = text;
  sendMessage();
}

// =============================================================================
// Attachments
// =============================================================================

const MAX_ATTACHMENTS = 8;
const MAX_ATTACH_BYTES = 8 * 1024 * 1024; // 8MB per file
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ATTACH_TOTAL_BYTES = 256 * 1024 * 1024; // decoded attachment total
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const TEXT_EXTS = new Set([
  'txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'html', 'css', 'xml', 'csv',
  'log', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'sql',
  'c', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'vue',
  'svelte', 'env', 'gitignore', 'dockerfile',
]);

/** @type {{ id: string, name: string, mime: string, size: number, kind: 'image'|'text'|'file', dataUrl?: string, text?: string }[]} */
let pendingAttachments = [];

const attachBtn = document.getElementById('attachBtn');
const attachInput = document.getElementById('attachInput');
const attachPreview = document.getElementById('attachPreview');
const chatInputArea = document.querySelector('.chat-input-area');

if (attachBtn && attachInput) {
  attachBtn.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', async () => {
    if (attachInput.files && attachInput.files.length) {
      await addFiles(attachInput.files);
      attachInput.value = '';
    }
  });
}

// Paste images / files into chat
chatInput.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    await addFiles(files);
  }
});

// Drag & drop
if (chatInputArea) {
  ['dragenter', 'dragover'].forEach((ev) => {
    chatInputArea.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      chatInputArea.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    chatInputArea.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ev === 'dragleave') chatInputArea.classList.remove('drag-over');
    });
  });
  chatInputArea.addEventListener('drop', async (e) => {
    chatInputArea.classList.remove('drag-over');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) await addFiles(files);
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      addError(`最多添加 ${MAX_ATTACHMENTS} 个附件。`);
      break;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      addError(`「${file.name}」超过 100MB，已跳过。`);
      continue;
    }
    const pendingBytes = pendingAttachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    if (pendingBytes + file.size > MAX_ATTACH_TOTAL_BYTES) {
      addError(`附件总大小超过 32MB，「${file.name}」已跳过。`);
      continue;
    }
    try {
      const att = await readFileAsAttachment(file);
      pendingAttachments.push(att);
    } catch (err) {
      addError(`无法读取「${file.name}」：${err.message || err}`);
    }
  }
  renderAttachPreview();
}

function readFileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isImage = (file.type || '').startsWith('image/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
    const isText = (file.type || '').startsWith('text/') ||
      file.type === 'application/json' ||
      TEXT_EXTS.has(ext);

    // Large files are uploaded in chunks at send time. Keep only the browser
    // File handle here instead of reading tens of MB into a data URL/string.
    if (file.size > MAX_ATTACH_BYTES) {
      resolve({
        id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name: file.name,
        mime: file.type || (isImage ? guessImageMime(ext) : isText ? 'text/plain' : 'application/octet-stream'),
        size: file.size,
        kind: isImage ? 'image' : isText ? 'text' : 'file',
        file,
        large: true,
      });
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取失败'));

    if (isImage) {
      reader.onload = () => {
        resolve({
          id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          name: file.name,
          mime: file.type || guessImageMime(ext),
          size: file.size,
          kind: 'image',
          dataUrl: reader.result,
        });
      };
      reader.readAsDataURL(file);
    } else if (isText) {
      reader.onload = () => {
        resolve({
          id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          name: file.name,
          mime: file.type || 'text/plain',
          size: file.size,
          kind: 'text',
          text: reader.result,
        });
      };
      reader.readAsText(file);
    } else {
      // Binary: still send as base64 so backend can save to workspace
      reader.onload = () => {
        resolve({
          id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          kind: 'file',
          dataUrl: reader.result,
        });
      };
      reader.readAsDataURL(file);
    }
  });
}

function guessImageMime(ext) {
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext] || 'image/png';
}

function removeAttachment(id) {
  pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
  renderAttachPreview();
}

function renderAttachPreview() {
  if (!attachPreview) return;
  if (pendingAttachments.length === 0) {
    attachPreview.style.display = 'none';
    attachPreview.innerHTML = '';
    return;
  }
  attachPreview.style.display = 'flex';
  attachPreview.innerHTML = pendingAttachments.map((a) => {
    const thumb = a.kind === 'image' && a.dataUrl
      ? `<img src="${a.dataUrl}" alt="">`
      : `<span class="attach-chip-icon">${uiIcon(a.kind === 'text' ? 'file' : 'box')}</span>`;
    return `
      <div class="attach-chip" data-id="${a.id}">
        ${thumb}
        <span class="attach-chip-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <button type="button" class="attach-chip-remove" data-ui-action="removeAttachment" data-ui-arg="${escapeHtml(a.id)}" title="移除附件" aria-label="移除附件">${uiIcon('close')}</button>
      </div>
    `;
  }).join('');
}

function clearAttachments() {
  pendingAttachments = [];
  renderAttachPreview();
}

// Expose for inline onclick
window.removeAttachment = removeAttachment;

// =============================================================================
// Send Message
// =============================================================================

// =============================================================================
// Prompt Queue (iOS-style insert-while-busy)
// =============================================================================

function makeQueueId() {
  return 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function cloneAttachments(list) {
  return (list || []).map((a) => Object.assign({}, a));
}

/** Enqueue a user prompt while agent is busy — show dashed bubble, run later. */
function enqueuePrompt(opts) {
  const message = chatInput.value.trim();
  const attachments = cloneAttachments(pendingAttachments);
  if ((!message && attachments.length === 0) || !isProcessing) return;
  if (!currentSessionId) return;

  const welcome = chatMessages.querySelector('.welcome');
  if (welcome) welcome.remove();

  const displayText = message || (attachments.length
    ? ('（附件：' + attachments.map((a) => a.name).join('、') + '）')
    : '');

  const id = makeQueueId();
  promptQueue.push({
    id: id,
    sessionId: currentSessionId,
    text: message || displayText,
    displayText: displayText,
    attachments: attachments,
  });

  const el = addMessage('user', displayText, attachments, { queued: true, queueId: id });
  el.dataset.queueId = id;

  chatInput.value = '';
  chatInput.style.height = 'auto';
  clearAttachments();
  updateComposerForQueue();
  if (isProcessing) {
    const qn = promptQueue.filter((p) => p.sessionId === currentSessionId).length;
    statusText.textContent = qn > 0 ? ('处理中…（已插入 ' + qn + ' 条）') : '处理中...';
  }
  console.log('[Queue] enqueued', id, 'size=', promptQueue.length);
  if (opts && opts.interrupt) requestImmediateQueueHandoff(currentSessionId);
}

/**
 * Codex-style steer: an inserted prompt takes over the active turn instead
 * of waiting for every remaining model/tool step to finish. The cancellation
 * event is the handoff barrier; drainQueuedPrompts starts the new prompt only
 * after the server confirms the previous stream has stopped.
 */
function requestImmediateQueueHandoff(sessionId = currentSessionId) {
  if (!sessionId) return;
  const runtime = runtimeForSession(sessionId);
  if (runtime.queueHandoffPending) return;
  runtime.queueHandoffPending = true;
  runtime.turnStopPending = true;
  runtime.suppressQueueDrain = false;
  snapshotActiveSessionRuntime();
  statusText.textContent = '正在接入插入的对话…';
  fetch(API_BASE + '/api/cancel?sessionId=' + encodeURIComponent(sessionId), { method: 'POST' })
    .then((response) => {
      if (!response.ok) throw new Error('当前任务未能中断');
    })
    .catch((error) => {
      runtime.queueHandoffPending = false;
      console.warn('[Queue] immediate handoff failed', error);
      // Keep the prompt queued; a normal completion can still drain it.
      if (sessionId === currentSessionId) statusText.textContent = '插入的对话将在当前任务结束后执行';
      snapshotActiveSessionRuntime();
    });
}

/** Withdraw a queued bubble before it is drained. */
function withdrawQueuedMessage(queueId) {
  promptQueue = promptQueue.filter((p) => p.id !== queueId);
  const el = chatMessages.querySelector('.message.user.is-queued[data-queue-id="' + queueId + '"]');
  if (el) el.remove();
  updateComposerForQueue();
  if (isProcessing) {
    const qn = promptQueue.filter((p) => p.sessionId === currentSessionId).length;
    statusText.textContent = qn > 0 ? ('处理中…（已插入 ' + qn + ' 条）') : '处理中...';
  }
  console.log('[Queue] withdrew', queueId, 'size=', promptQueue.length);
}
window.withdrawQueuedMessage = withdrawQueuedMessage;

/**
 * Insert a prompt into the running turn without cancelling it. The server
 * commits it at the next model step, so completed tool work is preserved.
 */
async function steerPrompt() {
  const message = chatInput.value.trim();
  const attachments = cloneAttachments(pendingAttachments);
  if ((!message && attachments.length === 0) || !isProcessing || !currentSessionId) return;
  const sessionId = currentSessionId;
  const displayText = message || (attachments.length
    ? ('（附件：' + attachments.map((a) => a.name).join('、') + '）')
    : '');
  const steerId = 'steer_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const steerEl = addMessage('user', displayText, attachments, { steering: true, steerId });
  steerEl._steerPayload = { sessionId: sessionId, displayText: displayText, attachments: attachments };
  chatInput.value = '';
  chatInput.style.height = 'auto';
  clearAttachments();
  scrollToBottom(false, true);
  if (sessionId === visibleSessionId) statusText.textContent = '正在插入对话…';

  try {
    const prepared = await prepareAttachmentsForChat(attachments, sessionId, { forceUpload: true });
    const response = await fetch(API_BASE + '/api/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IEXA-Client-Id': conversationClientId },
      body: JSON.stringify({
        sessionId: sessionId,
        steerId: steerId,
        message: message,
        attachments: (prepared || []).map((a) => ({
          name: a.name,
          mime: a.mime,
          kind: a.kind,
          dataUrl: a.dataUrl || undefined,
          text: a.text || undefined,
          savedPath: a.savedPath || undefined,
          size: a.size || undefined,
        })),
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || ('插入失败：' + response.status));
    }
  } catch (error) {
    console.warn('[Steer] falling back to queue', error);
    demoteSteerToQueue(steerId, displayText, attachments, error.message);
    if (sessionId === visibleSessionId) statusText.textContent = '插入未送达，已转为排队';
  }
}

/**
 * A pending steer bubble may have been moved into its session's detached
 * fragment while the reader looked at another conversation. Find it there so
 * the commit/fallback still lands on the right bubble.
 */
function findSteerElement(steerId) {
  const selector = '.message.user.is-steering[data-steer-id="' + steerId + '"]';
  const visible = chatMessages.querySelector(selector);
  if (visible) return visible;
  for (const runtime of sessionRuntimes.values()) {
    const el = runtime.fragment?.querySelector?.(selector);
    if (el) return el;
  }
  return null;
}

/** The server committed the steer into the live turn: drop the pending look. */
function markSteerApplied(steerId, timestamp) {
  const el = findSteerElement(steerId);
  if (!el) return;
  el.classList.remove('is-steering');
  el.querySelector('.steer-badge')?.remove();
  if (!el.dataset.messageIndex) {
    const surface = el.parentNode || chatMessages;
    el.dataset.messageIndex = String(surface.querySelectorAll('.message:not(.is-queued):not(.is-steering)').length);
  }
  el.dataset.timestamp = String(timestamp || Date.now());
}

/** A steer could not enter the running turn: keep it as a normal queue item. */
function demoteSteerToQueue(steerId, displayText, attachments, reason) {
  const el = findSteerElement(steerId);
  const payload = el?._steerPayload || {};
  const sessionId = payload.sessionId || currentSessionId;
  if (!sessionId) return;
  const text = displayText || payload.displayText || '';
  const files = (attachments && attachments.length) ? attachments : (payload.attachments || []);
  if (el) el.remove();
  const queueId = makeQueueId();
  // The owner may no longer be the visible conversation; keep the queue item
  // on its own runtime instead of dropping it into whoever is on screen.
  const runtime = runtimeForSession(sessionId);
  (runtime.promptQueue || (runtime.promptQueue = [])).push({
    id: queueId,
    sessionId: sessionId,
    text: text,
    displayText: text,
    attachments: files,
  });
  withSessionRuntime(sessionId, () => {
    addMessage('user', text, files, { queued: true, queueId: queueId });
  });
  if (sessionId === currentSessionId) updateComposerForQueue();
  if (reason) console.warn('[Steer] demoted to queue:', reason);
  if (sessionId === currentSessionId && !isProcessing) scheduleQueueDrain(sessionId);
}

function markQueuedMessagesActive(ids) {
  const set = new Set(ids);
  chatMessages.querySelectorAll('.message.user.is-queued').forEach((el) => {
    const qid = el.dataset.queueId;
    if (qid && set.has(qid)) {
      if (!el.dataset.messageIndex) {
        el.dataset.messageIndex = String(chatMessages.querySelectorAll('.message:not(.is-queued)').length);
        el.dataset.timestamp = String(Date.now());
      }
      el.classList.remove('is-queued');
      const badge = el.querySelector('.queued-badge');
      if (badge) badge.remove();
    }
  });
}

function updateComposerForQueue() {
  if (!sendBtn || !stopBtn) return;
  // A queue drain can be triggered by a background conversation. Its state is
  // stored in that runtime, but it must not rewrite the visible composer's
  // controls or steal typing focus from the selected conversation.
  if (currentSessionId !== visibleSessionId) return;
  if (isProcessing) {
    sendBtn.style.display = 'flex';
    stopBtn.style.display = 'flex';
    sendBtn.disabled = false;
    const qn = promptQueue.filter((p) => p.sessionId === currentSessionId).length;
    const meta = FOLLOW_UP_MODE_META[followUpMode] || FOLLOW_UP_MODE_META.queue;
    sendBtn.title = qn > 0
      ? ('已插入 ' + qn + ' 条 · ' + meta.label)
      : meta.title;
    sendBtn.setAttribute('aria-label', followUpMode === 'steer' ? '插入对话' : followUpMode === 'interrupt' ? '中断并发送' : '排队发送');
    sendBtn.classList.add('is-queue-mode');
    chatInput.placeholder = followUpMode === 'steer'
      ? '任务进行中，Enter 插入本轮（Ctrl+Shift+Enter 排队）'
      : followUpMode === 'interrupt'
        ? '任务进行中，Enter 中断并立即发送（Ctrl+Shift+Enter 排队）'
        : '任务进行中，Enter 排队（Ctrl+Shift+Enter 插入本轮）';
    if (attachBtn) attachBtn.disabled = false;
    chatInput.disabled = false;
  } else {
    sendBtn.classList.remove('is-queue-mode');
    sendBtn.title = '发送 (Enter)';
    sendBtn.setAttribute('aria-label', '发送');
    chatInput.placeholder = '有问题，随便问';
  }
  renderFollowUpMode();
}

/** Show the active follow-up mode only while a turn can accept one. */
function renderFollowUpMode() {
  const btn = document.getElementById('followUpModeBtn');
  if (!btn) return;
  const meta = FOLLOW_UP_MODE_META[followUpMode] || FOLLOW_UP_MODE_META.queue;
  btn.textContent = meta.label;
  btn.title = meta.title;
  btn.dataset.mode = followUpMode;
  btn.hidden = !isProcessing;
}

/** After a turn ends, auto-run the next queued prompt(s). */
async function drainQueuedPrompts(sessionId = currentSessionId) {
  if (!sessionId) return;
  const runtime = runtimeForSession(sessionId);
  if (runtime.suppressQueueDrain) {
    console.log('[Queue] drain suppressed');
    return;
  }
  if (runtime.isDrainingQueue) {
    console.log('[Queue] already draining');
    return;
  }
  // Wait for the old SSE stream's terminal frame. Starting a new /api/chat
  // request as soon as /api/cancel responds races the same server-side Agent.
  if (runtime.turnStopPending) return;
  if (runtime.isProcessing) return;
  if (!(runtime.promptQueue || []).some((p) => p.sessionId === sessionId)) return;

  runtime.isDrainingQueue = true;
  runtime.queueHandoffPending = false;
  try {
    while (!runtime.suppressQueueDrain && !runtime.isProcessing) {
      const queue = runtime.promptQueue || [];
      const nextIdx = queue.findIndex((p) => p.sessionId === sessionId);
      if (nextIdx < 0) break;
      const next = queue.splice(nextIdx, 1)[0];
      console.log('[Queue] draining', next.id, 'remaining=', queue.length);
      await withSessionRuntime(sessionId, function () {
        markQueuedMessagesActive([next.id]);
        return runChatTurn(next.text, next.displayText, next.attachments, { fromQueue: true, queueId: next.id });
      });
      if (runtime.suppressQueueDrain) break;
      // yield so a last-moment enqueue can land before loop checks length
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    runtime.isDrainingQueue = false;
    if (sessionId === visibleSessionId) updateComposerForQueue();
    // Late arrivals enqueued while the last drain turn was finishing
    if (!runtime.suppressQueueDrain && !runtime.isProcessing && (runtime.promptQueue || []).some((p) => p.sessionId === sessionId)) {
      scheduleQueueDrain(sessionId);
    }
  }
}

function scheduleQueueDrain(sessionId = currentSessionId) {
  if (!sessionId) return;
  const runtime = runtimeForSession(sessionId);
  if (runtime.suppressQueueDrain || runtime.isProcessing || runtime.isDrainingQueue) return;
  if (!(runtime.promptQueue || []).some((p) => p.sessionId === sessionId)) return;
  // Let SSE finally / setProcessing settle first
  Promise.resolve().then(function () {
    setTimeout(function () {
      drainQueuedPrompts(sessionId).catch(function (err) {
        console.error('[Queue] drain failed', err);
      });
    }, 30);
  });
}

// =============================================================================
// Send Message
// =============================================================================

async function sendMessage(event) {
  const message = chatInput.value.trim();
  const attachments = cloneAttachments(pendingAttachments);
  if (!message && attachments.length === 0) return;

  // Busy → route by the active follow-up mode (Codex parity: queue/steer/interrupt).
  if (isProcessing) {
    const effective = isFollowUpModifier(event) ? oppositeFollowUpMode() : followUpMode;
    if (effective === 'steer') {
      await steerPrompt();
      return;
    }
    if (effective === 'interrupt') {
      enqueuePrompt({ interrupt: true });
      return;
    }
    enqueuePrompt();
    return;
  }

  // Auto-create session if needed
  if (!currentSessionId) {
    await createSession();
    if (!currentSessionId) return;
  }

  const welcome = chatMessages.querySelector('.welcome');
  if (welcome) welcome.remove();

  const displayText = message || (attachments.length
    ? ('（附件：' + attachments.map((a) => a.name).join('、') + '）')
    : '');

  const sendOrigin = chatInput.getBoundingClientRect();
  const sentMessage = addMessage('user', displayText, attachments, { timestamp: Date.now() });

  chatInput.value = '';
  chatInput.style.height = 'auto';
  clearAttachments();
  window.IexaChatPresentation?.animateSend(sentMessage, sendOrigin);

  suppressQueueDrain = false;
  await runChatTurn(message || displayText, displayText, attachments, { fromQueue: false });
}

/**
 * Run one user→assistant chat turn (SSE). Shared by normal send + queue drain.
 */
async function uploadLargeAttachment(attachment, sessionId) {
  const file = attachment.file;
  if (!file || file.size <= MAX_ATTACH_BYTES) return attachment;
  const initResponse = await fetch(API_BASE + '/api/uploads/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, name: attachment.name, mime: attachment.mime, kind: attachment.kind, size: file.size }),
  });
  const init = await initResponse.json().catch(() => ({}));
  if (!initResponse.ok || !init.uploadId) throw new Error(init.error || '大文件上传初始化失败。');
  const chunkBytes = Number(init.chunkBytes) || UPLOAD_CHUNK_BYTES;
  let offset = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
    const response = await fetch(API_BASE + '/api/uploads/chunk?uploadId=' + encodeURIComponent(init.uploadId) + '&offset=' + offset, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `大文件上传失败（${offset}/${file.size}）。`);
    offset = Number(result.received);
    if (!Number.isFinite(offset) || offset <= 0) throw new Error('服务器返回了无效的上传偏移。');
    if (typeof statusText !== 'undefined' && statusText) statusText.textContent = `上传 ${attachment.name}：${Math.floor(offset / file.size * 100)}%`;
  }
  const completeResponse = await fetch(API_BASE + '/api/uploads/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  const complete = await completeResponse.json().catch(() => ({}));
  if (!completeResponse.ok || !complete.savedPath) throw new Error(complete.error || '大文件上传完成失败。');
  return { name: attachment.name, mime: attachment.mime, kind: attachment.kind, size: attachment.size, savedPath: complete.savedPath, large: true };
}

async function prepareAttachmentsForChat(attachments, sessionId, opts) {
  const forceUpload = !!(opts && opts.forceUpload);
  const prepared = [];
  for (const attachment of (attachments || [])) {
    prepared.push(attachment.file && (forceUpload || attachment.file.size > MAX_ATTACH_BYTES)
      ? await uploadLargeAttachment(attachment, sessionId)
      : attachment);
  }
  return prepared;
}

async function runChatTurn(message, displayText, attachments, opts) {
  opts = opts || {};
  if (isProcessing) return;
  const sessionId = currentSessionId;
  const turnThinkingLevel = currentThinkingLevel;
  const turnToken = ++activeChatTurnToken;
  // Measured from the send, so attachment uploads count toward the turn timer.
  const turnStartedAt = Date.now();
  setProcessing(true);
  snapshotActiveSessionRuntime();
  document.querySelectorAll('.error-message').forEach(function (el) { el.remove(); });

  try {
    const preparedAttachments = await prepareAttachmentsForChat(attachments, sessionId);
    if (typeof statusText !== 'undefined' && statusText) statusText.textContent = '处理中...';
    const response = await fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IEXA-Client-Id': conversationClientId, 'X-IEXA-Stream': 'delta' },
      body: JSON.stringify({
        message: message || displayText,
        sessionId: sessionId,
        attachments: (preparedAttachments || []).map(function (a) {
          return {
            name: a.name,
            mime: a.mime,
            kind: a.kind,
            dataUrl: a.dataUrl || undefined,
            text: a.text || undefined,
            savedPath: a.savedPath || undefined,
            size: a.size || undefined,
          };
        }),
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(function () { return {}; });
      throw new Error(data.error || ('服务器错误：' + response.status));
    }

    // The fetch may resolve after the user has opened another session.
    // Create this response placeholder in its owning session, never whichever
    // conversation happens to be visible at that instant.
    withSessionRuntime(sessionId, () => {
      currentAssistantMsg = addMessage('assistant', '', undefined, { streaming: true, turnStartedAt });
      currentAssistantMsg.dataset.liveSessionId = sessionId;
      currentAssistantMsg.dataset.thinkingLevel = turnThinkingLevel;
      showWaitingIndicator();
      currentToolBlocks = {};
      currentTaskToolCount = 0;
      currentTaskStartedAt = 0;
      currentTaskSummary = null;
      if (currentTaskTimer) window.clearInterval(currentTaskTimer);
      currentTaskTimer = null;
      snapshotActiveSessionRuntime();
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const step = await reader.read();
      if (step.done) break;

      buffer += decoder.decode(step.value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.trim()) continue;
        withSessionRuntime(sessionId, () => handleSSEEvent(part.trim(), turnToken));
      }
    }

    // Stream closed without done/error/cancelled
    withSessionRuntime(sessionId, () => {
      const runtime = runtimeForSession(sessionId);
      // A manual stop sets isProcessing=false before the reader observes the
      // closed stream. Treat that close as the terminal event as well, or the
      // stop gate would remain set forever and queued prompts would stall.
      if (turnToken === activeChatTurnToken && (isProcessing || runtime.turnStopPending)) {
        protectLiveTurnDom(sessionId);
        runtime.turnStopPending = false;
        hideWaitingIndicator();
        finishTaskSummary();
        finalizeAssistantMessage(currentAssistantMsg);
        setProcessing(false);
        scheduleQueueDrain();
      }
      snapshotActiveSessionRuntime();
    });
  } catch (err) {
    withSessionRuntime(sessionId, () => {
      if (turnToken !== activeChatTurnToken) return;
      protectLiveTurnDom(sessionId);
      runtimeForSession(sessionId).turnStopPending = false;
      addError(err.message || String(err));
      hideWaitingIndicator();
      finishTaskSummary();
      finalizeAssistantMessage(currentAssistantMsg);
      setProcessing(false);
      scheduleQueueDrain();
      snapshotActiveSessionRuntime();
    });
  }
}

let desktopLivePanel;
let desktopLiveEnabled = false;
let desktopLiveTimer;
let desktopLiveUrl;
let desktopLivePolling = false;
let desktopLiveDetached = false;
const DESKTOP_LIVE_POSITION_KEY = 'iexa-desktop-live-panel-position-v1';

function showDesktopLive() {
  if (window.iexaDesktop?.getDesktopLiveWindowState) {
    window.iexaDesktop.getDesktopLiveWindowState().then((state) => {
      if (state?.open) {
        desktopLiveDetached = true;
        window.iexaDesktop.openDesktopLiveWindow();
        return;
      }
      showEmbeddedDesktopLive();
    }).catch(() => showEmbeddedDesktopLive());
    return;
  }
  showEmbeddedDesktopLive();
}

function showEmbeddedDesktopLive() {
  if (desktopLivePanel) { desktopLivePanel.hidden = false; clampDesktopLivePanel(); return; }
  desktopLivePanel = document.createElement('section');
  desktopLivePanel.className = 'desktop-live-panel';
  desktopLivePanel.innerHTML = '<header data-live-drag><span class="desktop-live-indicator" aria-hidden="true"></span><strong>实况桌面</strong><div class="desktop-live-actions"><button type="button" data-live-toggle>开启预览</button><button type="button" data-live-stop>停止操作</button><button type="button" data-live-resume>恢复操作</button><button type="button" data-live-detach>独立悬浮</button><button type="button" data-live-close>收起</button></div></header><p data-live-status>预览待机</p><div class="desktop-live-frame"><img alt="目标窗口实时画面" hidden></div>';
  document.body.appendChild(desktopLivePanel);
  restoreDesktopLivePanelPosition();
  enableDesktopLivePanelDrag();
  desktopLivePanel.querySelector('[data-live-resume]').onclick = async () => {
    const status = desktopLivePanel.querySelector('[data-live-status]');
    try {
      const response = await fetch('/api/desktop-live/resume', { method: 'POST' });
      status.textContent = response.ok ? '已恢复操作权限，请重新发起任务' : '恢复失败';
    } catch { status.textContent = '桌面服务连接失败'; }
  };
  desktopLivePanel.querySelector('[data-live-toggle]').onclick = () => {
    desktopLiveEnabled = !desktopLiveEnabled;
    desktopLivePanel.querySelector('[data-live-toggle]').textContent = desktopLiveEnabled ? '暂停预览' : '开启预览';
    clearTimeout(desktopLiveTimer);
    if (desktopLiveEnabled) pollDesktopLive();
  };
  desktopLivePanel.querySelector('[data-live-close]').onclick = () => {
    hideEmbeddedDesktopLive();
  };
  const detach = desktopLivePanel.querySelector('[data-live-detach]');
  if (!window.iexaDesktop?.openDesktopLiveWindow) detach.hidden = true;
  detach.onclick = async () => {
    const status = desktopLivePanel.querySelector('[data-live-status]');
    try {
      const state = await window.iexaDesktop.openDesktopLiveWindow();
      desktopLiveDetached = state?.open === true;
      if (desktopLiveDetached) hideEmbeddedDesktopLive();
    } catch (error) {
      status.textContent = error?.message || '独立窗口启动失败';
    }
  };
  desktopLivePanel.querySelector('[data-live-stop]').onclick = async () => {
    const status = desktopLivePanel.querySelector('[data-live-status]');
    try {
      const response = await fetch('/api/desktop-live/cancel', { method: 'POST' });
      const result = await response.json();
      status.textContent = result.paused ? (result.settled ? '已停止操控；恢复后请重新发起任务' : '已请求停止，等待当前动作结束；先前动作可能已生效') : '停止请求失败，请检查桌面服务';
    } catch { status.textContent = '连接中断，请手动切换目标窗口'; }
  };
}

function hideEmbeddedDesktopLive() {
  desktopLiveEnabled = false;
  clearTimeout(desktopLiveTimer);
  if (!desktopLivePanel) return;
  desktopLivePanel.hidden = true;
  desktopLivePanel.querySelector('[data-live-toggle]').textContent = '开启预览';
  if (desktopLiveUrl) URL.revokeObjectURL(desktopLiveUrl);
  desktopLiveUrl = null;
  desktopLivePanel.querySelector('img').hidden = true;
}

function restoreDesktopLivePanelPosition() {
  if (!desktopLivePanel) return;
  try {
    const saved = JSON.parse(localStorage.getItem(DESKTOP_LIVE_POSITION_KEY) || 'null');
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      desktopLivePanel.style.left = `${saved.left}px`;
      desktopLivePanel.style.top = `${saved.top}px`;
      desktopLivePanel.style.right = 'auto';
      desktopLivePanel.style.bottom = 'auto';
    }
  } catch {}
  requestAnimationFrame(clampDesktopLivePanel);
}

function clampDesktopLivePanel() {
  if (!desktopLivePanel || desktopLivePanel.hidden) return;
  const rect = desktopLivePanel.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(rect.width, window.innerWidth) - 8));
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - Math.min(rect.height, window.innerHeight) - 8));
  desktopLivePanel.style.left = `${left}px`;
  desktopLivePanel.style.top = `${top}px`;
  desktopLivePanel.style.right = 'auto';
  desktopLivePanel.style.bottom = 'auto';
}

function enableDesktopLivePanelDrag() {
  const handle = desktopLivePanel?.querySelector('[data-live-drag]');
  if (!handle) return;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = desktopLivePanel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    desktopLivePanel.classList.add('is-dragging');
    handle.setPointerCapture?.(event.pointerId);
    const move = (next) => {
      const left = Math.max(8, Math.min(next.clientX - offsetX, window.innerWidth - desktopLivePanel.offsetWidth - 8));
      const top = Math.max(8, Math.min(next.clientY - offsetY, window.innerHeight - desktopLivePanel.offsetHeight - 8));
      desktopLivePanel.style.left = `${left}px`;
      desktopLivePanel.style.top = `${top}px`;
      desktopLivePanel.style.right = 'auto';
      desktopLivePanel.style.bottom = 'auto';
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      desktopLivePanel.classList.remove('is-dragging');
      const position = desktopLivePanel.getBoundingClientRect();
      localStorage.setItem(DESKTOP_LIVE_POSITION_KEY, JSON.stringify({ left: Math.round(position.left), top: Math.round(position.top) }));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
}

window.addEventListener('resize', clampDesktopLivePanel);
window.iexaDesktop?.onDesktopLiveClosed?.(() => { desktopLiveDetached = false; });

async function pollDesktopLive() {
  if (!desktopLiveEnabled || desktopLivePolling) return;
  desktopLivePolling = true;
  const started = performance.now();
  try {
    if (document.visibilityState !== 'visible') return;
    const response = await fetch('/api/desktop-live/frame', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      let detail = '桌面服务未启动或暂不可用';
      try { const payload = await response.json(); if (typeof payload.error === 'string') detail = payload.error; } catch {}
      throw new Error(detail);
    }
    const blob = await response.blob();
    if (!desktopLiveEnabled) return;
    const image = desktopLivePanel.querySelector('img');
    const previous = desktopLiveUrl;
    desktopLiveUrl = URL.createObjectURL(blob);
    image.src = desktopLiveUrl;
    image.hidden = false;
    if (previous) URL.revokeObjectURL(previous);
    const capturedAt = Number(response.headers.get('x-captured-at'));
    desktopLivePanel.querySelector('[data-live-status]').textContent = `最近观察快照 · ${capturedAt > 0 ? new Date(capturedAt).toLocaleTimeString() : '时间未知'} · 不主动截取后台窗口`;
  } catch (error) {
    if (desktopLiveEnabled) desktopLivePanel.querySelector('[data-live-status]').textContent = error.message;
  } finally {
    desktopLivePolling = false;
    if (desktopLiveEnabled) desktopLiveTimer = setTimeout(pollDesktopLive, Math.max(500, 800 - (performance.now() - started)));
  }
}

async function exportDiagnostics() {
  const target = document.getElementById('diagnosticsResult');
  if (target) target.textContent = IexaI18n.t('diagnostics.exporting');
  try {
    const response = await fetch(`${API_BASE}/api/diagnostics/export`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'export failed');
    const size = Math.max(1, Math.round(Number(data.bytes) / 1024));
    if (target) target.textContent = IexaI18n.t('diagnostics.done', { path: data.path, size });
  } catch (error) {
    if (target) target.textContent = IexaI18n.t('diagnostics.failed', { message: error.message || String(error) });
  }
}

window.addEventListener('resize', () => {
  if (checkpointOpen) positionCheckpointPopover();
});

function handleUsage(usage) {
  if (currentAssistantMsg) {
    let usageEl = currentAssistantMsg.querySelector('.message-usage');
    if (!usageEl) {
      usageEl = document.createElement('div');
      usageEl.className = 'message-usage';
      const footer = currentAssistantMsg.querySelector('.assistant-message-footer');
      const actions = currentAssistantMsg.querySelector('.assistant-message-actions');
      if (footer && actions) footer.insertBefore(usageEl, actions); else currentAssistantMsg.appendChild(usageEl);
    }
    renderMessageUsage(usageEl, usage.inputTokens || 0, usage.outputTokens || 0, usage.cacheReadInputTokens);
  }
  // The server has already persisted this receipt; reload immediately for live totals.
  loadTokenUsage();
}

function handleError(message, turnToken) {
  if (turnToken != null && turnToken !== activeChatTurnToken) return;
  window.IexaPermissionDialog.closeSession?.(currentSessionId);
  protectLiveTurnDom();
  runtimeForSession(currentSessionId).turnStopPending = false;
  finishActiveThinkingBlock();
  hideWaitingIndicator();
  finalizeAssistantMessage(currentAssistantMsg);
  addError(message);
  clearContextBusy();
  setProcessing(false);
  scheduleQueueDrain();
}

function handleSessionTitle(sessionId, title, category) {
  if (!sessionId || !title) return;
  const s = sessionsCache.find((x) => x.id === sessionId);
  if (s) {
    s.title = title;
    s.titleSource = 'ai';
    if (category) s.category = category;
  }
  const el = document.querySelector(`.session-item-title[data-sid="${sessionId}"]`);
  if (el && el.tagName !== 'INPUT') {
    el.textContent = title;
    if (category) el.title = category;
  } else {
    renderSessionList();
  }
}

function handleDone(stopReason, turnToken) {
  if (turnToken != null && turnToken !== activeChatTurnToken) return;
  window.IexaPermissionDialog.closeSession?.(currentSessionId);
  const followLatest = shouldFollowLatestMessage();
  const preserveScrollTop = visibleChatMessages.scrollTop;
  const preserveScroll = !followLatest;
  // setProcessing(false) can immediately drain a pending metadata sync. Mark
  // this completed stream as authoritative before that sync gets scheduled.
  protectLiveTurnDom();
  runtimeForSession(currentSessionId).turnStopPending = false;
  finishTaskSummary();
  clearContextBusy();
  setProcessing(false);

  // Keep the streamed reasoning as a compact completed record.
  hideWaitingIndicator();
  finishActiveThinkingBlock();

  if (currentAssistantMsg) {
    finalizeAssistantMessage(currentAssistantMsg);
    if (stopReason === 'maxTokens') {
      const notice = document.createElement('div');
      notice.className = 'error-message stream-limit-notice';
      notice.innerHTML = uiIcon('info') + '<span>模型已达到本轮最大输出长度，已保留当前思考和回复内容。</span>';
      currentAssistantMsg.appendChild(notice);
    }
  }
  currentAssistantMsg = null;
  currentToolBlocks = {};

  // Update metadata without rebuilding the current chat surface. A second
  // full session load here used to cause a visible double flash at completion.
  syncConversationMetadata().catch(() => {});
  // A goal tool may have just created or finished the objective.
  void refreshGoalBanner();
  // Refresh project files so tool writes are visible
  if (typeof refreshFilesPanelSoft === 'function') refreshFilesPanelSoft();
  if (followLatest) {
    // A final text batch may have queued a bottom-follow frame before this
    // terminal event. Keep that intent; do not restore the pre-batch scrollTop.
    scrollToBottom(false, true);
  } else if (preserveScroll) requestAnimationFrame(() => {
    visibleChatMessages.scrollTop = preserveScrollTop;
    isNearChatBottom = isChatNearBottom();
    updateScrollToBottomButton();
  });

  // iOS drainQueuedPrompts: auto-run messages inserted during the previous turn
  scheduleQueueDrain();
}

function handleCancelled(turnToken) {
  if (turnToken != null && turnToken !== activeChatTurnToken) return;
  window.IexaPermissionDialog.closeSession?.(currentSessionId);
  window.IexaQuestionCard?.disableForSession?.(currentSessionId, 'cancelled');
  const followLatest = shouldFollowLatestMessage();
  const preserveScrollTop = visibleChatMessages.scrollTop;
  const preserveScroll = !followLatest;
  protectLiveTurnDom();
  runtimeForSession(currentSessionId).turnStopPending = false;
  finishActiveThinkingBlock();
  hideWaitingIndicator();
  finishTaskSummary();
  finalizeAssistantMessage(currentAssistantMsg);
  clearContextBusy();
  setProcessing(false);
  currentAssistantMsg = null;
  currentToolBlocks = {};

  const cancelNote = document.createElement('div');
  cancelNote.className = 'error-message';
  cancelNote.innerHTML = uiIcon('info') + '<span>任务已取消。</span>';
  chatMessages.appendChild(cancelNote);
  if (followLatest) {
    scrollToBottom(false, true);
  } else if (preserveScroll) requestAnimationFrame(() => {
    visibleChatMessages.scrollTop = preserveScrollTop;
    isNearChatBottom = isChatNearBottom();
    updateScrollToBottomButton();
  });

  // iOS resumeQueueAfterCancel: stop current turn, then continue queued inserts
  if (!suppressQueueDrain) scheduleQueueDrain();
}

function clearContextBusy() {
  if (currentSessionId !== visibleSessionId) return;
  if (!contextProgress) return;
  if (contextProgress.dataset.state !== 'compacting') return;
  contextProgress.dataset.state = 'ok';
  if (contextProgressTooltip) contextProgressTooltip.textContent = '上下文用量';
}

// =============================================================================
// Stop Processing
// =============================================================================

async function stopProcessing() {
  // Mirror iOS cancel(): stop current agent turn, but KEEP promptQueue and
  // resume draining remaining inserted messages after cleanup.
  // (Session switch/create sets suppressQueueDrain=true before calling this.)
  // The cancel HTTP response can arrive before the server's onCancelled
  // callback persists the partial assistant reply. Claim the live DOM before
  // changing isProcessing so metadata sync cannot reload an incomplete history
  // snapshot and wipe the streamed content from the screen.
  protectLiveTurnDom();
  const runtime = runtimeForSession(currentSessionId);
  runtime.turnStopPending = true;
  // Remove the indicator synchronously; the cancellation SSE event may arrive
  // later, and late tool results are blocked from adding it back above.
  hideWaitingIndicator();
  try {
    const sid = currentSessionId || '';
    const response = await fetch(API_BASE + '/api/cancel?sessionId=' + encodeURIComponent(sid), { method: 'POST' });
    if (!response.ok) throw new Error('停止请求失败，请重试。');
    if (runtime.turnStopPending) statusText.textContent = '正在停止，等待执行器清理…';
  } catch (e) {
    runtime.turnStopPending = false;
    addError(e.message || '停止请求失败，请重试。');
  }
  // Keep processing true until the terminal SSE event confirms actual cleanup.
  // The SSE terminal event clears turnStopPending and drains the queue. Do not
  // start another request merely because the cancel HTTP call returned.
}

// =============================================================================
// Utility
// =============================================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// WebDAV Sync
// =============================================================================

// Load config when entering sync view
const syncNav = document.querySelector('[data-view="sync"]');
if (syncNav) {
  syncNav.addEventListener('click', () => {
    loadWebDAVConfig();
  });
}

// =============================================================================
// Initialize
// =============================================================================

// When entering settings view, refresh the list
const settingsBtn = document.querySelector('[data-view="settings"]');
if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    renderProfileList();
  });
}

async function loadSystemInfo() {
  const el = document.getElementById('sysVersion');
  if (!el) return;
  try {
    const resp = await fetch(`${API_BASE}/api/system`);
    const data = await resp.json();
    if (data && data.label) {
      el.textContent = data.label;
      el.title = data.release ? `内核 ${data.release}` : data.label;
    }
  } catch {
    el.textContent = 'Windows';
  }
}

// =============================================================================
// Theme (light default)
// =============================================================================

const ACCENT_PRESETS = [
  { id: 'amber', label: '琥珀', color: '#c4841d' },
  { id: 'violet', label: '紫罗兰', color: '#6c63ff' },
  { id: 'blue', label: '蓝', color: '#2563eb' },
  { id: 'green', label: '绿', color: '#16a34a' },
  { id: 'rose', label: '玫红', color: '#e11d48' },
  { id: 'mono', label: '灰色', color: '#4b4646' },
];
let appearanceSaveTimer = null;

function currentAppearance() {
  return {
    ...(window.IexaUiScale?.current() || {fontScale:100,iconScale:100}),
    theme: getThemeMode(),
    motion: getMotionMode(),
    accent: getAccent(),
    collapseConsecutiveTools: consecutiveToolFoldEnabled(),
    sidebarWidth: panelWidthValue('sidebar', '--sidebar-width', 240),
    filesPanelWidth: panelWidthValue('filesPanel', '--files-panel-width', 300),
  };
}

// Panel widths live on the panel itself (see initPanelResizers) so a drag does
// not invalidate the whole document; read them from there, falling back to the
// :root defaults that the stylesheet and startup settings provide.
function panelWidthValue(id, variable, fallback) {
  const element = document.getElementById(id);
  const value = element ? Number.parseInt(getComputedStyle(element).getPropertyValue(variable), 10) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function scheduleAppearanceSave() {
  if (appearanceSaveTimer) window.clearTimeout(appearanceSaveTimer);
  appearanceSaveTimer = window.setTimeout(async () => {
    appearanceSaveTimer = null;
    try {
      await fetch(`${API_BASE}/api/appearance`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentAppearance()),
      });
    } catch { /* localStorage remains the browser fallback */ }
  }, 180);
}

async function loadAppearanceSettings() {
  try {
    const response = await fetch(`${API_BASE}/api/appearance`, { cache: 'no-store' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '读取外观设置失败');
    const mode = value.theme === 'dark' ? 'dark' : 'light';
    const accent = ACCENT_PRESETS.some((item) => item.id === value.accent) ? value.accent : 'violet';
    document.documentElement.setAttribute('data-theme', mode);
    applyMotionMode(value.motion);
    window.IexaUiScale?.apply(value);
    document.documentElement.setAttribute('data-accent', accent);
    applyConsecutiveToolFoldSetting(value.collapseConsecutiveTools === true);
    if (window.IexaPanelWidths) {
      // The panel module owns these properties once it has run. Writing them on
      // :root as well would invalidate the computed style of every node in a
      // long transcript, and a late resolution could land in the middle of a
      // resize drag.
      window.IexaPanelWidths.set(value.sidebarWidth || 240, value.filesPanelWidth || 300);
    } else {
      // First paint before the panel module exists: seed the inherited fallback
      // it reads on startup.
      document.documentElement.style.setProperty('--sidebar-width', `${value.sidebarWidth || 240}px`);
      document.documentElement.style.setProperty('--files-panel-width', `${value.filesPanelWidth || 300}px`);
    }
    try { localStorage.setItem('iexa-theme', mode); localStorage.setItem('iexa-accent', accent); } catch { /* */ }
    applyHighlightTheme(mode);
    syncThemeUI();
  } catch { /* keep preload/localStorage appearance */ }
}

function getMotionMode() {
  const value = document.documentElement.getAttribute('data-motion');
  return ['system', 'full', 'reduced'].includes(value) ? value : 'system';
}

function applyMotionMode(value) {
  const mode = ['system', 'full', 'reduced'].includes(value) ? value : 'system';
  document.documentElement.setAttribute('data-motion', mode);
  try { localStorage.setItem('iexa-motion', mode); } catch { /* current window still applies it */ }
}

// "Follow system" is a real choice, but on Windows the flag behind it is the
// same one that "Show animations in Windows" controls, and it is off on plenty
// of desktops, RDP sessions and servers. When that happens the app looks
// frozen and nobody knows why, so say it next to the setting instead of
// silently animating nothing.
let motionHintBase;
function syncMotionHint() {
  const hint = document.getElementById('motionHelp');
  if (!hint) return;
  if (motionHintBase === undefined) motionHintBase = hint.textContent || '';
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const suppressed = getMotionMode() === 'system' && reduced;
  hint.textContent = suppressed
    ? `${motionHintBase} 系统当前要求减少动效，选择「完整动效」可覆盖。`
    : motionHintBase;
}

function setMotionMode(value) {
  applyMotionMode(value);
  syncThemeUI();
  scheduleAppearanceSave();
}

function getThemeMode() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function getAccent() {
  let a = document.documentElement.getAttribute('data-accent') || 'violet';
  if (a === 'opencode') a = 'amber';
  return a;
}

function setThemeMode(mode) {
  const m = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', m);
  try { localStorage.setItem('iexa-theme', m); } catch { /* */ }
  applyHighlightTheme(m);
  syncThemeUI();
  scheduleAppearanceSave();
}

function applyHighlightTheme(mode) {
  const light = document.getElementById('hljs-theme-light');
  const dark = document.getElementById('hljs-theme-dark');
  if (light) light.disabled = mode === 'dark';
  if (dark) dark.disabled = mode !== 'dark';
}

function setAccent(id) {
  const found = ACCENT_PRESETS.find((a) => a.id === id);
  const accent = found ? found.id : 'violet';
  document.documentElement.setAttribute('data-accent', accent);
  try { localStorage.setItem('iexa-accent', accent); } catch { /* */ }
  syncThemeUI();
  scheduleAppearanceSave();
}

function renderAccentDots() {
  const box = document.getElementById('accentPicker');
  if (!box) return;
  box.innerHTML = ACCENT_PRESETS.map((a) => `
    <button type="button" class="accent-dot${getAccent() === a.id ? ' active' : ''}"
      data-accent="${a.id}" title="${a.label}"
      style="--dot-color:${a.color}; background:${a.color};"></button>
  `).join('');
  box.querySelectorAll('.accent-dot').forEach((btn) => {
    btn.addEventListener('click', () => setAccent(btn.dataset.accent));
  });
}

function syncThemeUI() {
  window.IexaUiScale?.sync();
  document.querySelectorAll('#motionSeg [data-motion-set]').forEach((button) => {
    const active = button.dataset.motionSet === getMotionMode();
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  syncMotionHint();
  const collapseTools = document.getElementById('collapseToolsToggle');
  if (collapseTools) {
    collapseTools.checked = consecutiveToolFoldEnabled();
    collapseTools.setAttribute('aria-checked', String(collapseTools.checked));
    const state = collapseTools.closest('.appearance-switch')?.querySelector('.appearance-switch-state');
    if (state) state.textContent = collapseTools.checked ? state.dataset.on : state.dataset.off;
  }
  const mode = getThemeMode();
  document.querySelectorAll('#themeSeg [data-theme-set]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeSet === mode);
  });
  renderAccentDots();
}

function initTheme() {
  const setUiScale = (change) => {
    if (!window.IexaUiScale) return;
    window.IexaUiScale.apply({...window.IexaUiScale.current(),...change});
    window.IexaUiScale.sync();scheduleAppearanceSave();
  };
  document.getElementById('uiFontScale')?.addEventListener('input', event => setUiScale({fontScale:Number(event.target.value)}));
  document.getElementById('uiIconScale')?.addEventListener('input', event => setUiScale({iconScale:Number(event.target.value)}));
  document.getElementById('uiScaleReset')?.addEventListener('click', () => setUiScale({fontScale:100,iconScale:100}));
  document.querySelectorAll('#motionSeg [data-motion-set]').forEach((button) => {
    button.addEventListener('click', () => setMotionMode(button.dataset.motionSet));
  });
  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (motionQuery?.addEventListener) motionQuery.addEventListener('change', syncMotionHint);
  else motionQuery?.addListener?.(syncMotionHint);
  document.getElementById('collapseToolsToggle')?.addEventListener('change', (event) => setConsecutiveToolFold(event.target.checked));
  let accent = getAccent();
  if (accent === 'opencode') accent = 'violet';
  if (!document.documentElement.getAttribute('data-theme')) setThemeMode('light');
  document.documentElement.setAttribute('data-accent', accent);
  applyHighlightTheme(getThemeMode());

  document.querySelectorAll('#themeSeg [data-theme-set]').forEach((btn) => {
    btn.addEventListener('click', () => setThemeMode(btn.dataset.themeSet));
  });

  syncThemeUI();
}

// Start
async function init() {
  if (!await verifyMobileAccess()) return;
  initTheme();
  await loadAppearanceSettings();
  initPermissionModeUI();
  await loadPermissionMode();
  initPanelResizers();
  initSessionListModule();
  initTranscriptScroll();
  initImageGallery();
  initModelProfilesModule();
  initSidebarNavigationScroll();
  initMobileDrawers();
  initChatFocusMode();
  window.IexaPanelVisibility?.init();
  document.getElementById('archiveManagerBtn')?.addEventListener('click', showArchiveManager);
document.getElementById('checkpointBtn')?.addEventListener('click', (event) => {
  event.stopPropagation();
  setCheckpointOpen(!checkpointOpen);
});
document.getElementById('checkpointRefresh')?.addEventListener('click', () => renderCheckpoints());
document.addEventListener('click', (event) => {
  // The panel is portalled to <body>, so it is no longer inside .checkpoint-wrap.
  if (checkpointOpen && !event.target.closest?.('.checkpoint-wrap, #checkpointPopover')) setCheckpointOpen(false);
});

// ---- Command palette (Ctrl/Cmd+K) ----
const COMMAND_PALETTE_ACTIONS = [
  { id: 'new-session', key: 'palette.newSession', hint: 'Ctrl N', run: () => document.getElementById('newSessionBtn')?.click() },
  { id: 'chat', key: 'palette.chat', run: () => document.querySelector('.nav-btn[data-view="chat"]')?.click() },
  { id: 'skills', key: 'palette.skills', run: () => document.querySelector('.nav-btn[data-view="skills"]')?.click() },
  { id: 'jobs', key: 'palette.jobs', run: () => document.querySelector('.nav-btn[data-view="jobs"]')?.click() },
  { id: 'mcp', key: 'palette.mcp', run: () => document.querySelector('.nav-btn[data-view="mcp"]')?.click() },
  { id: 'plugins', key: 'palette.plugins', run: () => document.querySelector('.nav-btn[data-view="plugins"]')?.click() },
  { id: 'settings', key: 'palette.settings', run: () => document.querySelector('.nav-btn[data-view="settings"]')?.click() },
  { id: 'appearance', key: 'palette.appearance', run: () => document.querySelector('.nav-btn[data-view="appearance"]')?.click() },
  { id: 'token-usage', key: 'palette.tokenUsage', run: () => document.querySelector('.nav-btn[data-view="token-calculator"]')?.click() },
  { id: 'checkpoints', key: 'palette.checkpoints', run: () => setCheckpointOpen(true) },
  { id: 'plan', key: 'palette.plan', run: () => setPermissionMode('plan') },
  { id: 'risk', key: 'palette.risk', run: () => setPermissionMode('risk') },
  { id: 'diagnostics', key: 'palette.diagnostics', run: () => exportDiagnostics() },
];

let commandPaletteItems = [];
let commandPaletteIndex = 0;

function commandPaletteOpen() {
  const palette = document.getElementById('commandPalette');
  return Boolean(palette) && palette.hidden === false;
}

function closeCommandPalette() {
  const palette = document.getElementById('commandPalette');
  if (palette) palette.hidden = true;
}

function renderCommandPalette(query = '') {
  const list = document.getElementById('commandPaletteList');
  if (!list) return;
  const needle = query.trim().toLowerCase();
  commandPaletteItems = COMMAND_PALETTE_ACTIONS.filter((item) => {
    if (!needle) return true;
    const label = IexaI18n.t(item.key).toLowerCase();
    return label.includes(needle) || item.id.includes(needle);
  });
  commandPaletteIndex = 0;
  if (!commandPaletteItems.length) {
    list.innerHTML = `<div class="command-palette-empty">${escapeHtml(IexaI18n.t('palette.empty'))}</div>`;
    return;
  }
  list.innerHTML = commandPaletteItems.map((item, index) => `
    <button type="button" class="command-palette-item${index === 0 ? ' active' : ''}" role="option" data-id="${escapeHtml(item.id)}">
      <span class="command-palette-label">${escapeHtml(IexaI18n.t(item.key))}</span>
      ${item.hint ? `<span class="command-palette-hint">${escapeHtml(item.hint)}</span>` : ''}
    </button>`).join('');
  list.querySelectorAll('.command-palette-item').forEach((button) => {
    button.addEventListener('click', () => runCommandPaletteItem(button.dataset.id || ''));
  });
}

function moveCommandPaletteSelection(delta) {
  const list = document.getElementById('commandPaletteList');
  if (!list || !commandPaletteItems.length) return;
  commandPaletteIndex = (commandPaletteIndex + delta + commandPaletteItems.length) % commandPaletteItems.length;
  list.querySelectorAll('.command-palette-item').forEach((button, index) => {
    button.classList.toggle('active', index === commandPaletteIndex);
  });
}

function runCommandPaletteItem(id) {
  const action = COMMAND_PALETTE_ACTIONS.find((item) => item.id === id);
  closeCommandPalette();
  if (!action) return;
  try { action.run(); } catch (error) { addError(error.message || String(error)); }
}

function openCommandPalette() {
  const palette = document.getElementById('commandPalette');
  const input = document.getElementById('commandPaletteInput');
  if (!palette || !input) return;
  palette.hidden = false;
  input.value = '';
  renderCommandPalette('');
  input.focus();
}

function initCommandPalette() {
  const palette = document.getElementById('commandPalette');
  const input = document.getElementById('commandPaletteInput');
  if (!palette || !input) return;
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (commandPaletteOpen()) closeCommandPalette(); else openCommandPalette();
      return;
    }
    if (!commandPaletteOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCommandPaletteSelection(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveCommandPaletteSelection(-1); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = commandPaletteItems[commandPaletteIndex];
      if (active) runCommandPaletteItem(active.id);
    }
  });
  input.addEventListener('input', () => renderCommandPalette(input.value));
  palette.addEventListener('click', (event) => {
    if (event.target === palette) closeCommandPalette();
  });
}

initCommandPalette();

// ---- UI locale ----
IexaI18n.init();
IexaI18n.apply(document);
const localeSelect = document.getElementById('localeSelect');
if (localeSelect) {
  localeSelect.value = IexaI18n.getLocale();
  localeSelect.addEventListener('change', () => {
    IexaI18n.setLocale(localeSelect.value);
    if (checkpointOpen) renderCheckpoints();
    const paletteInput = document.getElementById('commandPaletteInput');
    renderCommandPalette(paletteInput ? paletteInput.value : '');
    syncPermissionModeUI();
  });
}
  initHtmlPreview();
  initMobileBridge();
  initTextContextMenu();
  initFilesPanel();
  await loadProjectState();
  initTerminalPanel();
  initMcpPanel();
  initPluginPanel();
  initSkillsUI();
  initSoulUI();
  initJobsUI();
  loadTokenUsage();
  await loadSoul();
  await loadSystemInfo();
  await refreshModelSelector();
  await loadSessionList();
  if (currentSessionId === visibleSessionId) {
    scrollHistoryToLatest(currentSessionId);
    window.setTimeout(() => scrollHistoryToLatest(currentSessionId), 350);
  }
  startConversationSync();
  syncSubAgentView();
  initGoalBanner();
  void refreshGoalBanner();
  loadJobs();
}

init();

