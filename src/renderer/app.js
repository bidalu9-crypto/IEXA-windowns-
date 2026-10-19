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
  if (latestContextStatus) handleContextStatus(latestContextStatus);
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

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    const chatWasActive = chatViewIsActive();
    if (view !== 'chat' && chatWasActive) captureChatViewScroll();
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const panel = document.getElementById(`view-${view}`);
    if (panel) {
      panel.classList.add('active');
      // Replay the entry animation on every switch, but never on first paint:
      // a running animation puts the whole view on its own composited layer,
      // and anything measured during that window comes back a subpixel off.
      panel.classList.remove('is-entering');
      void panel.offsetWidth;
      panel.classList.add('is-entering');
      const clearEntering = () => panel.classList.remove('is-entering');
      panel.addEventListener('animationend', clearEntering, { once: true });
      setTimeout(clearEntering, 400);
    }
    if (view === 'chat' && !chatWasActive) restoreChatViewScroll();

    if (view === 'settings') {
      loadSettings();
    }
    if (view === 'skills') {
      loadSkillsList();
    }
    if (view === 'soul') {
      loadSoul();
    }
    if (view === 'token-calculator') {
      loadTokenUsage();
    }
    if (view === 'jobs') {
      // Paint the cached rows before the fetch lands; a response that matches
      // what is already on screen then changes no DOM at all.
      renderJobs();
      loadJobs();
    }
    if (view === 'mcp') {
      loadMcpServers();
    }
    if (view === 'plugins') {
      loadPlugins();
    }
    if (view === 'sync') {
      loadMobileBridge();
    }
    closeMobileDrawers();
    syncJobsPolling();
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
  if (e.key === 'Enter' && !e.shiftKey) {
    const menu = document.getElementById('slashMenu');
    if (menu && menu.style.display !== 'none' && menu.querySelector('.slash-item')) {
      return; // handled by slash menu listener
    }
    e.preventDefault();
    sendMessage();
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
function enqueuePrompt() {
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
  requestImmediateQueueHandoff(currentSessionId);
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
    sendBtn.title = qn > 0
      ? ('插入对话（正在接入 ' + qn + ' 条）')
      : '插入对话（立即接入当前任务）';
    sendBtn.setAttribute('aria-label', '插入对话');
    sendBtn.classList.add('is-queue-mode');
    chatInput.placeholder = '任务进行中，可插入对话，立即接入…';
    if (attachBtn) attachBtn.disabled = false;
    chatInput.disabled = false;
  } else {
    sendBtn.classList.remove('is-queue-mode');
    sendBtn.title = '发送 (Enter)';
    sendBtn.setAttribute('aria-label', '发送');
    chatInput.placeholder = '有问题，随便问';
  }
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

async function sendMessage() {
  const message = chatInput.value.trim();
  const attachments = cloneAttachments(pendingAttachments);
  if (!message && attachments.length === 0) return;

  // Busy → insert into queue (iOS enqueuePrompt)
  if (isProcessing) {
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

async function prepareAttachmentsForChat(attachments, sessionId) {
  const prepared = [];
  for (const attachment of (attachments || [])) {
    prepared.push(attachment.file && attachment.file.size > MAX_ATTACH_BYTES
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
// =============================================================================
// SSE Event Handling
// =============================================================================

const pendingStreamUpdates = new Map();

function flushStreamUpdates(sessionId) {
  const pending = pendingStreamUpdates.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  clearTimeout(pending.fallback);
  if (pending.frame) cancelAnimationFrame(pending.frame);
  pendingStreamUpdates.delete(sessionId);
  withSessionRuntime(sessionId, () => {
    if (pending.turnToken !== activeChatTurnToken) return;
    for (const { event, data } of pending.events) {
      if (event === 'text') handleTextDelta(data.content);
      else if (event === 'thinking') handleThinkingDelta(data.content);
      else handleToolInput(data.name, data.args, data.id);
    }
    snapshotActiveSessionRuntime();
  });
}

function queueStreamUpdate(event, data, turnToken) {
  const sessionId = currentSessionId;
  let pending = pendingStreamUpdates.get(sessionId);
  if (pending && pending.turnToken !== turnToken) {
    clearTimeout(pending.timer);
    clearTimeout(pending.fallback);
    if (pending.frame) cancelAnimationFrame(pending.frame);
    pendingStreamUpdates.delete(sessionId);
    pending = null;
  }
  if (!pending) {
    pending = { turnToken, events: [] };
    if (sessionId === visibleSessionId && document.visibilityState !== 'hidden') {
      pending.timer = setTimeout(() => {
        pending.frame = requestAnimationFrame(() => flushStreamUpdates(sessionId));
      }, 32);
      // Hidden tabs may suspend animation frames after the timer was scheduled.
      pending.fallback = setTimeout(() => flushStreamUpdates(sessionId), 400);
    } else pending.timer = setTimeout(() => flushStreamUpdates(sessionId), 400);
    pendingStreamUpdates.set(sessionId, pending);
  }
  if (event === 'text') pending.text = data.content; // cumulative baseline for text_delta transport
  const last = pending.events[pending.events.length - 1];
  const same = last?.event === event && (event !== 'tool_input' || (last.data.id || last.data.name) === (data.id || data.name));
  if (same) last.data = event === 'thinking' ? { ...data, content: String(last.data.content || '') + String(data.content || '') } : { ...data };
  else pending.events.push({ event, data: { ...data } });
  if (pending.events.length >= 128) flushStreamUpdates(sessionId);
}

/** Desktop notification only while the window is not visible. */
function notifyIfHidden(title, body) {
  try {
    if (document.visibilityState === 'visible') return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') { Notification.requestPermission().catch(() => {}); return; }
    if (Notification.permission !== 'granted') return;
    const notification = new Notification(title, { body, silent: false });
    notification.onclick = () => { try { window.focus(); } catch { /* window may be gone */ } notification.close(); };
  } catch { /* notifications are optional */ }
}

function handleSSEEvent(raw, turnToken) {
  const lines = raw.split('\n');
  let eventType = '';
  let dataStr = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.substring(7);
    } else if (line.startsWith('data: ')) {
      dataStr = line.substring(6);
    }
  }

  if (!eventType || !dataStr) return;

  try {
    const data = JSON.parse(dataStr);
    if (turnToken != null && turnToken !== activeChatTurnToken) return;
    if (eventType === 'text_delta') {
      const previous = pendingStreamUpdates.get(currentSessionId)?.text ?? currentAssistantMsg?._assistantText ?? '';
      data.content = (data.reset ? '' : previous) + (data.content || '');
      eventType = 'text';
    }
    if (['text', 'thinking', 'tool_input'].includes(eventType)) {
      queueStreamUpdate(eventType, data, activeChatTurnToken);
      return;
    }
    flushStreamUpdates(currentSessionId);

    switch (eventType) {
      case 'text':
        handleTextDelta(data.content);
        break;
      case 'turn_started': {
        const level = normalizeThinkingLevel(data.thinkingLevel || currentThinkingLevel);
        if (currentAssistantMsg) {
          currentAssistantMsg.dataset.thinkingLevel = level;
          if (typeof data.transcriptTurnId === 'string') currentAssistantMsg.dataset.transcriptTurnId = data.transcriptTurnId;
        }
        break;
      }
      case 'thinking':
        handleThinkingDelta(data.content);
        break;
      case 'tool_start':
        handleToolStart(data.id, data.name);
        break;
      case 'tool_input':
        handleToolInput(data.name, data.args, data.id);
        break;
      case 'tool_complete':
        handleToolComplete(data.id, data.name, data.args);
        break;
      case 'tool_state': {
        if (data.status !== 'awaiting_approval') window.IexaPermissionDialog.closeForTool?.(data.sessionId, data.id, data.runId);
        if (data.name === 'ask_user' && ['completed', 'failed', 'denied', 'cancelled', 'timed_out'].includes(data.status)) {
          window.IexaQuestionCard?.applyToolState?.(data.id, data.status);
        }
        const info = currentToolBlocks[data.id];
        if (info) window.IexaToolLifecycleView.apply(info.block, data, setToolStepStatus);
        break;
      }
      case 'tool_result':
        handleToolResult(data.id, data.output, data.success, data.todos, data.fileChange, data.imageData, data.imageMimeType, data.artifacts, data.executionStatus, data.durationMs, data.pluginUI, data.metadata);
        break;
      case 'context':
        handleContextStatus(data);
        break;
      case 'usage':
        handleUsage(data);
        break;
      case 'job':
        applyJobUpdate(data);
        break;
      case 'retry':
        handleRetry(data);
        break;
      case 'permission_required':
        showPermissionDialog(data);
        notifyIfHidden('IEXA 需要你的批准', '有工具调用正在等待审批');
        break;
      case 'question_required':
        showQuestionCard(data);
        break;
      case 'error':
        handleError(data.message, turnToken);
        break;
      case 'session_title':
        handleSessionTitle(data.sessionId, data.title, data.category);
        break;
      case 'done':
        handleDone(data.stopReason, turnToken);
        notifyIfHidden('IEXA 任务完成', data.stopReason === 'cancelled' ? '本轮任务已取消' : '本轮处理已完成');
        break;
      case 'cancelled':
        handleCancelled(turnToken);
        break;
    }
  } catch (e) {
    // Skip parse errors for partial chunks
  }
}

function showPermissionDialog(data) {
  subAgentView?.dismiss();
  window.IexaPermissionDialog.show(data, { apiBase: API_BASE, onError: addError });
}

/** Mount an ask_user card inside the live transcript, right after its tool step. */
function mountQuestionCard(el, data) {
  const info = data && data.toolCallId ? currentToolBlocks[data.toolCallId] : null;
  const host = info?.block?.closest('.tool-steps');
  if (host) {
    host.appendChild(el);
    return;
  }
  try {
    ensureToolStepsHost().appendChild(el);
  } catch {
    const msg = ensureAssistantMessage();
    window.IexaTranscriptView.append(msg, el);
  }
}

function questionCardOptions() {
  return {
    apiBase: API_BASE,
    onError: addError,
    scrollToBottom: () => scrollToBottom(),
    mount: mountQuestionCard,
  };
}

function showQuestionCard(data) {
  if (!window.IexaQuestionCard) return;
  hideWaitingIndicator();
  window.IexaQuestionCard.show(data, questionCardOptions());
  const info = data && data.toolCallId ? currentToolBlocks[data.toolCallId] : null;
  if (info) setToolStepStatus(info.block, 'streaming', '等待用户作答');
}

function handleRetry(data) {
  if (!currentAssistantMsg) return;
  const attempt = Number(data && data.attempt) || 1;
  const delayMs = Number(data && data.delayMs) || 0;
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  beginTaskSummary(`网关暂时不可用，${seconds} 秒后重试（第 ${attempt} 次）`);
  currentAssistantMsg.querySelectorAll('.tool-block').forEach((block) => {
    if (!block.classList.contains('is-done') && !block.classList.contains('is-error')) {
      setToolStepStatus(block, 'streaming', '等待重试');
    }
  });
  scrollToBottom();
}

/** Content block that should receive the latest model text (under tools when present). */
function ensureAnswerContentEl() {
  const msg = ensureAssistantMessage();
  const last = window.IexaTranscriptView.lastNode(msg);
  if (last?.classList.contains('message-content')) {
    if (!Number.isInteger(last._textStart)) last._textStart = 0;
    return last;
  }
  const content = document.createElement('div');
  content.className = 'message-content message-answer';
  content._textStart = String(msg._assistantText || '').length;
  window.IexaTranscriptView.append(msg, content);
  return content;
}

function renderMarkdownContent(contentEl, markdown, finalRender = false) {
  if (!contentEl) return;
  const source = String(markdown || '');
  contentEl._markdownSource = source;

  // SSE events are already batched. Only rebuild when the source changed so
  // terminal events can enhance the existing DOM without a visible reflow.
  if (contentEl._renderedMarkdownSource !== source || (finalRender && !contentEl._renderedMarkdownFinal)) {
    // Avoid rerunning syntax highlighting over all growing code blocks per SSE delta.
    // Finalization adds highlighting exactly once, even when the text is unchanged.
    if (!finalRender && window.IexaChatPresentation) {
      window.IexaChatPresentation.renderStream(contentEl, renderSafeMarkdown(source, { highlight: false }));
    } else contentEl.innerHTML = renderSafeMarkdown(source, { highlight: finalRender });
    contentEl._renderedMarkdownFinal = finalRender;
    contentEl._renderedMarkdownSource = source;
    normalizeRenderedAssets(contentEl);
  }

  if (finalRender) {
    enhanceCodeBlocks(contentEl);
    enhanceTables(contentEl);
    return;
  }

  // Images can increase the rendered height after the current SSE frame.
  // Keep following only when the user has not deliberately scrolled away.
  contentEl.querySelectorAll('img').forEach((img) => {
    if (img.complete || img._iexaFollowBound) return;
    img._iexaFollowBound = true;
    img.addEventListener('load', () => scrollToBottom(false, isNearChatBottom), { once: true });
  });
}

function handleTextDelta(fullText) {
  const followLatest = shouldFollowLatestMessage();
  hideWaitingIndicator();
  finishActiveThinkingBlock();
  if (!currentAssistantMsg) return;
  const previous = String(currentAssistantMsg._assistantText || '');
  const value = String(fullText || '');
  const contentEl = ensureAnswerContentEl();
  if (!value.startsWith(previous)) {
    // A gateway replaced its cumulative text. Keep the new text intact and
    // explicitly fall back rather than duplicating outdated fragments.
    currentAssistantMsg.querySelectorAll('.message-content').forEach(node => { if (node !== contentEl) node.remove(); });
    contentEl._textStart = 0; currentAssistantMsg.dataset.transcriptState = 'text-reset';
  }
  currentAssistantMsg._assistantText = value;
  contentEl.classList.add('streaming-markdown');
  renderMarkdownContent(contentEl, value.slice(contentEl._textStart || 0));
  // Hide empty preamble bubbles
  currentAssistantMsg.querySelectorAll('.message-content').forEach((node) => {
    if (node === contentEl) {
      node.style.display = '';
      return;
    }
    if (!(node.textContent || '').trim()) node.style.display = 'none';
  });
  scrollToBottom(false, followLatest);
}

function thinkingEffortLabelFor(level) {
  const normalized = normalizeThinkingLevel(level || 'medium');
  return THINKING_LEVELS[normalized]?.label || '标准';
}

function estimateThinkingTokens(text) {
  const chars = String(text || '').length;
  if (!chars) return 0;
  // Keep this consistent with the backend's ContextCompactor estimate.
  return Math.max(1, Math.ceil(chars / 3.5));
}

function updateThinkingTokenCount(thinkBlock, text) {
  if (!thinkBlock) return;
  const tokens = estimateThinkingTokens(text);
  const countEl = thinkBlock.querySelector('.thinking-token-count');
  if (countEl) {
    countEl.textContent = formatTokenCount(tokens);
    countEl.title = `思考 token：${tokens.toLocaleString()}（按思考内容估算）`;
  }
}

function restoreTranscriptOrder(element, message) {
  return window.IexaTranscriptView.restore(element, message, {
    text(text, item) {
      const content = document.createElement('div'); content.className = 'message-content'; content._textStart = item.start;
      renderMarkdownContent(content, text, true); return content;
    },
    thinking(text, item) {
      const block = document.createElement('details'); block.className = 'thinking-block is-complete';
      const level = normalizeThinkingLevel(message.thinkingLevel || currentThinkingLevel); block.dataset.thinkingLevel = level; block._reasoning = text;
      block.innerHTML = `<summary>${uiIcon('brain')}<span class="thinking-title">思考</span><span class="thinking-effort">${escapeHtml(thinkingEffortLabelFor(level))}</span><span class="thinking-token-count"></span><span class="thinking-chevron" aria-hidden="true"></span></summary><pre class="thinking-content"></pre>`;
      window.IexaChatActivity.prepareThinking(block); updateThinkingTokenCount(block, text); setPagedText(block.querySelector('.thinking-content'), text);
      if (Number.isSafeInteger(item.durationMs)) {
        block.dataset.startedAt = String(Math.max(1, item.timestamp));
        window.IexaChatActivity.finishThinking(block, Math.max(1, item.timestamp) + item.durationMs);
      }
      return block;
    },
  });
}

function stabilizeThinkingBlockWidth(thinkBlock) {
  if (!thinkBlock || thinkBlock.dataset.widthBound === 'true') return;
  const summary = thinkBlock.querySelector(':scope > summary');
  if (!summary) return;
  requestAnimationFrame(() => {
    if (!summary.isConnected) return;
    // Let the stylesheet's fit-content sizing resolve the complete label.
    // Never lock a pre-flex measurement into pixels: it can clip the arrow.
    thinkBlock.dataset.widthBound = 'true';
  });
}

function finishThinkingBlock(thinkBlock) {
  if (!thinkBlock || thinkBlock.classList.contains('is-complete')) return;
  // Compatibility cleanup for blocks created before the simplified design.
  const timerId = Number(thinkBlock.dataset.timerId);
  if (timerId) window.clearInterval(timerId);
  delete thinkBlock.dataset.timerId;
  window.IexaChatActivity.finishThinking(thinkBlock);
  thinkBlock.open = false;
  thinkBlock.classList.add('is-complete');
  const title = thinkBlock.querySelector('.thinking-title');
  const effort = thinkBlock.querySelector('.thinking-effort');
  const spinner = thinkBlock.querySelector('.thinking-spinner');
  if (title) title.textContent = '思考';
  if (effort) effort.textContent = thinkingEffortLabelFor(thinkBlock.dataset.thinkingLevel);
  if (spinner) spinner.remove();
}

function finishActiveThinkingBlock() {
  if (!currentAssistantMsg) return;
  currentAssistantMsg.querySelectorAll('.thinking-block:not(.is-complete)').forEach(finishThinkingBlock);
}

function initializeThinkingAutoScroll(content) {
  if (!content || content.dataset.autoScrollBound === 'true') return;
  content.dataset.autoScrollBound = 'true';
  content.dataset.followLatest = 'true';
  content.addEventListener('scroll', () => {
    const distance = content.scrollHeight - content.scrollTop - content.clientHeight;
    content.dataset.followLatest = distance <= 24 ? 'true' : 'false';
  }, { passive: true });
}

function scrollThinkingToLatest(content) {
  if (!content || content.dataset.followLatest === 'false') return;
  // Text layout can finish after the current event. Repeat once on the next
  // frame so wrapped reasoning lines also remain pinned to the latest line.
  requestAnimationFrame(() => {
    if (content.dataset.followLatest !== 'false') content.scrollTop = content.scrollHeight;
  });
}

function handleThinkingDelta(text) {
  hideWaitingIndicator();
  if (!currentAssistantMsg || !text) return;
  const lastActivity = window.IexaTranscriptView.lastNode(currentAssistantMsg);
  let thinkBlock = lastActivity?.classList.contains('thinking-block') && !lastActivity.classList.contains('is-complete') ? lastActivity : null;
  if (!thinkBlock) {
    const level = currentAssistantMsg.dataset.thinkingLevel || currentThinkingLevel;
    thinkBlock = document.createElement('details');
    thinkBlock.className = 'thinking-block';
    thinkBlock.open = false;
    thinkBlock.dataset.startedAt = String(Date.now());
    thinkBlock._reasoning = '';
    thinkBlock.dataset.thinkingLevel = level;
    thinkBlock.innerHTML = `<summary><span class="thinking-spinner" aria-hidden="true"></span>${uiIcon('brain')}<span class="thinking-title">思考</span><span class="thinking-effort">${escapeHtml(thinkingEffortLabelFor(level))}</span><span class="thinking-token-count">0</span><span class="thinking-chevron" aria-hidden="true"></span></summary><pre class="thinking-content"></pre>`;
    window.IexaTranscriptView.append(currentAssistantMsg, thinkBlock);
    window.IexaChatActivity.prepareThinking(thinkBlock);
    stabilizeThinkingBlockWidth(thinkBlock);
  }
  const total = (thinkBlock._reasoning || '') + String(text);
  thinkBlock._reasoning = total;
  updateThinkingTokenCount(thinkBlock, total);
  const content = thinkBlock.querySelector('.thinking-content');
  if (content) {
    initializeThinkingAutoScroll(content);
    setPagedText(content, total, { followLatest: true });
    scrollThinkingToLatest(content);
  }
  scrollToBottom();
}

const TOOL_LABELS = {
  todo_write: '更新计划',
  shell_execute: '执行命令',
  shell_session: '持久终端',
  job_list: '任务列表',
  job_output: '任务输出',
  goal: '任务目标',
  file_read: '读取文件',
  file_write: '写入文件',
  file_edit: '编辑文件',
  grep: '搜索代码',
  glob: '查找文件',
  browser_fetch: '抓取网页',
  memory_write: '写入记忆',
  memory_get: '读取记忆',
  ask_user: '向用户提问',
};

const TOOL_ICONS = {
  spawn_agent: 'robot',
  send_input: 'robot',
  wait_agent: 'robot',
  close_agent: 'robot',
  resume_agent: 'robot',
  todo_write: 'check',
  shell_execute: 'terminal',
  shell_session: 'terminal',
  job_list: 'menu',
  job_output: 'file',
  goal: 'pin',
  file_read: 'file',
  file_write: 'edit',
  file_edit: 'edit',
  grep: 'search',
  glob: 'folder',
  browser_fetch: 'globe',
  memory_write: 'memory',
  memory_get: 'search',
  ask_user: 'chat',
};

function toolDisplayName(name) {
  const key = 'tool.' + name;
  const translated = IexaI18n.t(key);
  return translated === key ? (TOOL_LABELS[name] || name) : translated;
}

function toolIcon(name) {
  return uiIcon(TOOL_ICONS[name] || 'settings');
}

function formatTaskElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  return minutes + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒';
}

/** Create the compact task pill. Click it to show or hide the tool capsules. */
function consecutiveToolFoldEnabled() {
  return document.documentElement.getAttribute('data-collapse-tools') === 'on';
}

function applyConsecutiveToolFoldSetting(enabled) {
  document.documentElement.setAttribute('data-collapse-tools', enabled ? 'on' : 'off');
  try { localStorage.setItem('iexa-collapse-tools', enabled ? 'on' : 'off'); } catch { /* current window still applies it */ }
  document.querySelectorAll('.tool-steps').forEach((host) => {
    const summary = [...host.children].find((node) => node.classList?.contains('task-summary'));
    if (summary) {
      applyConsecutiveToolFold(host, summary, summary.dataset.userExpanded !== 'true');
      summary.hidden = !enabled;
    }
    refreshToolGroupSummary(host);
  });
}

function setConsecutiveToolFold(enabled) {
  applyConsecutiveToolFoldSetting(enabled);
  try {
    if (typeof syncThemeUI === 'function') syncThemeUI();
    if (typeof scheduleAppearanceSave === 'function') scheduleAppearanceSave();
  } catch { /* the visible fold state is already applied */ }
}

function applyConsecutiveToolFold(host, summary, collapsed) {
  if (!host || !summary) return;
  const enabled = consecutiveToolFoldEnabled();
  host.classList.toggle('is-collapsed', enabled && collapsed);
  summary.hidden = !enabled;
  summary.setAttribute('aria-expanded', String(!(enabled && collapsed)));
  summary.title = enabled && collapsed ? '点击展开连续工具' : '点击收起连续工具';
}

function refreshToolGroupSummary(host) {
  if (!host) return;
  const summary = [...host.children].find((node) => node.classList?.contains('task-summary'));
  if (!summary) return;
  const blocks = [...host.children].filter((node) => node.classList?.contains('tool-block'));
  const errors = blocks.filter((block) => block.classList.contains('is-error') || ['failed', 'denied', 'timed_out', 'error'].includes(block.dataset.executionStatus || block.dataset.status || '')).length;
  const countEl = summary.querySelector('.task-summary-count');
  const errorEl = summary.querySelector('.task-summary-errors');
  if (countEl) countEl.textContent = blocks.length + ' 次调用';
  if (errorEl) errorEl.textContent = errors > 0 ? errors + ' 个报错' : '';
  const terminal = new Set(['done', 'completed', 'error', 'failed', 'denied', 'cancelled', 'timed-out', 'timed_out', 'unknown']);
  const running = blocks.some((block) => !terminal.has(block.dataset.executionStatus || '') && (block.classList.contains('is-active') || !terminal.has(block.dataset.status || 'running')));
  const started = blocks.map((block) => Number(block.dataset.startedAt)).filter(Number.isFinite);
  const ended = blocks.map((block) => Number(block.dataset.finishedAt)).filter(Number.isFinite);
  const start = started.length ? Math.min(...started) : Number(host.dataset.startedAt) || Date.now();
  const end = running || !blocks.length || ended.length !== blocks.length ? Date.now() : Math.max(...ended);
  const timeEl = summary.querySelector('.task-summary-time');
  if (timeEl) timeEl.textContent = formatTaskElapsed(end - start);
  const labelEl = summary.querySelector('.task-summary-label');
  if (labelEl) labelEl.textContent = running ? '正在执行工具' : '已执行工具';
  summary.classList.toggle('is-running', running);
  summary.classList.toggle('is-complete', !running && blocks.length > 0);
  const spinner = summary.querySelector('.task-summary-spinner');
  if (spinner) spinner.hidden = !running;
  applyConsecutiveToolFold(host, summary, summary.dataset.userExpanded !== 'true');
}

function createTaskSummary(toolCount) {
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'task-summary';
  summary.setAttribute('aria-expanded', 'false');
  summary.innerHTML =
    '<span class="task-summary-spinner" aria-hidden="true"></span>' +
    '<span class="task-summary-label">正在执行工具</span>' +
    '<span class="task-summary-count">' + (Number(toolCount) || 0) + ' 次调用</span>' +
    '<span class="task-summary-errors"></span>' +
    '<span class="task-summary-time">0 秒</span>' +
    '<span class="task-summary-chevron" aria-hidden="true"></span>';
  summary.title = '点击展开连续工具';
  summary.addEventListener('click', function () {
    const host = summary.closest('.tool-steps');
    if (!host || !consecutiveToolFoldEnabled()) return;
    const collapsed = !host.classList.contains('is-collapsed');
    summary.dataset.userExpanded = collapsed ? '' : 'true';
    applyConsecutiveToolFold(host, summary, collapsed);
  });
  return summary;
}

function taskSummaryForCurrentMessage() {
  // Bind the summary to its own chat turn. currentAssistantMsg can be reset
  // by a done event or replaced when a queued turn starts.
  return currentTaskSummary;
}

function updateTaskSummary(label) {
  const summary = taskSummaryForCurrentMessage();
  if (!summary || !currentTaskStartedAt) return;
  const labelEl = summary.querySelector('.task-summary-label');
  if (labelEl && label) labelEl.textContent = label;
  refreshToolGroupSummary(summary.closest('.tool-steps'));
}

function beginTaskSummary(label) {
  if (!currentTaskStartedAt) {
    currentTaskStartedAt = Date.now();
    // Timers remain owned by the background session that created the tool
    // step; a later session switch cannot redirect its elapsed-time updates.
    const ownerSessionId = currentSessionId;
    currentTaskTimer = window.setInterval(function () {
      withSessionRuntime(ownerSessionId, function () {
        updateTaskSummary();
        snapshotActiveSessionRuntime();
      });
    }, 250);
  }
  const summary = taskSummaryForCurrentMessage();
  if (summary) {
    summary.classList.remove('is-complete');
    const spinner = summary.querySelector('.task-summary-spinner');
    if (spinner) spinner.style.display = '';
  }
  updateTaskSummary(label);
}

function finishTaskSummary() {
  if (currentTaskTimer) window.clearInterval(currentTaskTimer);
  currentTaskTimer = null;
  if (!currentTaskStartedAt) return;
  const summary = taskSummaryForCurrentMessage();
  if (summary) {
    refreshToolGroupSummary(summary.closest('.tool-steps'));
  }
  currentTaskStartedAt = 0;
  currentTaskSummary = null;
}

/** Extract a partial JSON string value while args are still streaming. */
function extractPartialStringValue(key, json) {
  if (!json || typeof json !== 'string' || !key) return null;
  // Scan for "key": "value without needing a complete JSON object.
  const needle = '"' + key + '"';
  let i = json.indexOf(needle);
  if (i < 0) return null;
  i = json.indexOf(':', i + needle.length);
  if (i < 0) return null;
  i += 1;
  while (i < json.length && (json[i] === ' ' || json[i] === '\t' || json[i] === '\n' || json[i] === '\r')) i++;
  if (i >= json.length || json[i] !== '"') return null;
  i += 1; // first char of value
  let out = '';
  for (; i < json.length; i++) {
    const ch = json[i];
    if (ch === '\\') {
      if (i + 1 >= json.length) { out += ch; break; }
      const nx = json[++i];
      if (nx === 'n') out += '\n';
      else if (nx === 't') out += '\t';
      else if (nx === 'r') out += '\r';
      else if (nx === '"') out += '"';
      else if (nx === '\\') out += '\\';
      else if (nx === '/') out += '/';
      else if (nx === 'u' && i + 4 < json.length) {
        const hex = json.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += nx;
        }
      } else {
        out += nx;
      }
    } else if (ch === '"') {
      break; // closed string
    } else {
      out += ch;
    }
  }
  return out;
}

/** Prefer model tool_title; fall back to a short primary-arg preview. */
function toolLiveTitle(name, argsOrJson) {
  let title = null;
  let preview = null;
  if (argsOrJson && typeof argsOrJson === 'object') {
    if (argsOrJson.tool_title) title = String(argsOrJson.tool_title);
    if (name === 'shell_execute' && argsOrJson.command) preview = String(argsOrJson.command);
    else if ((name === 'file_read' || name === 'file_write' || name === 'file_edit') && argsOrJson.path) preview = String(argsOrJson.path);
    else if (name === 'browser_fetch' && argsOrJson.url) preview = String(argsOrJson.url);
    else if (name === 'memory_get' && argsOrJson.keywords) preview = String(argsOrJson.keywords);
  } else if (typeof argsOrJson === 'string') {
    title = extractPartialStringValue('tool_title', argsOrJson);
    if (name === 'shell_execute') preview = extractPartialStringValue('command', argsOrJson);
    else if (name === 'file_read' || name === 'file_write' || name === 'file_edit') preview = extractPartialStringValue('path', argsOrJson);
    else if (name === 'browser_fetch') preview = extractPartialStringValue('url', argsOrJson);
    else if (name === 'memory_get') preview = extractPartialStringValue('keywords', argsOrJson);
    else if (name === 'memory_write') preview = extractPartialStringValue('content', argsOrJson);
  }
  if (title && title.trim()) return title.trim();
  if (preview && preview.trim()) {
    const one = preview.trim().replace(/\s+/g, ' ');
    return one.length > 48 ? one.slice(0, 48) + '…' : one;
  }
  return toolDisplayName(name);
}

function ensureAssistantMessage() {
  if (!currentAssistantMsg) {
    currentAssistantMsg = addMessage('assistant', '', undefined, { streaming: true });
  }
  return currentAssistantMsg;
}

function showWaitingIndicator() {
  // A cancel request can race with late tool/stream events. Once stopping has
  // started, the old turn must never recreate the "IEXA正在处理..." surface.
  const runtime = currentSessionId ? runtimeForSession(currentSessionId) : null;
  if (runtime?.turnStopPending) return;
  const msg = ensureAssistantMessage();
  if (msg.querySelector('.waiting-indicator')) return;
  const indicator = window.IexaChatActivity.createWaiting();
  const footer = assistantFooterAnchor(msg);
  if (footer) msg.insertBefore(indicator, footer);
  else msg.appendChild(indicator);
  scrollToBottom();
}

function hideWaitingIndicator() {
  if (!currentAssistantMsg) return;
  const indicator = currentAssistantMsg.querySelector('.waiting-indicator');
  if (indicator) indicator.remove();
}

function ensureToolStepsHost() {
  const msg = ensureAssistantMessage();
  const last = window.IexaTranscriptView.lastNode(msg);
  if (last?.classList.contains('tool-steps')) return last;
  const host = document.createElement('div');
  host.className = 'tool-steps activity-list';
  host.dataset.startedAt = String(Date.now());
  window.IexaTranscriptView.append(msg, host);
  return host;
}

function setToolStepStatus(block, status, label) {
  const statusEl = block.querySelector('.tool-status');
  if (!statusEl) return;
  statusEl.className = 'tool-status ' + status;
  if (label != null) statusEl.textContent = label;
  else if (status === 'running' || status === 'streaming') statusEl.textContent = '运行中';
  else if (status === 'done') statusEl.innerHTML = uiIcon('check') + '<span>完成</span>';
  else if (status === 'error') statusEl.innerHTML = uiIcon('alert') + '<span>出错</span>';
  block.dataset.status = status;
  block.classList.toggle('is-active', status === 'running' || status === 'streaming');
  block.classList.toggle('is-done', status === 'done');
  block.classList.toggle('is-error', ['error', 'denied', 'timed-out'].includes(status));
  block.classList.toggle('is-cancelled', status === 'cancelled');
}

function toolKind(name) {
  if (name === 'shell_execute' || name === 'shell_session' || name.startsWith('terminal_')) return 'terminal';
  if (name === 'file_read' || name === 'file_write' || name === 'file_edit' || name === 'display_file' || name === 'grep' || name === 'glob') return 'file';
  if (name.startsWith('mcp_')) return 'mcp';
  if (name === 'browser_fetch') return 'web';
  if (name === 'read_image') return 'vision';
  if (name.startsWith('memory_')) return 'memory';
  return 'agent';
}

function toolMeta(name, args) {
  const source = args && typeof args === 'object' ? args : {};
  if (name === 'shell_execute') return '工作区命令';
  if (name === 'shell_session') return `${source.action || 'open'}${source.session_id ? ' · ' + String(source.session_id).slice(0, 8) : ''}`;
  if (name === 'job_list') return '最近任务';
  if (name === 'job_output') return String(source.job_id || '任务输出');
  if (name === 'goal') return `${source.action || 'get'}${source.objective ? ' · ' + String(source.objective).slice(0, 40) : ''}`;
  if (name.startsWith('mcp_')) return 'MCP 工具';
  if (name === 'read_image') return '视觉代理';
  if (name === 'browser_fetch') return '网页读取';
  if (name === 'grep') return source.path ? `${source.path} · ${source.pattern || ''}` : String(source.pattern || '工作区');
  if (name === 'glob') return String(source.pattern || '工作区');
  if (source.path) return String(source.path);
  return 'IEXA 工具';
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

function handleToolStart(id, name) {
  if (name === 'desktop_control') showDesktopLive();
  hideWaitingIndicator();
  finishActiveThinkingBlock();
  ensureAssistantMessage();
  if (currentToolBlocks[id]?.block.dataset.executionStatus) return;
  if (currentToolBlocks[id]) {
    // Already created via tool_input fallback — just ensure visible/active
    const info = currentToolBlocks[id];
    info.name = name || info.name;
    const iconEl = info.block.querySelector('.tool-icon');
    if (iconEl) iconEl.innerHTML = toolIcon(info.name);
    if (!info.block.querySelector('.tool-name').dataset.locked) {
      info.block.querySelector('.tool-name').textContent = toolDisplayName(info.name);
    }
    setToolStepStatus(info.block, 'streaming', '准备中');
    scrollToBottom();
    return;
  }

  const host = ensureToolStepsHost();
  const block = document.createElement('div');
  block.className = 'tool-block is-active';
  block.id = 'tool-' + id;
  block.dataset.toolId = id;
  block.dataset.toolName = name || '';
  block.dataset.status = 'streaming';
  block.dataset.startedAt = String(Date.now());
  block.dataset.kind = toolKind(name || '');
  block.innerHTML =
    '<div class="tool-header" data-ui-action="toggleToolBody" data-ui-arg="tool-body-' + escapeHtml(id) + '">' +
      '<span class="tool-icon">' + toolIcon(name) + '</span><span class="tool-heading"><span class="tool-name">' + escapeHtml(toolDisplayName(name)) + '</span><span class="tool-meta">' + escapeHtml(toolMeta(name)) + '</span></span>' +
      '<span class="tool-status running">准备中</span>' +
      '<span class="tool-chevron" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="tool-body" id="tool-body-' + escapeHtml(id) + '" style="display:none;">' +
      '<div class="tool-section-label">输入</div><pre class="tool-args">准备中...</pre>' +
    '</div>';

  // Insert the compact task bar once, above the individual capsules.
  // Capsules remain collapsed until the user taps the task bar.
  let summary = host.querySelector('.task-summary');
  if (!summary) {
    summary = createTaskSummary(0);
    host.insertBefore(summary, host.firstChild);
  }
  // Keep a direct reference so completion always stops this turn's spinner.
  currentTaskSummary = summary;
  host.appendChild(block);
  currentTaskToolCount += 1;
  beginTaskSummary(toolDisplayName(name));
  refreshToolGroupSummary(host);
  currentToolBlocks[id] = { block, name, argsText: '' };
  window.IexaChatActivity.updateTool(block, name);
  scrollToBottom();
}

function resolveToolBlockForInput(id, name) {
  if (id && currentToolBlocks[id]) return { id, info: currentToolBlocks[id] };
  // Fallback: latest running block with same name
  const entries = Object.entries(currentToolBlocks);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [bid, info] = entries[i];
    if (info.name === name && (info.block.dataset.status === 'streaming' || info.block.dataset.status === 'running')) {
      return { id: bid, info };
    }
  }
  // Create on the fly if start event was missed (OpenAI old path / partial reconnect)
  if (id) {
    handleToolStart(id, name);
    return { id, info: currentToolBlocks[id] };
  }
  const syntheticId = 'pending_' + name + '_' + Date.now();
  handleToolStart(syntheticId, name);
  return { id: syntheticId, info: currentToolBlocks[syntheticId] };
}

function handleToolInput(name, args, id) {
  const resolved = resolveToolBlockForInput(id, name);
  if (!resolved || !resolved.info) return;
  const { info } = resolved;
  if (info.block.dataset.executionStatus) return;
  info.argsText = typeof args === 'string' ? args : JSON.stringify(args || {}, null, 2);

  const argsEl = info.block.querySelector('.tool-args');
  if (argsEl) {
    try {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      setPagedText(argsEl, JSON.stringify(parsed, null, 2));
    } catch {
      setPagedText(argsEl, String(args || ''));
    }
  }
  const metaEl = info.block.querySelector('.tool-meta');
  if (metaEl && args && typeof args === 'object') metaEl.textContent = toolMeta(name || info.name, args);

  const nameEl = info.block.querySelector('.tool-name');
  if (nameEl) {
    const live = toolLiveTitle(name || info.name, args);
    nameEl.textContent = live;
    if (typeof args === 'string' && extractPartialStringValue('tool_title', args)) {
      nameEl.dataset.locked = '1';
    } else if (args && typeof args === 'object' && args.tool_title) {
      nameEl.dataset.locked = '1';
    }
  }

  const activityArgs = args && typeof args === 'object' ? args : {
    path: extractPartialStringValue('path', String(args || '')),
    command: extractPartialStringValue('command', String(args || '')),
    url: extractPartialStringValue('url', String(args || '')),
    tool_title: extractPartialStringValue('tool_title', String(args || '')),
  };
  window.IexaChatActivity.updateTool(info.block, name || info.name, activityArgs);
  setToolStepStatus(info.block, 'streaming', '流式中');
  updateTaskSummary(toolLiveTitle(name || info.name, args));
  scrollToBottom();
}

function handleToolComplete(id, name, args) {
  let info = currentToolBlocks[id];
  if (!info) {
    // Late complete without start — still show the step
    handleToolStart(id, name);
    info = currentToolBlocks[id];
  }
  if (!info) return;
  info.name = name || info.name;

  const argsEl = info.block.querySelector('.tool-args');
  if (argsEl) {
    try {
      setPagedText(argsEl, JSON.stringify(args || {}, null, 2));
    } catch {
      setPagedText(argsEl, String(args || ''));
    }
  }
  const metaEl = info.block.querySelector('.tool-meta');
  if (metaEl) metaEl.textContent = toolMeta(name || info.name, args);

  const nameEl = info.block.querySelector('.tool-name');
  if (nameEl) {
    nameEl.textContent = toolLiveTitle(name || info.name, args);
    if (args && args.tool_title) nameEl.dataset.locked = '1';
  }

  window.IexaChatActivity.updateTool(info.block, name || info.name, args);
  if (!info.block.dataset.executionStatus) setToolStepStatus(info.block, 'queued', '排队中');
  updateTaskSummary(toolLiveTitle(name || info.name, args));
  scrollToBottom();
}

function setPagedText(element, text, options) {
  text = String(text || '');
  options = options || {};
  element._fullText = text;
  const pageSize = 16000;
  if (text.length <= pageSize && !element._pager) {
    element.textContent = text;
    return;
  }
  if (!element._pager) {
    const controls = document.createElement('div');
    controls.className = 'text-pager';
    const previous = document.createElement('button');
    const next = document.createElement('button');
    const copy = document.createElement('button');
    const label = document.createElement('span');
    previous.textContent = '上一页';
    next.textContent = '下一页';
    copy.textContent = '复制全文';
    for (const button of [previous, next, copy]) button.type = 'button';
    controls.append(previous, label, next, copy);
    element.after(controls);
    element._page = 0;
    element._pager = { previous, next, label };
    previous.onclick = () => { element._page--; setPagedText(element, element._fullText); };
    next.onclick = () => { element._page++; setPagedText(element, element._fullText); };
    copy.onclick = () => writeClipboardText(element._fullText).catch((error) => addError(error.message));
  }
  const pages = Math.max(1, Math.ceil(text.length / pageSize));
  if (options.followLatest) element._page = pages - 1;
  element._page = Math.max(0, Math.min(element._page, pages - 1));
  element.textContent = text.slice(element._page * pageSize, (element._page + 1) * pageSize);
  element._pager.label.textContent = `${element._page + 1} / ${pages}`;
  element._pager.previous.disabled = element._page === 0;
  element._pager.next.disabled = element._page === pages - 1;
}

function handleToolResult(id, output, success, todos, fileChange, imageData, imageMimeType, artifacts, executionStatus, durationMs, pluginUI, metadata) {
  window.IexaQuestionCard?.completeForResult?.(id, { success, executionStatus });
  const info = currentToolBlocks[id];
  if (!info) return;

  window.IexaToolLifecycleView.applyResult(info.block, { success, executionStatus, metadata }, setToolStepStatus);
  info.block.dataset.finishedAt = String(Date.now());
  window.IexaChatActivity.updateTool(info.block, info.name, undefined, { success, fileChange, pluginUI });
  refreshToolGroupSummary(info.block.closest('.tool-steps'));

  if (Array.isArray(todos) && success && currentAssistantMsg) {
    renderTodoPlan(currentAssistantMsg, todos);
  }

  const bodyEl = info.block.querySelector('.tool-body');
  if (bodyEl) {
    // Keep args, replace/append result
    let resultPre = bodyEl.querySelector('.tool-result');
    if (!resultPre) {
      resultPre = document.createElement('pre');
      resultPre.className = 'tool-result';
      const outputLabel = document.createElement('div');
      outputLabel.className = 'tool-section-label tool-output-label';
      outputLabel.textContent = '输出';
      bodyEl.appendChild(outputLabel);
      bodyEl.appendChild(resultPre);
    }
    setPagedText(resultPre, output || '');
    const startedAt = Number(info.block.dataset.startedAt || 0);
    const elapsed = Number.isFinite(durationMs) ? durationMs : startedAt ? Date.now() - startedAt : null;
    const duration = elapsed !== null ? (elapsed / 1000).toFixed(elapsed > 10_000 ? 1 : 2) + 's' : '';
    const status = info.block.querySelector('.tool-status');
    if (status && duration) status.insertAdjacentHTML('beforeend', `<span class="tool-duration">${duration}</span>`);
    if (imageData && imageMimeType && !(artifacts && artifacts.length)) {
      const image = document.createElement('button');
      image.type = 'button';
      image.className = 'tool-result-image';
      image.title = '点击查看图片';
      const img = document.createElement('img');
      img.src = `data:${imageMimeType};base64,${imageData}`;
      img.alt = '工具生成的图片';
      image.appendChild(img);
      image.addEventListener('click', () => openImagePreview(img.src, '工具生成的图片', img));
      bodyEl.appendChild(image);
    }
    if (fileChange && fileChange.path) {
      info.fileChange = fileChange;
      info.success = !!success;
      renderFileChange(bodyEl, fileChange);
    }
    const mediaArtifacts = artifacts && artifacts.length
      ? artifacts
      : imageData && imageMimeType
        ? [{ kind: 'image', path: '生成图片', mimeType: imageMimeType, url: `data:${imageMimeType};base64,${imageData}` }]
        : [];
    if (mediaArtifacts.length) {
      // display_file is an explicit model instruction. Place its media after
      // this exact tool step, not in a shared end-of-message gallery, so the
      // visible order matches the streamed tool-call/result order.
      if (info.name === 'display_file') renderToolArtifactsAfterStep(info.block, mediaArtifacts);
      else renderToolArtifacts(bodyEl, mediaArtifacts);
    }
  }

  window.IexaChatActivity.refreshDetail(info.block);

  // A tool result is followed by another provider turn. Show the same
  // lightweight status again only after all visible tool steps are complete.
  const hasActiveTool = Object.values(currentToolBlocks || {}).some((item) => {
    const status = item && item.block && item.block.dataset.status;
    return ['running', 'streaming', 'queued', 'awaiting-approval', 'cancelling'].includes(status);
  });
  if (!hasActiveTool) showWaitingIndicator();

  scrollToBottom();
}

function renderToolArtifactsAfterStep(stepBlock, artifacts) {
  if (!stepBlock || !Array.isArray(artifacts) || artifacts.length === 0) return;
  let card = stepBlock.nextElementSibling;
  if (!card || !card.classList.contains('tool-artifacts') || card.dataset.toolMediaFor !== stepBlock.dataset.toolId) {
    card = document.createElement('div');
    card.className = 'tool-artifacts tool-artifacts-streamed';
    card.dataset.toolMediaFor = stepBlock.dataset.toolId || '';
    stepBlock.after(card);
  }
  renderToolArtifacts(card, artifacts);
}

function renderToolArtifacts(host, artifacts) {
  if (!host || !Array.isArray(artifacts)) return;
  let card = host.classList && host.classList.contains('tool-artifacts')
    ? host
    : host.querySelector('.tool-artifacts');
  if (!card) {
    card = document.createElement('div');
    card.className = 'tool-artifacts';
    const usage = host.querySelector('.message-usage');
    if (usage) host.insertBefore(card, usage); else host.appendChild(card);
  }
  for (const artifact of artifacts) {
    if (!artifact || !artifact.path) continue;
    const rel = String(artifact.path).replace(/\\/g, '/').replace(/^\.\//, '');
    const src = artifact.url || `${API_BASE}/api/fs/raw?path=${encodeURIComponent(rel)}`;
    if (Array.from(card.children).some((child) => child.dataset && child.dataset.artifactKey === src)) continue;
    if (artifact.kind === 'image' || String(artifact.mimeType || '').startsWith('image/')) {
      const button = document.createElement('div');
      button.className = 'tool-artifact-image';
      button.dataset.artifactKey = src;
      button.title = '点击查看生成的图片';
      button.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(rel)}"><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存图片" aria-label="保存图片" data-ui-action="stop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a><button type="button" class="tool-artifact-action tool-artifact-copy" title="复制图片" aria-label="复制图片"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg></button></span></span>`;
      button.addEventListener('click', (event) => {
        if (event.target.closest('.tool-artifact-actions')) return;
        openImagePreview(src, rel, button.querySelector('img'));
      });
      button.querySelector('.tool-artifact-copy').addEventListener('click', (event) => {
        event.stopPropagation();
        copyArtifactImage(src, event.currentTarget);
      });
      card.appendChild(button);
    } else if (artifact.kind === 'video' || String(artifact.mimeType || '').startsWith('video/')) {
      const media = document.createElement('div');
      media.className = 'tool-artifact-media tool-artifact-video';
      media.dataset.artifactKey = src;
      media.innerHTML = `<video controls preload="metadata" playsinline src="${escapeHtml(src)}" aria-label="${escapeHtml(rel)}"></video><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存视频" aria-label="保存视频" data-ui-action="stop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a></span></span>`;
      media.querySelector('video').addEventListener('dblclick', () => window.open(src, '_blank', 'noopener,noreferrer'));
      card.appendChild(media);
    } else if (artifact.kind === 'audio' || String(artifact.mimeType || '').startsWith('audio/')) {
      const media = document.createElement('div');
      media.className = 'tool-artifact-media tool-artifact-audio';
      media.dataset.artifactKey = src;
      media.innerHTML = `<audio controls preload="metadata" src="${escapeHtml(src)}" aria-label="${escapeHtml(rel)}"></audio><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存音频" aria-label="保存音频" data-ui-action="stop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a></span></span>`;
      card.appendChild(media);
    } else {
      const link = document.createElement('a');
      link.className = 'tool-artifact-file';
      link.dataset.artifactKey = src;
      link.href = src;
      link.textContent = rel;
      const htmlTarget = (isHtmlFilePath(rel) || String(artifact.mimeType || '').toLowerCase() === 'text/html')
        ? resolveHtmlPreviewTarget(artifact.path)
        : null;
      if (htmlTarget) {
        link.classList.add('is-html-preview');
        link.title = '在 IEXA 中预览 HTML 效果';
        link.addEventListener('click', (event) => {
          event.preventDefault();
          openHtmlPreview(htmlTarget);
        });
      } else {
        link.target = '_blank';
        link.rel = 'noreferrer';
      }
      card.appendChild(link);
    }
  }
  if (card.children.length && card !== host && card.parentElement !== host) host.appendChild(card);
}

async function copyArtifactImage(src, button) {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    } else {
      throw new Error('clipboard image unsupported');
    }
    button.classList.add('is-copied');
    setTimeout(() => button.classList.remove('is-copied'), 1200);
  } catch (error) {
    console.warn('copy artifact image failed', error);
    (await window.IexaDialogs.alert('当前系统不支持直接复制图片，请使用保存按钮。'));
  }
}

function normalizeTodoItems(todos) {
  if (!Array.isArray(todos)) return [];
  const seen = new Set();
  return todos.map((item) => ({
    content: String(item?.content || '').trim(),
    status: String(item?.status || ''),
  })).filter((item) => item.content && ['pending', 'in_progress', 'completed'].includes(item.status) && !seen.has(item.content.toLowerCase()) && seen.add(item.content.toLowerCase()));
}

function renderTodoPlan(messageEl, todos) {
  const items = normalizeTodoItems(todos);
  if (!messageEl || !items.length) return;
  let panel = messageEl.querySelector('.todo-plan');
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'todo-plan';
    const host = messageEl.querySelector('.tool-steps');
    const answer = messageEl.querySelector('.message-content.message-answer');
    if (answer) answer.before(panel);
    else if (host) host.after(panel);
    else messageEl.appendChild(panel);
  }
  const done = items.filter((item) => item.status === 'completed').length;
  const active = items.find((item) => item.status === 'in_progress');
  panel.innerHTML = `<div class="todo-plan-heading">${uiIcon('check')}<span>任务计划</span><b>${done}/${items.length}</b></div><div class="todo-plan-items"></div>`;
  const list = panel.querySelector('.todo-plan-items');
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `todo-plan-item is-${item.status}`;
    const marker = item.status === 'completed' ? uiIcon('check') : item.status === 'in_progress' ? '<i class="todo-plan-spinner" aria-hidden="true"></i>' : '<i class="todo-plan-dot" aria-hidden="true"></i>';
    row.innerHTML = `<span class="todo-plan-marker">${marker}</span><span>${escapeHtml(item.content)}</span>`;
    list.appendChild(row);
  }
  panel.title = active ? `进行中：${active.content}` : done === items.length ? '计划已完成' : '等待下一步执行';
}

function latestTodoPlanFromCalls(calls) {
  let plan = null;
  for (const call of calls || []) {
    if (call?.name !== 'todo_write' || call?.result?.success === false) continue;
    const todos = call?.result?.todos || call?.args?.todos;
    if (normalizeTodoItems(todos).length) plan = todos;
  }
  return plan;
}
function renderDeliverables(messageEl, files) {
  if (!messageEl || !Array.isArray(files)) return;
  const unique = window.IexaFileChanges.group(files);
  let panel = messageEl.querySelector('.turn-deliverables');
  if (!unique.length) { panel?.remove(); return; }
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'turn-deliverables';
    const footer = assistantFooterAnchor(messageEl);
    if (footer) messageEl.insertBefore(panel, footer); else messageEl.appendChild(panel);
  }
  const sessionId = messageEl.dataset.liveSessionId || currentSessionId;
  const turnId = messageEl.dataset.transcriptTurnId;
  panel.replaceChildren();
  panel.setAttribute('aria-label', '本轮文件修改');
  const totals = unique.reduce((sum, file) => ({added: sum.added + (Number(file.added) || 0), removed: sum.removed + (Number(file.removed) || 0)}), {added:0, removed:0});
  const counts = file => `<span class="diff-add">+${Number(file.added) || 0}</span><span class="diff-del">−${Number(file.removed) || 0}</span>`;
  const heading = document.createElement('button');
  heading.type = 'button';
  heading.className = 'turn-deliverables-heading';
  heading.setAttribute('aria-expanded', 'true');
  const bodyId = `turn-deliverables-${Math.random().toString(36).slice(2, 9)}`;
  heading.setAttribute('aria-controls', bodyId);
  heading.title = '展开或收起文件列表';
  heading.innerHTML = `${uiIcon('file')}<strong>已编辑 ${unique.length} 个文件</strong><span class="turn-change-counts">${counts(totals)}</span><span class="turn-deliverables-chevron" aria-hidden="true"></span>`;
  const filesEl = document.createElement('div');
  filesEl.className = 'turn-deliverable-files';
  for (const file of unique) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'turn-change-file'; row.title = file.path;
    row.innerHTML = `${uiIcon('file')}<span class="turn-deliverable-name">${escapeHtml(file.path)}</span><span class="turn-change-counts">${counts(file)}</span>`;
    row.setAttribute('aria-label', `审查文件：${file.path}`);
    row.addEventListener('click', () => { setCollapsed(false); showReview(file); });
    filesEl.appendChild(row);
  }
  const actions = document.createElement('div'); actions.className = 'turn-change-actions';
  const status = document.createElement('span'); status.className = 'turn-change-status'; status.setAttribute('role','status');
  const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'turn-change-undo'; undo.textContent = '撤销';
  const review = document.createElement('button'); review.type = 'button'; review.className = 'turn-change-review'; review.textContent = '审查'; review.setAttribute('aria-expanded','false');
  const details = document.createElement('div'); details.className = 'turn-change-details'; details.hidden = true;
  const undone = new Set(messageEl._fileUndoPaths || []);
  const allUndone = unique.every(file => undone.has(file.absolutePath));
  const unavailable = !turnId ? '旧记录缺少本轮标识' : files.some(file => !(file.rollback || file.hasRollback)) ? (files.find(file=>file.undoUnavailable)?.undoUnavailable || '旧记录没有完整撤销快照') : '';
  undo.disabled = allUndone || !!unavailable;
  undo.title = allUndone ? '本轮修改已撤销' : unavailable || '恢复本轮修改前的文件；后续修改会触发冲突保护';
  if (allUndone) { undo.textContent = '已撤销'; status.textContent = '文件已恢复'; }
  else if (unavailable) status.textContent = unavailable;
  else if (unique.some(file => file.previewTruncated)) status.textContent = '大文件显示截取预览；统计为各次修改累计';
  else if (unique.some(file => file.exact === false)) status.textContent = '大范围差异按块替换统计';
  function showReview(selected) {
    details.replaceChildren();
    for (const file of selected ? [selected] : unique) {
      const section = document.createElement('section');
      const title = document.createElement('strong'); title.textContent = file.path; section.appendChild(title);
      if (typeof file.before !== 'string' || typeof file.after !== 'string') {
        const note = document.createElement('p'); note.textContent = '此旧记录未保存差异内容'; section.appendChild(note);
      } else {
        const diff = window.IexaFileChanges.diff(file.before, file.after);
        const visible = new Set();
        diff.ops.forEach((op,i)=>{if(op.type!=='context')for(let j=Math.max(0,i-3);j<=Math.min(diff.ops.length-1,i+3);j++)visible.add(j);});
        const lines = []; let previous = -1;
        for (const i of visible) { if(i>previous+1)lines.push({type:'context',text:'…'}); lines.push(diff.ops[i]); previous=i; }
        if (!lines.length) { const note=document.createElement('p');note.textContent='内容无净变化';section.appendChild(note); }
        else if (lines.length > 2000) { const pre=document.createElement('pre');section.appendChild(pre);setPagedText(pre,lines.map(op=>(op.type==='added'?'+':op.type==='removed'?'-':' ')+op.text).join('\n')); }
        else for (const op of lines) { const line=document.createElement('div');line.className=`diff-line diff-${op.type}`;line.textContent=(op.type==='added'?'+':op.type==='removed'?'−':' ')+op.text;section.appendChild(line); }
        if (file.previewTruncated) { const note=document.createElement('p');note.textContent='差异预览已截取，完整文件请在项目中打开。';section.appendChild(note); }
      }
      details.appendChild(section);
    }
    details.hidden = false; setReviewOpen(true);
  }
  review.addEventListener('click', () => {
    if (panel.classList.contains('is-collapsed')) { setCollapsed(false); showReview(); return; }
    if (details.hidden) showReview(); else setReviewOpen(false);
  });
  undo.addEventListener('click', async () => {
    if (sessionRuntimes.get(sessionId)?.isProcessing) {status.textContent='请等待该会话任务结束后撤销';return;}
    if (!(await window.IexaDialogs.confirm('撤销本轮文件修改？新建文件将删除，已有文件将恢复到本轮修改前。'))) return;
    undo.disabled = true; status.textContent = '正在校验并撤销…';
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/undo`, {method:'POST'});
      const data = await response.json();
      if (data.restoredPaths) messageEl._fileUndoPaths = data.restoredPaths;
      if (!response.ok) throw new Error(data.error || '撤销未完成');
      undo.textContent = '已撤销'; status.textContent = '文件已恢复'; undo.title = '本轮修改已撤销';
    } catch (error) { status.textContent = error.message; undo.disabled=false; }
  });
  const body = document.createElement('div');
  body.className = 'turn-deliverables-body';
  body.id = bodyId;
  body.append(filesEl, details);

  function setReviewOpen(open) {
    details.hidden = !open;
    review.setAttribute('aria-expanded', String(open));
    review.textContent = open ? '收起' : '审查';
  }
  function setCollapsed(collapsed) {
    panel.classList.toggle('is-collapsed', collapsed);
    heading.setAttribute('aria-expanded', String(!collapsed));
    messageEl._deliverablesCollapsed = collapsed;
    if (collapsed) setReviewOpen(false);
  }
  heading.addEventListener('click', () => setCollapsed(!panel.classList.contains('is-collapsed')));

  actions.append(status, undo, review);
  panel.append(heading, body, actions);
  setCollapsed(messageEl._deliverablesCollapsed === true);
}

async function openDeliverablePreview(path, absolutePath) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (isHtmlFilePath(absolutePath || normalized) && openHtmlPreview(absolutePath || normalized)) return;
  // The project file preview is safer and keeps the user in IEXA when this
  // deliverable belongs to the currently opened project.
  if (projectRoot && normalized && !/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
    await openFilePreview(normalized);
    return;
  }
  if (absolutePath && window.iexaDesktop && typeof window.iexaDesktop.openPath === 'function') {
    await window.iexaDesktop.openPath(absolutePath);
  }
}

function collectLiveDeliverables() {
  return Object.values(currentToolBlocks || {})
    .filter((info) => info?.fileChange && info?.success)
    .map((info) => info.fileChange);
}

function renderFileChange(host, change) {
  let card = host.querySelector('.file-change-card');
  if (card) card.remove();
  card = document.createElement('div');
  card.className = 'file-change-card';
  // Long sessions can hold dozens of edit cards; restoring or streaming a task
  // must never block on thousands of diff rows. Build the rows lazily on first
  // expand and cap each side — the full change stays reviewable in the file.
  const MAX_DIFF_LINES = 240;
  const diff = document.createElement('div');
  diff.className = 'file-change-diff';
  diff.hidden = true;
  diff.dataset.built = '0';
  const buildDiff = () => {
    if (diff.dataset.built === '1') return;
    diff.dataset.built = '1';
    const before = String(change.before || '').split(/\r?\n/);
    const after = String(change.after || '').split(/\r?\n/);
    const oldLines = before.slice(0, MAX_DIFF_LINES).map((line) => `<div class="diff-line diff-removed"><span>-</span>${escapeHtml(line)}</div>`).join('');
    const newLines = after.slice(0, MAX_DIFF_LINES).map((line) => `<div class="diff-line diff-added"><span>+</span>${escapeHtml(line)}</div>`).join('');
    const truncated = before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES;
    const note = truncated ? `<div class="diff-line diff-note">… 仅显示前后各前 ${MAX_DIFF_LINES} 行，完整差异请打开文件查看</div>` : '';
    diff.innerHTML = oldLines + newLines + note;
  };
  card.innerHTML = `<div class="file-change-header"><button type="button" class="file-change-path" title="打开文件">已编辑 ${escapeHtml(change.path)}</button><b class="diff-add">+${Number(change.added) || 0}</b><b class="diff-del">-${Number(change.removed) || 0}</b><button type="button" class="file-change-review">审查</button></div>`;
  card.appendChild(diff);
  card.querySelector('.file-change-review').addEventListener('click', (e) => {
    diff.hidden = !diff.hidden;
    if (!diff.hidden) buildDiff();
    e.currentTarget.textContent = diff.hidden ? '审查' : '收起';
  });
  card.querySelector('.file-change-path').addEventListener('click', () => {
    if (typeof openFilePreview === 'function') openFilePreview(change.path);
  });
  host.appendChild(card);
}

function normalizeRenderedAssets(contentEl) {
  if (!contentEl) return;
  contentEl.querySelectorAll('img').forEach((img) => {
    const raw = img.getAttribute('src') || '';
    if (/^(?:workspace\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/.test(raw) && !raw.startsWith('data:')) {
      // When a project is open, workspace/ is a real child of the project root.
      // Without a project, the API root is workspace itself.
      const rel = (projectRoot ? raw : raw.replace(/^workspace[\\/]/i, ''))
        .replace(/^[.][\\/]/, '').replace(/\\/g, '/');
      img.src = `${API_BASE}/api/fs/raw?path=${encodeURIComponent(rel)}`;
      img.addEventListener('click', () => openImagePreview(img.src, img.alt || '图片', img));
      img.style.cursor = 'zoom-in';
    }
  });
  contentEl.querySelectorAll('a').forEach((link) => {
    if (link.dataset.iexaHtmlPreview) return;
    const rawHref = link.getAttribute('href') || '';
    const target = resolveHtmlPreviewTarget(rawHref);
    if (!target) return;
    link.dataset.iexaHtmlPreview = target.displayPath || target.path;
    link.classList.add('markdown-html-preview-link');
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.title = '在 IEXA 中预览 HTML 效果';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openHtmlPreview(target);
    });
  });
}

function formatTurnDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return total + ' 秒';
  if (total < 3600) {
    return Math.floor(total / 60) + ' 分 ' + String(total % 60).padStart(2, '0') + ' 秒';
  }
  return Math.floor(total / 3600) + ' 小时 ' + String(Math.floor((total % 3600) / 60)).padStart(2, '0') + ' 分';
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
    `<em>耗时</em> <span class="message-usage-duration-value">${formatTurnDuration(duration.ms)}</span></span>`;
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
    parts.push(`<span title="输入 ${input.toLocaleString()} tokens">${formatTokenCount(input)} <em>入</em></span>`);
    parts.push('<i aria-hidden="true"></i>');
    parts.push(`<span title="输出 ${output.toLocaleString()} tokens">${formatTokenCount(output)} <em>出</em></span>`);
    if (cacheReadTokens !== undefined && cacheReadTokens !== null && Number.isFinite(cacheRead)) {
      parts.push('<i aria-hidden="true"></i>');
      const cache = Math.max(0, Math.round(cacheRead));
      parts.push(`<span title="缓存读取 ${cache.toLocaleString()} tokens">${formatTokenCount(cache)} <em>缓存</em></span>`);
    }
  }
  if (duration) {
    if (parts.length) parts.push('<i aria-hidden="true"></i>');
    parts.push(renderTurnDurationMarkup(duration));
  }
  const timestamp = Number(messageEl && messageEl.dataset.timestamp);
  const timeText = formatMessageTimestamp(timestamp);
  if (timeText) {
    parts.push(`<time class="message-usage-time" datetime="${new Date(timestamp).toISOString()}" title="生成时间：${new Date(timestamp).toLocaleString()}">${timeText}</time>`);
  }
  usageEl.innerHTML = parts.join('');
  if (duration && duration.running) registerLiveTurnDuration(usageEl.querySelector('.message-usage-duration'));
}

function formatContextTokens(tokens) {
  return formatTokenCount(tokens);
}

function handleContextStatus(context) {
  if (!context || !contextProgress || !contextProgressValue || !contextProgressTooltip) return;
  latestContextStatus = context;
  // Background task pressure belongs to its own runtime. Do not repaint the
  // selected conversation's context ring on every foreign SSE event.
  if (currentSessionId !== visibleSessionId) return;
  const windowTokens = Math.max(1, Number(context.contextWindow) || 128000);
  const usedTokens = Math.max(0, Number(context.usedTokens) || 0);
  const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
  const state = context.state || 'ok';
  contextProgress.dataset.state = state;
  contextProgressValue.style.strokeDasharray = percent + ' 100';
  const percentLabel = document.getElementById('contextProgressPercent');
  if (percentLabel) percentLabel.textContent = percent + '%';
  const source = context.estimated ? '估算' : '模型实测';
  const thresholdTokens = Math.max(1, Number(context.compactThreshold) || Math.round(windowTokens * 0.8));
  const thresholdPercent = Math.min(100, Math.round((thresholdTokens / windowTokens) * 100));
  let statusText = state === 'compacting' ? '正在自动压缩上下文' :
    state === 'compacted' ? '已自动压缩上下文' :
    state === 'near-limit' ? '接近自动压缩阈值' :
    state === 'exhausted' ? '上下文接近上限' : '上下文用量';
  const detail = `${statusText}：${formatContextTokens(usedTokens)} / ${formatContextTokens(windowTokens)} tokens（${percent}% · ${source}）· 自动压缩阈值 ${thresholdPercent}%`;
  contextProgress.title = detail;
  contextProgressTooltip.textContent = detail;
}

let tokenUsageRecords = [];

let checkpointOpen = false;

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

function formatCheckpointTime(value) {
  const date = new Date(Number(value) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function renderCheckpoints() {
  const list = document.getElementById('checkpointList');
  if (!list) return;
  if (!currentSessionId) { list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.noSession'))}</div>`; return; }
  list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.loading'))}</div>`;
  try {
    const response = await fetch(`${API_BASE}/api/checkpoints?sessionId=${encodeURIComponent(currentSessionId)}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'load failed');
    const items = Array.isArray(data.checkpoints) ? data.checkpoints : [];
    if (!items.length) { list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.empty'))}</div>`; return; }
    list.innerHTML = items.map((item) => `
      <div class="checkpoint-row">
        <div class="checkpoint-meta">
          <span class="checkpoint-label" title="${escapeHtml(item.label || '')}">${escapeHtml(item.label || IexaI18n.t('checkpoint.unnamed'))}</span>
          <span class="checkpoint-sub">${formatCheckpointTime(item.createdAt)} · ${escapeHtml(IexaI18n.t('checkpoint.files', { count: Number(item.changeCount) || 0 }))}</span>
        </div>
        <button type="button" class="checkpoint-restore" data-ui-action="rewindCheckpoint" data-ui-arg="${escapeHtml(item.id)}">${escapeHtml(IexaI18n.t('checkpoint.restore'))}</button>
      </div>`).join('');
  } catch (error) {
    list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.loadFailed', { message: error.message || String(error) }))}</div>`;
  }
}

const CHECKPOINT_POPOVER_GAP = 10;
const CHECKPOINT_POPOVER_MARGIN = 8;

// The panel is fixed-positioned and clamped, so it can never be pushed off
// screen nor end up under the sidebar in a narrow window.
function positionCheckpointPopover() {
  const popover = document.getElementById('checkpointPopover');
  const button = document.getElementById('checkpointBtn');
  if (!popover || !button || popover.hidden) return;
  const anchor = button.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - CHECKPOINT_POPOVER_MARGIN * 2);
  popover.style.width = `${Math.round(width)}px`;
  const height = popover.offsetHeight;
  const left = Math.min(
    Math.max(CHECKPOINT_POPOVER_MARGIN, anchor.right - width),
    Math.max(CHECKPOINT_POPOVER_MARGIN, window.innerWidth - width - CHECKPOINT_POPOVER_MARGIN),
  );
  let top = anchor.top - height - CHECKPOINT_POPOVER_GAP;
  if (top < CHECKPOINT_POPOVER_MARGIN) {
    // Not enough room above the toolbar: open downwards instead, still clamped.
    top = Math.min(anchor.bottom + CHECKPOINT_POPOVER_GAP, window.innerHeight - height - CHECKPOINT_POPOVER_MARGIN);
  }
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(Math.max(CHECKPOINT_POPOVER_MARGIN, top))}px`;
}

function setCheckpointOpen(open) {
  checkpointOpen = open;
  const popover = document.getElementById('checkpointPopover');
  const button = document.getElementById('checkpointBtn');
  if (popover) {
    if (open && popover.parentElement !== document.body) {
      // Escape the composer's stacking context; see the CSS comment.
      document.body.appendChild(popover);
    }
    popover.hidden = !open;
    if (open) positionCheckpointPopover();
  }
  if (button) button.setAttribute('aria-expanded', String(open));
  // The list is fetched, so its final height is only known after it renders.
  if (open) renderCheckpoints().then(positionCheckpointPopover, () => {});
}

window.addEventListener('resize', () => {
  if (checkpointOpen) positionCheckpointPopover();
});

async function rewindCheckpoint(checkpointId) {
  if (!currentSessionId || !checkpointId) return;
  const confirmed = await IexaDialogs.confirm(IexaI18n.t('checkpoint.confirm'));
  if (!confirmed) return;
  try {
    const response = await fetch(`${API_BASE}/api/checkpoints/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, checkpointId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '回退失败');
    if (projectRoot) loadFilesList(filesCurrentPath, true);
    await renderCheckpoints();
  } catch (error) {
    addError(error.message || String(error));
  }
}

/**
 * Token counts are magnitudes, not ledger lines: "132K" is read at a glance
 * where "132,225" has to be parsed digit by digit. Three significant digits
 * is plenty to compare two turns, and the exact value stays in the hover
 * title, so nothing is lost. Every surface that prints a token count (message
 * receipt, thinking badge, context ring, token page) shares this rule.
 */
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
  if (value === null || value === undefined || value === '') return '未配置价格';
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) return '未配置价格';
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

function renderTokenUsage() {
  const list = document.getElementById('tokenUsageList');
  const updated = document.getElementById('tokenUsageUpdated');
  const clearAll = document.getElementById('tokenUsageClearAll');
  if (!list) return;
  const records = [...tokenUsageRecords].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (clearAll) clearAll.hidden = records.length === 0;
  if (!records.length) {
    list.innerHTML = '<div class="token-usage-empty">尚无模型用量记录，发送消息后会自动统计。</div>';
    if (updated) updated.textContent = '等待首次调用';
    return;
  }
  list.innerHTML = records.map((r) => {
    const input = Number(r.inputTokens) || 0;
    const output = Number(r.outputTokens) || 0;
    const total = input + output;
    const cache = (Number(r.cacheCreationInputTokens) || 0) + (Number(r.cacheReadInputTokens) || 0);
    const key = escapeHtml(r.key || '');
    return `<div class="token-usage-model-card">
      <div class="token-usage-model-head">
        <div class="token-usage-model-id"><strong>${escapeHtml(r.model || '未知模型')}</strong><span>${escapeHtml(r.provider || '')}${r.profileName ? ` · ${escapeHtml(r.profileName)}` : ''}</span></div>
        <div class="token-usage-model-side"><b>${formatUsageNumber(total)}</b><button type="button" class="token-usage-model-delete" data-ui-action="deleteTokenUsage" data-ui-arg="${key}" title="删除该记录" aria-label="删除该记录">${uiIcon('trash')}</button></div>
      </div>
      <div class="token-usage-model-stats">
        <div><span>输入</span><strong>${formatUsageNumber(input)}</strong></div>
        <div><span>输出</span><strong>${formatUsageNumber(output)}</strong></div>
        <div><span>调用次数</span><strong>${Number(r.requests || 0).toLocaleString()}</strong></div>
        <div class="token-usage-model-stat-cache"><span>缓存</span><strong>${formatUsageNumber(cache)}</strong><small class="token-usage-model-pct">${formatUsagePercent(cache, input + cache)}</small></div>
      </div>
      <div class="token-usage-model-time">费用估算：${formatEstimatedCost(r.estimatedCostUsd)} · 最近更新：${r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '—'}</div>
    </div>`;
  }).join('');
  if (updated) updated.textContent = '刚刚自动更新';
}

async function loadTokenUsage() {
  try {
    const response = await fetch(`${API_BASE}/api/token-usage`);
    const data = await response.json();
    tokenUsageRecords = Array.isArray(data.records) ? data.records : [];
    renderTokenUsage();
  } catch (err) { console.error('Failed to load token usage:', err); }
}

async function deleteTokenUsage(key) {
  if (!key) return;
  if (!(await window.IexaDialogs.confirm('删除这个模型的 Token 用量记录？'))) return;
  const response = await fetch(`${API_BASE}/api/token-usage/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!response.ok) { console.error('Failed to delete token usage:', response.status); return; }
  await loadTokenUsage();
}

async function clearTokenUsage() {
  if (!(await window.IexaDialogs.confirm('清空全部 Token 用量记录？此操作不可撤销。'))) return;
  const response = await fetch(`${API_BASE}/api/token-usage`, { method: 'DELETE' });
  if (!response.ok) { console.error('Failed to clear token usage:', response.status); return; }
  await loadTokenUsage();
}

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
  loadJobs();
}

init();

