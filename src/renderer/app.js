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
  return `<svg class="ui-icon ui-icon-${safeName}"${label ? ` role="img" aria-label="${safeLabel}"` : ' aria-hidden="true"'}><use href="#ui-${safeName}"></use></svg>`;
}


// =============================================================================
// Markdown + code highlighting
// =============================================================================
if (window.marked && window.hljs) {
  marked.use({
    renderer: {
      code({ text, lang, escaped }) {
        let highlighted;
        if (lang && hljs.getLanguage(lang)) {
          try { highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
          catch (e) { /* fall through */ }
        }
        if (!highlighted) {
          try { highlighted = hljs.highlightAuto(text).value; }
          catch (e) { highlighted = text; }
        }
        const langAttr = lang ? ` class="language-${lang}"` : '';
        return `<pre><code${langAttr}>${highlighted}</code></pre>`;
      },
    },
  });
}

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
// Ignore late /api/sessions/:id responses after the user has selected another
// chat. Without this fence a slower earlier switch can repaint the new surface.
let sessionViewEpoch = 0;

// DOM Elements
// The visible chat surface belongs only to the selected conversation. Other
// sessions render directly into their detached fragment, so streaming updates
// never move or repaint the conversation the user is reading or typing in.
const visibleChatMessages = document.getElementById('chatMessages');
let chatMessages = visibleChatMessages;
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
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

function runtimeForSession(sessionId) {
  let runtime = sessionRuntimes.get(sessionId);
  if (!runtime) {
    runtime = { fragment: document.createDocumentFragment() };
    sessionRuntimes.set(sessionId, runtime);
  }
  return runtime;
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
    runtime.scrollTop = visibleChatMessages.scrollTop;
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
  if (surface === visibleChatMessages && Number.isFinite(runtime.scrollTop)) {
    visibleChatMessages.scrollTop = runtime.scrollTop;
  }
}

function restoreVisibleSessionRuntime(sessionId) {
  currentSessionId = sessionId;
  chatMessages = visibleChatMessages;
  applySessionRuntime(sessionId);
}

function withSessionRuntime(sessionId, work) {
  if (!sessionId || sessionId === currentSessionId) return work();
  const previousVisibleSessionId = currentSessionId;
  snapshotActiveSessionRuntime();
  currentSessionId = sessionId;
  const runtime = runtimeForSession(sessionId);
  chatMessages = runtime.fragment;
  applySessionRuntime(sessionId);
  try { return work(); }
  finally {
    snapshotActiveSessionRuntime();
    restoreVisibleSessionRuntime(previousVisibleSessionId);
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

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const panel = document.getElementById(`view-${view}`);
    if (panel) panel.classList.add('active');

    if (view === 'settings') {
      loadSettings();
    }
    if (view === 'skills') {
      loadSkillsList();
    }
    if (view === 'token-calculator') {
      loadTokenUsage();
    }
    if (view === 'jobs') {
      loadJobs();
    }
    if (view === 'mcp') {
      loadMcpServers();
    }
    syncJobsPolling();
  });
});

// =============================================================================
// Session Management
// =============================================================================

const sessionsList = document.getElementById('sessionsList');
const newSessionBtn = document.getElementById('newSessionBtn');
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const searchResults = document.getElementById('searchResults');

async function loadSessionList() {
  try {
    const resp = await fetch(`${API_BASE}/api/sessions`);
    const data = await resp.json();
    sessionsCache = data.sessions || [];
    // If no active session, pick first or create one
    if (!currentSessionId && sessionsCache.length > 0) {
      const activeId = data.activeSessionId || sessionsCache[0].id;
      await switchSession(activeId, false);
    } else if (sessionsCache.length === 0 && !currentSessionId) {
      await createSession();
    }
    renderSessionList();
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

function renderSessionList() {
  if (sessionsCache.length === 0) {
    sessionsList.innerHTML = '<div class="sessions-empty">暂无会话</div>';
    return;
  }

  sessionsList.innerHTML = sessionsCache.map(s => {
    const active = s.id === currentSessionId ? ' active' : '';
    const timeStr = formatTime(s.updated);
    return `
      <div class="session-item${active}" data-id="${s.id}">
        <div class="session-item-info" onclick="event.stopPropagation(); switchSession('${s.id}')">
          <span class="session-item-title" data-sid="${s.id}" onclick="event.stopPropagation(); startRename('${s.id}')" title="点击重命名">${escapeHtml(s.title)}</span>
          <span class="session-item-time">${sessionRuntimes.get(s.id)?.isProcessing ? '<i class="session-running-dot" title="正在进行"></i>' : ''}${timeStr}</span>
        </div>
        <button class="session-item-delete" onclick="event.stopPropagation(); deleteSession('${s.id}')" title="删除">×</button>
      </div>
    `;
  }).join('');
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHr < 24) return `${diffHr} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString();
}

function formatMessageTimestamp(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return sameDay ? clock : `${date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${clock}`;
}

async function createSession() {
  try {
    // A new session must not cancel a different session running in background.
    snapshotActiveSessionRuntime(true);
    const resp = await fetch(`${API_BASE}/api/sessions`, { method: 'POST' });
    const data = await resp.json();
    if (data.session) {
      currentSessionId = data.session.id;
      visibleSessionId = currentSessionId;
      sessionRuntimes.set(currentSessionId, { fragment: document.createDocumentFragment(), isProcessing: false, currentToolBlocks: {}, promptQueue: [] });
      mountSessionRuntime(currentSessionId);
      clearChat();
      showWelcome();
      setProcessing(false);
      snapshotActiveSessionRuntime();
      await loadSessionList();
      chatInput.focus();
    }
  } catch (err) {
    console.error('Failed to create session:', err);
  }
}

async function switchSession(id, updateList = true) {
  if (!id || id === currentSessionId) return;
  const viewEpoch = ++sessionViewEpoch;
  // Switching only changes the visible surface. Background SSE streams continue.
  snapshotActiveSessionRuntime(true);
  currentSessionId = id;
  visibleSessionId = id;
  if (sessionRuntimes.has(id)) {
    mountSessionRuntime(id);
    syncActiveSessionUI();
    refreshModelSelector().catch(() => {});
  } else {
    clearChat();
    setProcessing(false);

  // Load messages
  try {
    const resp = await fetch(`${API_BASE}/api/sessions/${id}`);
    const data = await resp.json();
    // A newer click selected another session while this request was in flight.
    // Do not append stale history into the current visible chat.
    if (viewEpoch !== sessionViewEpoch || currentSessionId !== id) return;
    const msgs = data.messages || [];

    // Refresh this session's pinned model metadata from the server.
    if (data.session) {
      const index = sessionsCache.findIndex((item) => item.id === id);
      if (index >= 0) sessionsCache[index] = { ...sessionsCache[index], ...data.session };
    }
    const sess = sessionsCache.find(s => s.id === id);

    if (msgs.length === 0) {
      // Empty session: show welcome
      showWelcome();
    } else {
      // Render messages
      for (let messageIndex = 0; messageIndex < msgs.length; messageIndex++) {
        const msg = msgs[messageIndex];
        if (msg.role === 'user') {
          addMessage('user', msg.content, msg.attachments || [], { messageIndex, timestamp: msg.timestamp });
        } else {
          const el = addMessage('assistant', msg.content, undefined, { timestamp: msg.timestamp });
          // Render tool calls if present
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const steps = document.createElement('div');
            steps.className = 'tool-steps is-collapsed';
            const taskSummary = createTaskSummary(msg.toolCalls.length);
            // 历史会话绝不应恢复为运行状态：创建函数默认带 spinner，
            // 因此加载后必须显式收口为静态完成态。
            taskSummary.classList.add('is-complete');
            const historySpinner = taskSummary.querySelector('.task-summary-spinner');
            if (historySpinner) historySpinner.remove();
            taskSummary.querySelector('.task-summary-label').textContent = '任务耗时';
            taskSummary.querySelector('.task-summary-time').textContent = '已完成';
            steps.appendChild(taskSummary);
            for (const tc of msg.toolCalls) {
              const block = document.createElement('div');
              block.className = 'tool-block is-done';
              block.dataset.kind = toolKind(tc.name || '');
              const histTitle = (tc.args && tc.args.tool_title) || toolDisplayName(tc.name);
              block.innerHTML = `
                <div class="tool-header" onclick="toggleToolBody('tool-body-${tc.id}')">
                  <span class="tool-icon">${toolIcon(tc.name)}</span>
                  <span class="tool-heading"><span class="tool-name">${escapeHtml(histTitle)}</span><span class="tool-meta">${escapeHtml(toolMeta(tc.name, tc.args))}</span></span>
                  <span class="tool-status done">${uiIcon('check')}<span>完成</span></span>
                  <span class="tool-chevron" aria-hidden="true"></span>
                </div>
                <div class="tool-body" id="tool-body-${tc.id}" style="display:none;">
                  <div class="tool-section-label">输入</div><pre class="tool-args">${escapeHtml(JSON.stringify(tc.args, null, 2))}</pre>
                </div>
              `;
              if (tc.result) {
                const body = block.querySelector('.tool-body');
                const result = document.createElement('pre');
                result.className = 'tool-result';
                result.textContent = tc.result.output || '';
                body.appendChild(result);
                if (tc.result.fileChange) renderFileChange(body, tc.result.fileChange);
                if (tc.result.artifacts) renderToolArtifacts(el, tc.result.artifacts);
              }
              steps.appendChild(block);
            }
            el.appendChild(steps);
          }
          const todoPlan = latestTodoPlanFromCalls(msg.toolCalls);
          if (todoPlan) renderTodoPlan(el, todoPlan);
          if (msg.deliverables) renderDeliverables(el, msg.deliverables);
          // Render usage if present
          if (msg.usage) {
            const usageEl = document.createElement('div');
            usageEl.className = 'message-usage';
            renderMessageUsage(usageEl, msg.usage.inputTokens || 0, msg.usage.outputTokens || 0);
            el.appendChild(usageEl);
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to load messages:', err);
    showWelcome();
  }
  snapshotActiveSessionRuntime();
  }

  // The composer always describes the selected conversation's pinned route.
  refreshModelSelector().catch(() => {});

  if (updateList) {
    // Update active in store
    try {
      await fetch(`${API_BASE}/api/profiles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeSessionId: id }),
      });
    } catch { /* ignore - sessions store handles this separately */ }
    renderSessionList();
  }
}

async function deleteSession(id) {
  if (!confirm('确定删除这个会话？')) return;

  try {
    const resp = await fetch(`${API_BASE}/api/sessions/${id}`, { method: 'DELETE' });
    const data = await resp.json();

    // Remove both persisted metadata and any in-memory background stream view.
    sessionsCache = sessionsCache.filter(s => s.id !== id);
    const runtime = sessionRuntimes.get(id);
    if (runtime?.currentTaskTimer) window.clearInterval(runtime.currentTaskTimer);
    sessionRuntimes.delete(id);

    if (id === currentSessionId) {
      // Switch to another session or create new
      const next = sessionsCache[0];
      if (next) {
        await switchSession(next.id, false);
      } else {
        currentSessionId = '';
        visibleSessionId = '';
        clearChat();
        showWelcome();
      }
    }

    renderSessionList();

    // If no sessions left, create one
    if (sessionsCache.length === 0) {
      await createSession();
    }
  } catch (err) {
    console.error('Failed to delete session:', err);
  }
}

function startRename(sessionId) {
  const titleEl = document.querySelector(`.session-item-title[data-sid="${sessionId}"]`);
  if (!titleEl) return;

  const sess = sessionsCache.find(s => s.id === sessionId);
  const currentTitle = sess ? sess.title : '';

  // Replace span with input
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'session-item-rename-input';
  input.setAttribute('data-sid', sessionId);

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const finishRename = async () => {
    const newTitle = input.value.trim() || currentTitle;
    // Restore span
    const span = document.createElement('span');
    span.className = 'session-item-title';
    span.setAttribute('data-sid', sessionId);
    span.textContent = newTitle;
    span.title = '点击重命名';
    span.onclick = (e) => { e.stopPropagation(); startRename(sessionId); };
    input.replaceWith(span);

    if (newTitle !== currentTitle) {
      try {
        await fetch(`${API_BASE}/api/sessions/${sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
        if (sess) sess.title = newTitle;
        renderSessionList();
      } catch (err) {
        console.error('Failed to rename:', err);
      }
    }
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') {
      input.value = currentTitle;
      input.blur();
    }
  });
}

function clearChat() {
  chatMessages.innerHTML = '';
  isNearChatBottom = true;
  updateScrollToBottomButton();
  currentAssistantMsg = null;
  currentToolBlocks = {};
  promptQueue = [];
  isDrainingQueue = false;
  suppressQueueDrain = false;
}

function showWelcome() {
  chatMessages.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">${uiIcon('brain')}</div>
      <h2>欢迎使用 IEXA-WIN</h2>
      <p>你的私密、设备端 AI 智能体，带真实 Shell 权限。</p>
      <div class="quick-actions">
        <button class="quick-btn" onclick="sendQuick('列出当前目录的文件')">${uiIcon('folder')}<span>列出文件</span></button>
        <button class="quick-btn" onclick="sendQuick('我的操作系统和硬件配置是什么？')">${uiIcon('monitor')}<span>系统信息</span></button>
        <button class="quick-btn" onclick="sendQuick('创建一个简单的 Python Web 服务器脚本')">${uiIcon('code')}<span>生成 Python 脚本</span></button>
      </div>
    </div>
  `;
}

// Event: New session button
newSessionBtn.addEventListener('click', () => createSession());

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
        <div class="search-result-item" onclick="switchSession('${r.session.id}')">
          <div class="search-result-title">${escapeHtml(r.session.title)}</div>
          ${r.matches.map(m => `
            <div class="search-result-snippet"><span class="search-role">${m.role === 'user' ? uiIcon('user') : m.role === 'title' ? uiIcon('edit') : uiIcon('bot')}</span> ${highlightMatch(m.snippet, q)}</div>
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

// =============================================================================
// Chat Input
// =============================================================================

chatInput.addEventListener('keydown', (e) => {
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
        applySlashSkill(active.dataset.name || '');
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
const MAX_ATTACH_TOTAL_BYTES = 32 * 1024 * 1024; // decoded attachment total
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
    if (file.size > MAX_ATTACH_BYTES) {
      addError(`「${file.name}」超过 8MB，已跳过。`);
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
        <button type="button" class="attach-chip-remove" onclick="removeAttachment('${a.id}')" title="移除">×</button>
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
      ? ('插入对话（已排队 ' + qn + ' 条）')
      : '插入对话（当前任务结束后自动执行）';
    sendBtn.setAttribute('aria-label', '插入对话');
    sendBtn.classList.add('is-queue-mode');
    chatInput.placeholder = '任务进行中，可继续输入，结束后自动执行…';
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
  if (runtime.isProcessing) return;
  if (!(runtime.promptQueue || []).some((p) => p.sessionId === sessionId)) return;

  runtime.isDrainingQueue = true;
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

  addMessage('user', displayText, attachments, { timestamp: Date.now() });

  chatInput.value = '';
  chatInput.style.height = 'auto';
  clearAttachments();

  suppressQueueDrain = false;
  await runChatTurn(message || displayText, displayText, attachments, { fromQueue: false });
}

/**
 * Run one user→assistant chat turn (SSE). Shared by normal send + queue drain.
 */
async function runChatTurn(message, displayText, attachments, opts) {
  opts = opts || {};
  if (isProcessing) return;
  const sessionId = currentSessionId;
  const turnThinkingLevel = currentThinkingLevel;
  const turnToken = ++activeChatTurnToken;
  setProcessing(true);
  snapshotActiveSessionRuntime();
  document.querySelectorAll('.error-message').forEach(function (el) { el.remove(); });

  try {
    const response = await fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message || displayText,
        sessionId: sessionId,
        attachments: (attachments || []).map(function (a) {
          return {
            name: a.name,
            mime: a.mime,
            kind: a.kind,
            dataUrl: a.dataUrl || undefined,
            text: a.text || undefined,
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
      currentAssistantMsg = addMessage('assistant', '');
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
      if (turnToken === activeChatTurnToken && isProcessing) {
        hideWaitingIndicator();
        finishTaskSummary();
        setProcessing(false);
        scheduleQueueDrain();
      }
      snapshotActiveSessionRuntime();
    });
  } catch (err) {
    withSessionRuntime(sessionId, () => {
      if (turnToken !== activeChatTurnToken) return;
      addError(err.message || String(err));
      hideWaitingIndicator();
      finishTaskSummary();
      setProcessing(false);
      scheduleQueueDrain();
      snapshotActiveSessionRuntime();
    });
  }
}
// =============================================================================
// SSE Event Handling
// =============================================================================

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

    switch (eventType) {
      case 'text':
        handleTextDelta(data.content);
        break;
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
      case 'tool_result':
        handleToolResult(data.id, data.output, data.success, data.todos, data.fileChange, data.imageData, data.imageMimeType, data.artifacts);
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
        break;
      case 'error':
        handleError(data.message, turnToken);
        break;
      case 'session_title':
        handleSessionTitle(data.sessionId, data.title, data.category);
        break;
      case 'done':
        handleDone(data.stopReason, turnToken);
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
  window.IexaPermissionDialog.show(data, { apiBase: API_BASE, onError: addError });
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
  const host = msg.querySelector('.tool-steps');
  if (host) {
    // Prefer a content block after tool steps (final answer under tools)
    let el = host.nextElementSibling;
    while (el && !el.classList.contains('message-content')) {
      el = el.nextElementSibling;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'message-content message-answer';
      const usage = msg.querySelector('.message-usage');
      if (usage) msg.insertBefore(el, usage);
      else host.after(el);
    } else {
      el.classList.add('message-answer');
    }
    return el;
  }
  let contentEl = msg.querySelector('.message-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    msg.appendChild(contentEl);
  }
  return contentEl;
}

function handleTextDelta(fullText) {
  hideWaitingIndicator();
  finishActiveThinkingBlock();
  if (!currentAssistantMsg) return;
  const contentEl = ensureAnswerContentEl();
  contentEl.innerHTML = marked.parse(fullText || '');
  normalizeRenderedAssets(contentEl);
  enhanceCodeBlocks(contentEl);
  enhanceTables(contentEl);
  // Hide empty preamble bubbles
  currentAssistantMsg.querySelectorAll('.message-content').forEach((node) => {
    if (node === contentEl) {
      node.style.display = '';
      return;
    }
    if (!(node.textContent || '').trim()) node.style.display = 'none';
  });
  scrollToBottom();
}

function thinkingEffortLabelFor(level) {
  const normalized = normalizeThinkingLevel(level || 'medium');
  return THINKING_LEVELS[normalized]?.label || '标准';
}

function finishThinkingBlock(thinkBlock) {
  if (!thinkBlock || thinkBlock.classList.contains('is-complete')) return;
  // Compatibility cleanup for blocks created before the simplified design.
  const timerId = Number(thinkBlock.dataset.timerId);
  if (timerId) window.clearInterval(timerId);
  delete thinkBlock.dataset.timerId;
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
  finishThinkingBlock(currentAssistantMsg.querySelector('.thinking-block'));
}

function handleThinkingDelta(text) {
  hideWaitingIndicator();
  if (!currentAssistantMsg || !text) return;
  let thinkBlock = currentAssistantMsg.querySelector('.thinking-block');
  if (!thinkBlock) {
    const level = currentAssistantMsg.dataset.thinkingLevel || currentThinkingLevel;
    thinkBlock = document.createElement('details');
    thinkBlock.className = 'thinking-block';
    thinkBlock.open = true;
    thinkBlock.dataset.startedAt = String(Date.now());
    thinkBlock.dataset.reasoning = '';
    thinkBlock.dataset.thinkingLevel = level;
    thinkBlock.innerHTML = `<summary><span class="thinking-spinner" aria-hidden="true"></span>${uiIcon('brain')}<span class="thinking-title">思考</span><span class="thinking-effort">${escapeHtml(thinkingEffortLabelFor(level))}</span><span class="thinking-chevron" aria-hidden="true"></span></summary><pre class="thinking-content"></pre>`;
    const host = currentAssistantMsg.querySelector('.tool-steps');
    const answer = ensureAnswerContentEl();
    if (host) host.before(thinkBlock);
    else if (answer) answer.before(thinkBlock);
    else currentAssistantMsg.appendChild(thinkBlock);
  }
  const total = (thinkBlock.dataset.reasoning || '') + String(text);
  thinkBlock.dataset.reasoning = total;
  const content = thinkBlock.querySelector('.thinking-content');
  if (content) content.textContent = total;
  scrollToBottom();
}

const TOOL_LABELS = {
  todo_write: '更新计划',
  shell_execute: '执行命令',
  file_read: '读取文件',
  file_write: '写入文件',
  file_edit: '编辑文件',
  browser_fetch: '抓取网页',
  memory_write: '写入记忆',
  memory_get: '读取记忆',
};

const TOOL_ICONS = {
  todo_write: 'check',
  shell_execute: 'terminal',
  file_read: 'file',
  file_write: 'edit',
  file_edit: 'edit',
  browser_fetch: 'globe',
  memory_write: 'memory',
  memory_get: 'search',
};

function toolDisplayName(name) {
  return TOOL_LABELS[name] || name;
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
function createTaskSummary(toolCount) {
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'task-summary';
  summary.setAttribute('aria-expanded', 'false');
  summary.innerHTML =
    '<span class="task-summary-spinner" aria-hidden="true"></span>' +
    '<span class="task-summary-label">任务处理中</span>' +
    '<span class="task-summary-time">0 秒</span>' +
    '<span class="task-summary-chevron" aria-hidden="true"></span>';
  summary.title = '点击展开任务详情';
  summary.addEventListener('click', function () {
    const host = summary.closest('.tool-steps');
    if (!host) return;
    const collapsed = host.classList.toggle('is-collapsed');
    summary.setAttribute('aria-expanded', String(!collapsed));
    summary.title = collapsed ? '点击展开任务详情' : '点击收起任务详情';
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
  const timeEl = summary.querySelector('.task-summary-time');
  if (labelEl && label) labelEl.textContent = label;
  if (timeEl) timeEl.textContent = formatTaskElapsed(Date.now() - currentTaskStartedAt);
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
    summary.classList.add('is-complete');
    summary.querySelector('.task-summary-label').textContent = '任务耗时';
    summary.querySelector('.task-summary-time').textContent = formatTaskElapsed(Date.now() - currentTaskStartedAt);
    const spinner = summary.querySelector('.task-summary-spinner');
    if (spinner) spinner.remove();
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
    currentAssistantMsg = addMessage('assistant', '');
  }
  return currentAssistantMsg;
}

function showWaitingIndicator() {
  const msg = ensureAssistantMessage();
  if (msg.querySelector('.waiting-indicator')) return;
  const indicator = document.createElement('div');
  indicator.className = 'waiting-indicator';
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  indicator.innerHTML = '<span class="waiting-indicator__label" data-text="IEXA正在思考...">IEXA正在思考...</span>';
  const usage = msg.querySelector('.message-usage');
  if (usage) msg.insertBefore(indicator, usage);
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
  let host = msg.querySelector('.tool-steps');
  if (!host) {
    host = document.createElement('div');
    host.className = 'tool-steps';
    // Place tools after any preamble text; final answer will go under tools
    const contents = msg.querySelectorAll('.message-content:not(.message-answer)');
    const lastPre = contents.length ? contents[contents.length - 1] : null;
    const usage = msg.querySelector('.message-usage');
    if (lastPre && (lastPre.textContent || '').trim()) {
      lastPre.after(host);
    } else if (lastPre) {
      // Empty placeholder content → tools first, answer slot after
      msg.insertBefore(host, lastPre);
      lastPre.classList.add('message-answer');
    } else if (usage) {
      msg.insertBefore(host, usage);
    } else {
      msg.appendChild(host);
    }
  }
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
  block.classList.toggle('is-error', status === 'error');
}

function toolKind(name) {
  if (name === 'shell_execute' || name.startsWith('terminal_')) return 'terminal';
  if (name === 'file_read' || name === 'file_write' || name === 'file_edit' || name === 'display_file') return 'file';
  if (name.startsWith('mcp_')) return 'mcp';
  if (name === 'browser_fetch') return 'web';
  if (name === 'read_image') return 'vision';
  if (name.startsWith('memory_')) return 'memory';
  return 'agent';
}

function toolMeta(name, args) {
  const source = args && typeof args === 'object' ? args : {};
  if (name === 'shell_execute') return '工作区命令';
  if (name.startsWith('mcp_')) return 'MCP 工具';
  if (name === 'read_image') return '视觉代理';
  if (name === 'browser_fetch') return '网页读取';
  if (source.path) return String(source.path);
  return 'IEXA 工具';
}

function handleToolStart(id, name) {
  hideWaitingIndicator();
  finishActiveThinkingBlock();
  ensureAssistantMessage();
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
    '<div class="tool-header" onclick="toggleToolBody(\'tool-body-' + id + '\')">' +
      '<span class="tool-icon">' + toolIcon(name) + '</span><span class="tool-heading"><span class="tool-name">' + escapeHtml(toolDisplayName(name)) + '</span><span class="tool-meta">' + escapeHtml(toolMeta(name)) + '</span></span>' +
      '<span class="tool-status running">准备中</span>' +
      '<span class="tool-chevron" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="tool-body" id="tool-body-' + id + '" style="display:none;">' +
      '<div class="tool-section-label">输入</div><pre class="tool-args">准备中...</pre>' +
    '</div>';

  // Insert the compact task bar once, above the individual capsules.
  // Capsules remain collapsed until the user taps the task bar.
  let summary = host.querySelector('.task-summary');
  if (!summary) {
    host.classList.add('is-collapsed');
    summary = createTaskSummary(0);
    host.insertBefore(summary, host.firstChild);
  }
  // Keep a direct reference so completion always stops this turn's spinner.
  currentTaskSummary = summary;
  host.appendChild(block);
  currentTaskToolCount += 1;
  beginTaskSummary(toolDisplayName(name));
  currentToolBlocks[id] = { block, name, argsText: '' };
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
  info.argsText = typeof args === 'string' ? args : JSON.stringify(args || {}, null, 2);

  const argsEl = info.block.querySelector('.tool-args');
  if (argsEl) {
    try {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      argsEl.textContent = JSON.stringify(parsed, null, 2);
    } catch {
      argsEl.textContent = String(args || '');
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
      argsEl.textContent = JSON.stringify(args || {}, null, 2);
    } catch {
      argsEl.textContent = String(args || '');
    }
  }
  const metaEl = info.block.querySelector('.tool-meta');
  if (metaEl) metaEl.textContent = toolMeta(name || info.name, args);

  const nameEl = info.block.querySelector('.tool-name');
  if (nameEl) {
    nameEl.textContent = toolLiveTitle(name || info.name, args);
    if (args && args.tool_title) nameEl.dataset.locked = '1';
  }

  setToolStepStatus(info.block, 'running', '执行中');
  updateTaskSummary(toolLiveTitle(name || info.name, args));
  scrollToBottom();
}

function handleToolResult(id, output, success, todos, fileChange, imageData, imageMimeType, artifacts) {
  const info = currentToolBlocks[id];
  if (!info) return;

  setToolStepStatus(info.block, success ? 'done' : 'error');

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
    const truncated = (output || '').length > 5000
      ? output.substring(0, 5000) + '\n\n...（已截断）'
      : (output || '');
    resultPre.textContent = truncated;
    const startedAt = Number(info.block.dataset.startedAt || 0);
    const duration = startedAt ? ((Date.now() - startedAt) / 1000).toFixed(Date.now() - startedAt > 10_000 ? 1 : 2) + 's' : '';
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
      image.addEventListener('click', () => openImagePreview(img.src, '工具生成的图片'));
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

  // A tool result is followed by another provider turn. Show the same
  // lightweight status again only after all visible tool steps are complete.
  const hasActiveTool = Object.values(currentToolBlocks || {}).some((item) => {
    const status = item && item.block && item.block.dataset.status;
    return status === 'running' || status === 'streaming';
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
      button.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(rel)}"><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存图片" aria-label="保存图片" onclick="event.stopPropagation()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a><button type="button" class="tool-artifact-action tool-artifact-copy" title="复制图片" aria-label="复制图片"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg></button></span></span>`;
      button.addEventListener('click', (event) => {
        if (event.target.closest('.tool-artifact-actions')) return;
        openImagePreview(src, rel);
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
      media.innerHTML = `<video controls preload="metadata" playsinline src="${escapeHtml(src)}" aria-label="${escapeHtml(rel)}"></video><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存视频" aria-label="保存视频" onclick="event.stopPropagation()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a></span></span>`;
      media.querySelector('video').addEventListener('dblclick', () => window.open(src, '_blank', 'noopener,noreferrer'));
      card.appendChild(media);
    } else if (artifact.kind === 'audio' || String(artifact.mimeType || '').startsWith('audio/')) {
      const media = document.createElement('div');
      media.className = 'tool-artifact-media tool-artifact-audio';
      media.dataset.artifactKey = src;
      media.innerHTML = `<audio controls preload="metadata" src="${escapeHtml(src)}" aria-label="${escapeHtml(rel)}"></audio><span class="tool-artifact-caption"><span class="tool-artifact-name">${escapeHtml(rel)}</span><span class="tool-artifact-actions"><a class="tool-artifact-action" href="${escapeHtml(src)}" download title="保存音频" aria-label="保存音频" onclick="event.stopPropagation()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14"/></svg></a></span></span>`;
      card.appendChild(media);
    } else {
      const link = document.createElement('a');
      link.className = 'tool-artifact-file';
      link.dataset.artifactKey = src;
      link.href = src;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = rel;
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
    alert('当前系统不支持直接复制图片，请使用保存按钮。');
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
  const unique = files.filter((file, index) => file?.path && files.findIndex((item) => (item?.absolutePath || item?.path) === (file.absolutePath || file.path)) === index);
  let panel = messageEl.querySelector('.turn-deliverables');
  if (!unique.length) { if (panel) panel.remove(); return; }
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'turn-deliverables';
    const usage = messageEl.querySelector('.message-usage');
    if (usage) messageEl.insertBefore(panel, usage); else messageEl.appendChild(panel);
  }
  panel.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'turn-deliverables-heading';
  heading.innerHTML = `${uiIcon('file')}<span>本轮交付</span><b>${unique.length} 个文件</b>`;
  const filesEl = document.createElement('div');
  filesEl.className = 'turn-deliverable-files';
  for (const file of unique) {
    const path = String(file.path || '');
    const absolutePath = typeof file.absolutePath === 'string' ? file.absolutePath : '';
    const chip = document.createElement('div');
    chip.className = 'turn-deliverable-chip';
    chip.title = path;
    chip.innerHTML = `${uiIcon('file')}<span class="turn-deliverable-name">${escapeHtml(path)}</span>`;
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'turn-deliverable-action';
    preview.title = '查看文件';
    preview.setAttribute('aria-label', `查看文件：${path}`);
    preview.innerHTML = uiIcon('search');
    preview.addEventListener('click', () => openDeliverablePreview(path, absolutePath));
    chip.appendChild(preview);
    if (absolutePath && window.iexaDesktop && typeof window.iexaDesktop.revealPath === 'function') {
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'turn-deliverable-action';
      reveal.title = '在资源管理器中显示';
      reveal.setAttribute('aria-label', `在资源管理器中显示：${path}`);
      reveal.innerHTML = uiIcon('folder');
      reveal.addEventListener('click', () => window.iexaDesktop.revealPath(absolutePath));
      chip.appendChild(reveal);
    }
    filesEl.appendChild(chip);
  }
  panel.append(heading, filesEl);
}

async function openDeliverablePreview(path, absolutePath) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
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
  const before = String(change.before || '').split(/\r?\n/);
  const after = String(change.after || '').split(/\r?\n/);
  const oldLines = before.map((line) => `<div class="diff-line diff-removed"><span>-</span>${escapeHtml(line)}</div>`).join('');
  const newLines = after.map((line) => `<div class="diff-line diff-added"><span>+</span>${escapeHtml(line)}</div>`).join('');
  card.innerHTML = `<div class="file-change-header"><button type="button" class="file-change-path" title="打开文件">已编辑 ${escapeHtml(change.path)}</button><b class="diff-add">+${Number(change.added) || 0}</b><b class="diff-del">-${Number(change.removed) || 0}</b><button type="button" class="file-change-review">审查</button></div><div class="file-change-diff" hidden>${oldLines}${newLines}</div>`;
  card.querySelector('.file-change-review').addEventListener('click', (e) => {
    const diff = card.querySelector('.file-change-diff');
    diff.hidden = !diff.hidden;
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
      img.addEventListener('click', () => openImagePreview(img.src, img.alt || '图片'));
      img.style.cursor = 'zoom-in';
    }
  });
}

function renderMessageUsage(usageEl, inputTokens, outputTokens) {
  const input = Number(inputTokens) || 0;
  const output = Number(outputTokens) || 0;
  const messageEl = usageEl.closest('.message.assistant');
  const timestamp = Number(messageEl && messageEl.dataset.timestamp);
  const timeText = formatMessageTimestamp(timestamp);
  const timeMarkup = timeText
    ? `<time class="message-usage-time" datetime="${new Date(timestamp).toISOString()}" title="生成时间：${new Date(timestamp).toLocaleString()}">${timeText}</time>`
    : '';
  usageEl.innerHTML = `
    <svg class="message-usage-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="12" width="3" height="7" rx="1" stroke="currentColor" stroke-width="1.7"/>
      <rect x="10.5" y="8" width="3" height="11" rx="1" stroke="currentColor" stroke-width="1.7"/>
      <rect x="17" y="4" width="3" height="15" rx="1" stroke="currentColor" stroke-width="1.7"/>
    </svg>
    <span>${input.toLocaleString()} <em>入</em></span>
    <i aria-hidden="true"></i>
    <span>${output.toLocaleString()} <em>出</em></span>${timeMarkup}`;
}

function handleUsage(usage) {
  if (currentAssistantMsg) {
    let usageEl = currentAssistantMsg.querySelector('.message-usage');
    if (!usageEl) {
      usageEl = document.createElement('div');
      usageEl.className = 'message-usage';
      currentAssistantMsg.appendChild(usageEl);
    }
    renderMessageUsage(usageEl, usage.inputTokens || 0, usage.outputTokens || 0);
  }
}

function formatContextTokens(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(Math.round(n));
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
  const source = context.estimated ? '估算' : '模型实测';
  let statusText = state === 'compacting' ? '正在自动压缩上下文' :
    state === 'compacted' ? '已自动压缩上下文' :
    state === 'near-limit' ? '接近自动压缩阈值' :
    state === 'exhausted' ? '上下文接近上限' : '上下文用量';
  const detail = `${statusText}：${formatContextTokens(usedTokens)} / ${formatContextTokens(windowTokens)} tokens（${percent}% · ${source}）`;
  contextProgress.title = detail;
  contextProgressTooltip.textContent = detail;
}

let tokenUsageRecords = [];

function formatUsageNumber(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

function formatEstimatedCost(value) {
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : '未配置价格';
}

function renderTokenUsage() {
  const list = document.getElementById('tokenUsageList');
  const updated = document.getElementById('tokenUsageUpdated');
  if (!list) return;
  const records = [...tokenUsageRecords].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
    return `<div class="token-usage-model-card">
      <div class="token-usage-model-head"><div><strong>${escapeHtml(r.model || '未知模型')}</strong><span>${escapeHtml(r.provider || '')}</span></div><b>${formatUsageNumber(total)}</b></div>
      <div class="token-usage-model-stats">
        <div><span>输入</span><strong>${formatUsageNumber(input)}</strong></div>
        <div><span>输出</span><strong>${formatUsageNumber(output)}</strong></div>
        <div><span>调用次数</span><strong>${Number(r.requests || 0).toLocaleString()}</strong></div>
        ${cache ? `<div><span>缓存</span><strong>${formatUsageNumber(cache)}</strong></div>` : ''}
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

function handleUsage(usage) {
  if (currentAssistantMsg) {
    let usageEl = currentAssistantMsg.querySelector('.message-usage');
    if (!usageEl) {
      usageEl = document.createElement('div');
      usageEl.className = 'message-usage';
      currentAssistantMsg.appendChild(usageEl);
    }
    renderMessageUsage(usageEl, usage.inputTokens || 0, usage.outputTokens || 0);
  }
  // The server has already persisted this receipt; reload immediately for live totals.
  loadTokenUsage();
}

function handleError(message, turnToken) {
  if (turnToken != null && turnToken !== activeChatTurnToken) return;
  finishActiveThinkingBlock();
  hideWaitingIndicator();
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
  finishTaskSummary();
  clearContextBusy();
  setProcessing(false);

  // Keep the streamed reasoning as a compact completed record.
  hideWaitingIndicator();
  finishActiveThinkingBlock();

  if (currentAssistantMsg) renderDeliverables(currentAssistantMsg, collectLiveDeliverables());
  currentAssistantMsg = null;
  currentToolBlocks = {};

  // Refresh session list (AI title may have landed)
  loadSessionList().catch(() => {});
  // Refresh project files so tool writes are visible
  if (typeof refreshFilesPanelSoft === 'function') refreshFilesPanelSoft();

  // iOS drainQueuedPrompts: auto-run messages inserted during the previous turn
  scheduleQueueDrain();
}

function handleCancelled(turnToken) {
  if (turnToken != null && turnToken !== activeChatTurnToken) return;
  finishActiveThinkingBlock();
  hideWaitingIndicator();
  finishTaskSummary();
  clearContextBusy();
  setProcessing(false);
  currentAssistantMsg = null;
  currentToolBlocks = {};

  const cancelNote = document.createElement('div');
  cancelNote.className = 'error-message';
  cancelNote.innerHTML = uiIcon('info') + '<span>任务已取消。</span>';
  chatMessages.appendChild(cancelNote);

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
  try {
    const sid = currentSessionId || '';
    await fetch(API_BASE + '/api/cancel?sessionId=' + encodeURIComponent(sid));
  } catch (e) { /* ignore */ }
  finishTaskSummary();
  setProcessing(false);
  // SSE may also emit cancelled; schedule as fallback if stream already dead
  if (!suppressQueueDrain) scheduleQueueDrain();
}

// =============================================================================
// Image attachment preview
// =============================================================================

const imagePreviewOverlay = document.getElementById('imagePreviewOverlay');
const imagePreviewImage = document.getElementById('imagePreviewImage');
const imagePreviewTitle = document.getElementById('imagePreviewTitle');
const imagePreviewClose = document.getElementById('imagePreviewClose');
let imagePreviewLastFocus = null;

function openImagePreview(src, name) {
  if (!imagePreviewOverlay || !imagePreviewImage) return;
  imagePreviewLastFocus = document.activeElement;
  imagePreviewImage.src = src;
  imagePreviewImage.alt = name || '图片附件';
  if (imagePreviewTitle) imagePreviewTitle.textContent = name || '图片预览';
  imagePreviewOverlay.style.display = 'flex';
  document.body.classList.add('image-preview-open');
  if (imagePreviewClose) imagePreviewClose.focus();
}

function closeImagePreview() {
  if (!imagePreviewOverlay || imagePreviewOverlay.style.display === 'none') return;
  imagePreviewOverlay.style.display = 'none';
  if (imagePreviewImage) imagePreviewImage.removeAttribute('src');
  document.body.classList.remove('image-preview-open');
  if (imagePreviewLastFocus && typeof imagePreviewLastFocus.focus === 'function') {
    imagePreviewLastFocus.focus();
  }
  imagePreviewLastFocus = null;
}

if (imagePreviewClose) imagePreviewClose.addEventListener('click', closeImagePreview);
if (imagePreviewOverlay) {
  imagePreviewOverlay.addEventListener('click', function (e) {
    if (e.target === imagePreviewOverlay) closeImagePreview();
  });
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && imagePreviewOverlay && imagePreviewOverlay.style.display !== 'none') {
    closeImagePreview();
  }
});

// =============================================================================
// UI Helpers
// =============================================================================

function addMessage(role, content, attachments, opts) {
  const queued = !!(opts && opts.queued);
  const queueId = (opts && opts.queueId) || '';
  const timestamp = Number(opts && opts.timestamp) > 0 ? Number(opts.timestamp) : Date.now();
  const msg = document.createElement('div');
  msg.className = 'message ' + role + (queued ? ' is-queued' : '');
  if (queueId) msg.dataset.queueId = queueId;
  if (!queued && (role === 'user' || role === 'assistant')) msg.dataset.timestamp = String(timestamp);
  if (role === 'user' && !queued) {
    // Index in the persisted session timeline, used by “重置到此处”.
    const messageIndex = opts && Number.isInteger(opts.messageIndex)
      ? opts.messageIndex
      : chatMessages.querySelectorAll('.message:not(.is-queued)').length;
    msg.dataset.messageIndex = String(messageIndex);
  }

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? '你' : 'IEXA';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  if (role === 'user') {
    contentDiv.textContent = content;
  } else {
    contentDiv.innerHTML = marked.parse(content || '');
    normalizeRenderedAssets(contentDiv);
    enhanceCodeBlocks(contentDiv);
    enhanceTables(contentDiv);
  }

  msg.appendChild(label);

  if (queued) {
    const badge = document.createElement('div');
    badge.className = 'queued-badge';
    badge.innerHTML = '<span class="queued-badge-icon">⤵</span><span class="queued-badge-text">排队中 · 当前任务结束后自动执行</span>';
    if (queueId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'queued-withdraw';
      btn.title = '撤销排队';
      btn.setAttribute('aria-label', '撤销排队');
      btn.textContent = '×';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        withdrawQueuedMessage(queueId);
      });
      badge.appendChild(btn);
    }
    msg.appendChild(badge);
  }

  // Attachments above message text
  if (attachments && attachments.length) {
    const box = document.createElement('div');
    box.className = 'message-attachments';
    for (const a of attachments) {
      const item = document.createElement(a.kind === 'image' && (a.dataUrl || a.previewUrl) ? 'button' : 'div');
      item.className = 'message-attach-item';
      if (a.kind === 'image' && (a.dataUrl || a.previewUrl)) {
        const src = a.dataUrl || a.previewUrl;
        item.type = 'button';
        item.classList.add('message-image-attach');
        item.title = `点击查看「${a.name || '图片附件'}」`;
        item.setAttribute('aria-label', `查看图片：${a.name || '图片附件'}`);
        item.addEventListener('click', function () {
          openImagePreview(src, a.name || '图片附件');
        });
        const img = document.createElement('img');
        img.src = src;
        img.alt = a.name || '图片附件';
        item.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.innerHTML = uiIcon(a.kind === 'text' ? 'file' : 'box');
        item.appendChild(icon);
      }
      const name = document.createElement('span');
      name.className = 'message-attach-name';
      name.textContent = a.name || '附件';
      name.title = a.name || '';
      item.appendChild(name);
      box.appendChild(item);
    }
    msg.appendChild(box);
  }

  msg.appendChild(contentDiv);

  if (role === 'user' && !queued) {
    const actions = document.createElement('div');
    actions.className = 'user-message-actions';
    const timeText = formatMessageTimestamp(timestamp);
    actions.innerHTML = `
      ${timeText ? `<time class="user-message-time" datetime="${new Date(timestamp).toISOString()}" title="发送时间：${new Date(timestamp).toLocaleString()}">${timeText}</time>` : ''}
      <button type="button" class="user-message-action user-message-reset" data-action="reset" title="重置到此处" aria-label="重置到此处" aria-hidden="false">↻</button>
      <button type="button" class="user-message-action" data-action="copy" title="复制消息" aria-label="复制消息">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="8" width="10" height="11" rx="2"/><path d="M15 8V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>
      </button>`;
    actions.querySelector('[data-action="copy"]').addEventListener('click', function () {
      copyUserMessage(content, this);
    });
    actions.querySelector('[data-action="reset"]').addEventListener('click', function () {
      resetConversationToMessage(msg);
    });
    msg.appendChild(actions);
  }

  chatMessages.appendChild(msg);
  scrollToBottom();
  return msg;
}

async function copyUserMessage(content, button) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(content || '');
    } else {
      const area = document.createElement('textarea');
      area.value = content || '';
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    button.classList.add('is-copied');
    button.title = '已复制';
    setTimeout(() => {
      button.classList.remove('is-copied');
      button.title = '复制消息';
    }, 1300);
  } catch (err) {
    console.error('Failed to copy message:', err);
  }
}

async function resetConversationToMessage(messageEl) {
  const messageIndex = Number(messageEl && messageEl.dataset.messageIndex);
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || !currentSessionId) return;
  if (!confirm('重置到此处将移除这条消息之后的对话，是否继续？')) return;

  // A reset is a hard branch point: stop the live request and drop queued prompts.
  suppressQueueDrain = true;
  promptQueue = [];
  if (isProcessing) await stopProcessing();

  try {
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '重置失败');
    await switchSession(currentSessionId);
    scrollToBottom(true);
  } catch (err) {
    addError(err.message || '重置对话失败');
  }
}

function addError(message) {
  const err = document.createElement('div');
  err.className = 'error-message';
  err.innerHTML = uiIcon('alert') + '<span>' + escapeHtml(message) + '</span>';
  chatMessages.appendChild(err);
  scrollToBottom();
}

function isChatNearBottom() {
  return visibleChatMessages.scrollHeight - visibleChatMessages.scrollTop - visibleChatMessages.clientHeight < 72;
}

function updateScrollToBottomButton() {
  if (!scrollToBottomBtn) return;
  if (currentSessionId !== visibleSessionId) return;
  const hasOverflow = visibleChatMessages.scrollHeight > visibleChatMessages.clientHeight + 4;
  scrollToBottomBtn.style.display = (!isNearChatBottom && hasOverflow) ? 'flex' : 'none';
}

/** Keep streaming content visible only while the user is already reading the latest messages. */
function scrollToBottom(force) {
  if (currentSessionId !== visibleSessionId) return;
  if (force || isNearChatBottom) {
    visibleChatMessages.scrollTop = visibleChatMessages.scrollHeight;
    isNearChatBottom = true;
  }
  updateScrollToBottomButton();
}

visibleChatMessages.addEventListener('scroll', function () {
  isNearChatBottom = isChatNearBottom();
  updateScrollToBottomButton();
}, { passive: true });

if (scrollToBottomBtn) {
  scrollToBottomBtn.addEventListener('click', function () {
    scrollToBottom(true);
  });
}

function setProcessing(processing) {
  isProcessing = !!processing;
  const runtime = currentSessionId ? runtimeForSession(currentSessionId) : null;
  if (runtime) runtime.isProcessing = isProcessing;
  // A background task may finish while another conversation is visible. Keep
  // its state, but leave the selected composer's controls untouched.
  if (currentSessionId !== visibleSessionId) return;
  // iOS: input stays editable while processing so user can insert follow-ups.
  // Stop is always available during a run; send becomes "queue" mode.
  stopBtn.style.display = processing ? 'flex' : 'none';
  sendBtn.style.display = 'flex';
  sendBtn.disabled = false;
  chatInput.disabled = false;
  if (typeof attachBtn !== 'undefined' && attachBtn) attachBtn.disabled = false;

  if (processing) {
    statusDot.className = 'status-dot processing';
    const qn = promptQueue.filter((p) => p.sessionId === currentSessionId).length;
    statusText.textContent = qn > 0 ? ('处理中…（已插入 ' + qn + ' 条）') : '处理中...';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = '就绪';
  }
  updateComposerForQueue();
  if (currentSessionId) {
    renderSessionList();
  }
}

function toggleToolBody(id) {
  const body = document.getElementById(id);
  if (body) {
    const open = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    body.closest('.tool-block')?.classList.toggle('is-expanded', open);
  }
}

// =============================================================================
// Model Profiles (multi-model management)
// =============================================================================

const MODEL_PLACEHOLDERS = {
  anthropic: 'claude-sonnet-4-20250514', openai: 'gpt-4o', gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat', openrouter: 'openai/gpt-4o', xai: 'grok-3', custom: 'your-model-id',
};

const BASE_URL_HINTS = {
  anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', gemini: '',
  deepseek: 'https://api.deepseek.com', openrouter: 'https://openrouter.ai/api',
  xai: 'https://api.x.ai', custom: 'https://your-api-endpoint.com/v1',
};

let profilesCache = [];
let activeProfileId = '';

async function fetchProfiles() {
  const resp = await fetch(`${API_BASE}/api/profiles`);
  const data = await resp.json();
  profilesCache = data.profiles || [];
  activeProfileId = data.activeProfileId || '';
  if (data.thinkingLevel) {
    currentThinkingLevel = normalizeThinkingLevel(data.thinkingLevel);
    try { localStorage.setItem('iexa-thinking-level', currentThinkingLevel); } catch (e) {}
    applyThinkingLevelUI(currentThinkingLevel);
  }
  return data;
}

// ---- Thinking Level (iOS-style capsule) ----
let modelSelectorProfiles = [];

function normalizeThinkingLevel(v) {
  const id = String(v || '').toLowerCase();
  return THINKING_LEVELS[id] ? id : 'medium';
}

const THINKING_LEVEL_ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function thinkingMaxLevelForModel(profile) {
  if (profile && THINKING_LEVEL_ORDER.includes(profile.maxThinkingLevel)) return profile.maxThinkingLevel;
  if (!profile || !profile.model) return 'xhigh';
  const model = String(profile.model).toLowerCase().replace(/\./g, '-');
  const provider = String(profile.provider || '').toLowerCase();
  if (/mimo|agnes|seed-|bytedance-seed|doubao/.test(model)) return 'high';
  if (/claude-opus-4/.test(model)) return 'max';
  if (/gpt-5-5/.test(model)) return 'xhigh';
  if (/gpt-5-6/.test(model)) return 'max';
  if (/o[1-9]|gpt-5|deepseek|reason|thinking|\br1\b|qwq|grok/.test(model) || provider === 'deepseek' || provider === 'xai') return 'xhigh';
  return 'off';
}

function applyThinkingLevelUI(level) {
  currentThinkingLevel = normalizeThinkingLevel(level);
  const boundProfileId = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding?.profileId;
  const activeProfile = modelSelectorProfiles.find((profile) => profile.id === boundProfileId)
    || modelSelectorProfiles.find((profile) => profile.id === activeProfileId);
  const maxLevel = thinkingMaxLevelForModel(activeProfile);
  const maxIndex = THINKING_LEVEL_ORDER.indexOf(maxLevel);
  const currentIndex = THINKING_LEVEL_ORDER.indexOf(currentThinkingLevel);
  if (currentIndex > maxIndex) currentThinkingLevel = maxLevel;
  const btn = document.getElementById('thinkingLevelBtn');
  const label = document.getElementById('thinkingLevelLabel');
  const menu = document.getElementById('thinkingLevelMenu');
  if (label) label.textContent = THINKING_LEVELS[currentThinkingLevel].label;
  if (btn) {
    btn.dataset.level = currentThinkingLevel;
    btn.title = '思考档位：' + THINKING_LEVELS[currentThinkingLevel].label;
    btn.disabled = maxLevel === 'off';
  }
  if (menu) {
    menu.querySelectorAll('.thinking-level-option').forEach((el) => {
      const visible = THINKING_LEVEL_ORDER.indexOf(el.dataset.level) <= maxIndex;
      el.hidden = !visible;
      el.classList.toggle('is-active', el.dataset.level === currentThinkingLevel);
      el.setAttribute('aria-selected', String(el.dataset.level === currentThinkingLevel));
    });
  }
}

function setThinkingMenuOpen(open) {
  const btn = document.getElementById('thinkingLevelBtn');
  const menu = document.getElementById('thinkingLevelMenu');
  if (!btn || !menu) return;
  menu.style.display = open ? 'flex' : 'none';
  btn.classList.toggle('is-open', !!open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function setThinkingLevel(level, opts) {
  opts = opts || {};
  const next = normalizeThinkingLevel(level);
  currentThinkingLevel = next;
  try { localStorage.setItem('iexa-thinking-level', next); } catch (e) {}
  applyThinkingLevelUI(next);
  setThinkingMenuOpen(false);
  if (opts.skipSave) return;
  try {
    await fetch(API_BASE + '/api/thinking-level', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: next }),
    });
  } catch (e) {
    console.warn('save thinking level failed', e);
  }
}

function initThinkingLevelControl() {
  const btn = document.getElementById('thinkingLevelBtn');
  const menu = document.getElementById('thinkingLevelMenu');
  const wrap = document.getElementById('thinkingLevelWrap');
  if (!btn || !menu || !wrap) return;

  applyThinkingLevelUI(currentThinkingLevel);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = menu.style.display === 'none' || !menu.style.display;
    setThinkingMenuOpen(open);
  });

  menu.querySelectorAll('.thinking-level-option').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setThinkingLevel(el.dataset.level);
    });
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) setThinkingMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setThinkingMenuOpen(false);
  });
}

// ---- Model Selector (chat bar, same popover pattern as thinking level) ----

function activeSessionProfile() {
  const boundId = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding?.profileId;
  return modelSelectorProfiles.find((profile) => profile.id === boundId)
    || modelSelectorProfiles.find((profile) => profile.id === activeProfileId)
    || null;
}
function syncFastModeUI() {
  const button = document.getElementById('fastModeBtn');
  if (!button) return;
  const session = sessionsCache.find((item) => item.id === currentSessionId);
  const profile = activeSessionProfile();
  const supported = !!profile?.supportsFastMode;
  const enabled = supported && session?.fastModeEnabled === true;
  button.style.display = supported ? 'inline-flex' : 'none';
  button.classList.toggle('is-enabled', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.title = enabled
    ? 'Fast 已开启：请求使用 service_tier: priority'
    : '开启 Codex Fast：请求使用 service_tier: priority';
}
async function toggleFastMode() {
  const session = sessionsCache.find((item) => item.id === currentSessionId);
  const profile = activeSessionProfile();
  if (!session || !profile?.supportsFastMode) return;
  if (isProcessing) { addError('当前会话正在执行任务，请结束或停止后再切换 Fast 模式。'); return; }
  const enabled = session.fastModeEnabled !== true;
  const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/fast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { addError(data.error || '切换 Fast 模式失败。'); return; }
  const index = sessionsCache.findIndex((item) => item.id === currentSessionId);
  if (index >= 0 && data.session) sessionsCache[index] = { ...sessionsCache[index], ...data.session };
  syncFastModeUI();
}

function setModelMenuOpen(open) {
  const btn = document.getElementById('modelSelector');
  const menu = document.getElementById('modelSelectorMenu');
  if (!btn || !menu) return;
  menu.style.display = open ? 'flex' : 'none';
  btn.classList.toggle('is-open', open);
  btn.setAttribute('aria-expanded', String(open));
}

async function selectModelProfile(id) {
  const boundId = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding?.profileId;
  if (!id || id === boundId || !currentSessionId) {
    setModelMenuOpen(false);
    return;
  }
  if (isProcessing) {
    addError('当前会话正在执行任务，请结束或停止后再切换模型。');
    setModelMenuOpen(false);
    return;
  }
  const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/model`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: id }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    addError(data.error || '切换本会话模型失败。');
    return;
  }
  const index = sessionsCache.findIndex((session) => session.id === currentSessionId);
  if (index >= 0 && data.session) sessionsCache[index] = { ...sessionsCache[index], ...data.session };
  setModelMenuOpen(false);
  await refreshModelSelector();
}

async function refreshModelSelector() {
  const btn = document.getElementById('modelSelector');
  const label = document.getElementById('modelSelectorLabel');
  const menu = document.getElementById('modelSelectorMenu');
  const hint = document.getElementById('modelBarHint');
  const data = await fetchProfiles();
  if (!btn || !label || !menu) return;

  modelSelectorProfiles = data.profiles || [];
  menu.innerHTML = '';
  if (!modelSelectorProfiles.length) {
    label.textContent = '— 尚未配置模型 —';
    btn.disabled = true;
    hint.textContent = '请在设置中添加模型';
    return;
  }

  btn.disabled = false;
  const binding = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding;
  const active = modelSelectorProfiles.find((profile) => profile.id === binding?.profileId)
    || modelSelectorProfiles.find((profile) => profile.id === data.activeProfileId)
    || modelSelectorProfiles[0];
  // activeProfileId remains the global default used only for new sessions/settings.
  activeProfileId = data.activeProfileId || active.id;
  label.textContent = active.name || (active.provider + '/' + active.model);
  btn.title = `本会话模型：${active.provider} / ${active.model}`;
  const routeName = active.apiMode === 'responses' ? 'Responses' : 'Chat';
  hint.textContent = `本会话 · ${active.provider} · ${active.model} · ${routeName}`;
  syncFastModeUI();
  applyThinkingLevelUI(currentThinkingLevel);
  document.dispatchEvent(new Event('token-calculator-profile-change'));

  modelSelectorProfiles.forEach((p) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'model-selector-option' + (p.id === active.id ? ' is-active' : '');
    option.dataset.id = p.id;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(p.id === active.id));
    option.innerHTML = `<span class="model-selector-option-main"><span class="model-selector-option-title">${escapeHtml(p.name || (p.provider + '/' + p.model))}</span><span class="model-selector-option-desc">${escapeHtml(p.provider + ' · ' + p.model)}</span></span><span class="model-selector-option-check" aria-hidden="true"></span>`;
    option.addEventListener('click', () => selectModelProfile(p.id));
    menu.appendChild(option);
  });
}

function initModelSelectorControl() {
  const btn = document.getElementById('modelSelector');
  const wrap = document.getElementById('modelSelectorWrap');
  if (!btn || !wrap) return;
  btn.addEventListener('click', () => setModelMenuOpen(btn.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) setModelMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setModelMenuOpen(false);
  });
}

initModelSelectorControl();
const fastModeBtn = document.getElementById('fastModeBtn');
if (fastModeBtn) fastModeBtn.addEventListener('click', () => toggleFastMode().catch((error) => addError(error?.message || String(error))));
initThinkingLevelControl();

// ---- Profile List (settings) ----
async function loadVisionProfileSetting() {
  const select = document.getElementById('visionProfileSelect');
  if (!select) return;
  try {
    const response = await fetch(`${API_BASE}/api/vision-profile`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取视觉配置失败');
    select.innerHTML = '<option value="">不使用视觉代理</option>' + (data.profiles || []).map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.model)}</option>`).join('');
    select.value = data.visionProfileId || '';
  } catch (error) { console.error('Failed to load vision profile:', error); }
}

async function saveVisionProfileSetting() {
  const select = document.getElementById('visionProfileSelect');
  if (!select) return;
  try {
    const response = await fetch(`${API_BASE}/api/vision-profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visionProfileId: select.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存视觉配置失败');
  } catch (error) { addError('保存视觉配置失败：' + (error.message || error)); }
}

async function loadSettings() {
  await Promise.all([renderProfileList(), loadVisionProfileSetting()]);
}

document.getElementById('visionProfileSelect')?.addEventListener('change', saveVisionProfileSetting);

async function renderProfileList() {
  const list = document.getElementById('profileList');
  const data = await fetchProfiles();

  if (data.profiles.length === 0) {
    list.innerHTML = '<div class="profile-empty">尚未配置模型。点击"＋ 添加模型"开始。</div>';
    return;
  }

  list.innerHTML = data.profiles.map(p => `
    <div class="profile-card ${p.id === data.activeProfileId ? 'active' : ''}" onclick="activateProfile('${p.id}')">
      <div class="profile-card-radio"></div>
      <div class="profile-card-info">
        <div class="profile-card-name">${escapeHtml(p.name)}</div>
        <div class="profile-card-detail">${escapeHtml(p.provider)} / ${escapeHtml(p.model)}</div>
        ${p.baseURL ? `<div class="profile-card-detail">${escapeHtml(p.baseURL)}</div>` : ''}
      </div>
      <span class="profile-card-badge">${escapeHtml(p.provider)}</span>
      <div class="profile-card-actions" onclick="event.stopPropagation()">
        <button onclick="editProfile('${p.id}')" title="编辑" aria-label="编辑">${uiIcon('edit')}</button>
        <button class="danger" onclick="deleteProfile('${p.id}')" title="删除" aria-label="删除">${uiIcon('trash')}</button>
      </div>
    </div>
  `).join('');
}

async function activateProfile(id) {
  await fetch(`${API_BASE}/api/profiles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeProfileId: id }),
  });
  activeProfileId = id;
  renderProfileList();
  loadVisionProfileSetting();
  refreshModelSelector();
}

async function deleteProfile(id) {
  if (!confirm('确定删除这个模型配置？')) return;
  await fetch(`${API_BASE}/api/profiles/${id}`, { method: 'DELETE' });
  renderProfileList();
  loadVisionProfileSetting();
  refreshModelSelector();
}

// ---- Profile Editor ----
function showProfileEditor(profile) {
  const overlay = document.getElementById('profileEditorOverlay');
  document.getElementById('profileEditorTitle').textContent = profile ? '编辑模型' : '添加模型';
  document.getElementById('profileEditorId').value = profile ? profile.id : '';
  document.getElementById('profileEditorName').value = profile ? profile.name : '';
  document.getElementById('profileEditorProvider').value = profile ? profile.provider : 'anthropic';
  document.getElementById('profileEditorModel').value = profile ? profile.model : '';
  document.getElementById('profileEditorApiKey').value = '';
  document.getElementById('profileEditorApiKey').placeholder = profile ? '已保存，留空即可继续使用' : 'sk-...';
  document.getElementById('profileEditorBaseURL').value = profile ? (profile.baseURL || '') : '';
  document.getElementById('profileEditorFastMode').checked = !!(profile && profile.fastModeSupported);
  document.getElementById('profileEditorApiMode').value = profile?.apiMode === 'responses' ? 'responses' : 'chat_completions';
  document.getElementById('profileEditorModelSelect').style.display = 'none';
  document.getElementById('profileEditorModelSelect').innerHTML = '';
  document.getElementById('fetchModelsHint').textContent = '';
  overlay.style.display = 'flex';
  updateEditorPlaceholders();
}

function hideProfileEditor() {
  document.getElementById('profileEditorOverlay').style.display = 'none';
}

function editProfile(id) {
  const p = profilesCache.find(p => p.id === id);
  if (p) showProfileEditor(p);
}

// Provider change → update model placeholder
document.getElementById('profileEditorProvider').addEventListener('change', updateEditorPlaceholders);
function updateEditorPlaceholders() {
  const prov = document.getElementById('profileEditorProvider').value;
  const m = document.getElementById('profileEditorModel');
  const b = document.getElementById('profileEditorBaseURL');
  if (!m.value) m.placeholder = MODEL_PLACEHOLDERS[prov] || '';
  b.placeholder = BASE_URL_HINTS[prov] || '';
}

function formatContextTokensForDisplay(tokens) {
  if (!tokens || tokens < 1000) return String(tokens);
  return (tokens / 1000).toFixed(tokens >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
}

function formatContextTokensForDisplay(tokens) {
  if (!tokens || tokens < 1000) return String(tokens);
  return (tokens / 1000).toFixed(tokens >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
}

async function fetchModels() {
  let baseURL = document.getElementById('profileEditorBaseURL').value.trim();
  const apiKey = document.getElementById('profileEditorApiKey').value.trim();
  const profileId = document.getElementById('profileEditorId').value;
  const btn = document.getElementById('fetchModelsBtn');
  const hint = document.getElementById('fetchModelsHint');
  const select = document.getElementById('profileEditorModelSelect');

  if (!baseURL) {
    const prov = document.getElementById('profileEditorProvider').value;
    baseURL = BASE_URL_HINTS[prov] || '';
  }
  if (!baseURL) {
    hint.textContent = '请先填写接口地址。';
    return;
  }
  if (!apiKey && !profileId) {
    hint.textContent = '请先填写 API 密钥。';
    return;
  }

  hint.textContent = '⏳ 正在获取模型列表...';
  btn.disabled = true;
  select.style.display = 'none';
  select.innerHTML = '';
  try {
    const resp = await fetch(`${API_BASE}/api/profiles/fetch-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, apiKey, profileId }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      hint.textContent = data.error || '获取失败';
      return;
    }
    // Models can be strings or objects { id, contextWindow?, maxOutputTokens? }
    const modelList = data.models.map(m => {
      if (typeof m === 'string') return { id: m };
      return { id: m.id, contextWindow: m.contextWindow };
    });
    select.innerHTML = '<option value="">— 选择模型 —</option>' +
      modelList.map(m => {
        const label = m.contextWindow ? m.id + '  (' + formatContextTokensForDisplay(m.contextWindow) + ')' : m.id;
        const contextWindow = m.contextWindow || '';
        return `<option value="${escapeHtml(m.id)}" data-context-window="${escapeHtml(String(contextWindow))}">${escapeHtml(label)}</option>`;
      }).join('');
    select.style.display = 'block';
    hint.textContent = `找到 ${modelList.length} 个模型，请选择。`;
  } catch (err) {
    hint.textContent = '获取失败：' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function saveProfile() {
  const id = document.getElementById('profileEditorId').value;
  // The ID stays in value; metadata is kept separately to avoid invalid HTML characters.
  const modelSelect = document.getElementById('profileEditorModelSelect');
  let profileModel = document.getElementById('profileEditorModel').value.trim();
  let contextWindow = undefined;
  if (modelSelect && modelSelect.value && profileModel === modelSelect.value) {
    const selectedOption = modelSelect.selectedOptions[0];
    const cw = Number(selectedOption?.dataset.contextWindow);
    if (Number.isFinite(cw) && cw > 0) contextWindow = cw;
  }
  const profile = {
    id: id || undefined,
    name: document.getElementById('profileEditorName').value.trim(),
    provider: document.getElementById('profileEditorProvider').value,
    model: profileModel,
    apiKey: document.getElementById('profileEditorApiKey').value.trim(),
    baseURL: document.getElementById('profileEditorBaseURL').value.trim(),
    contextWindow: contextWindow,
    fastModeSupported: !!document.getElementById('profileEditorFastMode').checked,
    apiMode: document.getElementById('profileEditorApiMode').value === 'responses' ? 'responses' : 'chat_completions',
  };

  if (!profile.name) profile.name = profile.model || '未命名';
  if (!profile.model) { alert('请输入模型 ID。'); return; }

  await fetch(`${API_BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });

  hideProfileEditor();
  renderProfileList();
  loadVisionProfileSetting();
  refreshModelSelector();
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

async function loadWebDAVConfig() {
  try {
    const resp = await fetch(`${API_BASE}/api/webdav/config`);
    const cfg = await resp.json();
    document.getElementById('webdavUrl').value = cfg.url || '';
    document.getElementById('webdavUser').value = cfg.username || '';
    document.getElementById('webdavPass').value = cfg.password || '';
    document.getElementById('webdavAutoSync').checked = cfg.autoSync || false;
    updateSyncStatus(cfg);
    loadSyncConflicts();
  } catch (err) {
    console.error('Failed to load WebDAV config:', err);
  }
}

async function saveWebDAVConfig() {
  const cfg = {
    url: document.getElementById('webdavUrl').value.trim(),
    username: document.getElementById('webdavUser').value.trim(),
    password: document.getElementById('webdavPass').value,
    autoSync: document.getElementById('webdavAutoSync').checked,
    enabled: true,
  };

  try {
    const resp = await fetch(`${API_BASE}/api/webdav/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await resp.json();
    showSyncResult(data.ok ? 'success' : 'error', data.ok ? '配置已保存。' : '保存失败。');
    loadWebDAVConfig();
  } catch (err) {
    showSyncResult('error', '保存失败：' + err.message);
  }
}

async function testWebDAV() {
  const url = document.getElementById('webdavUrl').value.trim();
  const username = document.getElementById('webdavUser').value.trim();
  const password = document.getElementById('webdavPass').value;

  if (!url) {
    showSyncResult('error', '请输入 WebDAV 服务器地址。');
    return;
  }

  showSyncResult('info', '正在测试连接...');

  try {
    const resp = await fetch(`${API_BASE}/api/webdav/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, username, password }),
    });
    const data = await resp.json();
    if (data.ok) {
      showSyncResult('success', '连接成功！WebDAV 服务器可达。');
    } else {
      showSyncResult('error', '连接失败：' + (data.error || '未知错误'));
    }
  } catch (err) {
    showSyncResult('error', '连接失败：' + err.message);
  }
}

async function syncNow() {
  const btn = document.getElementById('syncNowBtn');
  btn.disabled = true;
  btn.classList.add('is-loading');
  const syncLabel = btn.querySelector('span');
  if (syncLabel) syncLabel.textContent = '同步中...';
  showSyncResult('info', '正在同步...');

  try {
    const resp = await fetch(`${API_BASE}/api/webdav/sync`, { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      const conflictNote = conflicts.length
        ? `检测到 ${conflicts.length} 个双端修改冲突，远端副本已保留到 .iexa-sync-conflicts。`
        : '';
      showSyncResult(conflicts.length ? 'info' : 'success', `同步完成！上传 ${data.uploaded}，下载 ${data.downloaded} 个文件。${conflictNote}`);
      loadSyncConflicts();
    } else {
      showSyncResult('error', '同步失败：' + (data.error || '未知错误'));
    }
  } catch (err) {
    showSyncResult('error', '同步失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    const syncLabel = btn.querySelector('span');
    if (syncLabel) syncLabel.textContent = '立即同步';
    loadWebDAVConfig();
  }
}

function updateSyncStatus(cfg) {
  const icon = document.getElementById('syncStatusIcon');
  const text = document.getElementById('syncStatusText');
  const lastTime = document.getElementById('syncLastTime');

  if (!cfg.url) {
    icon.className = 'sync-status-icon is-idle';
    icon.innerHTML = uiIcon('info');
    text.textContent = '未配置';
    lastTime.textContent = '';
  } else if (cfg.lastSync && cfg.lastSync > 0) {
    icon.className = 'sync-status-icon is-success';
    icon.innerHTML = uiIcon('check');
    text.textContent = '已同步';
    const d = new Date(cfg.lastSync);
    lastTime.textContent = '上次：' + d.toLocaleString();
  } else {
    icon.className = 'sync-status-icon is-pending';
    icon.innerHTML = uiIcon('alert');
    text.textContent = '已配置，尚未同步';
    lastTime.textContent = '';
  }
}

function showSyncResult(type, message) {
  const el = document.getElementById('syncResult');
  el.style.display = 'block';
  el.className = 'sync-result sync-' + type;
  el.textContent = message;
}

async function loadSyncConflicts() {
  const host = document.getElementById('syncConflicts');
  if (!host) return;
  try {
    const response = await fetch(`${API_BASE}/api/webdav/conflicts`);
    const data = await response.json();
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    host.style.display = conflicts.length ? 'block' : 'none';
    host.innerHTML = conflicts.map((conflict) => `<section class="sync-conflict" data-conflict-id="${escapeHtml(conflict.id)}">
      <div><strong>${escapeHtml(conflict.key)}</strong><small>检测于 ${new Date(conflict.createdAt).toLocaleString()}</small></div>
      <div class="sync-conflict-actions">
        <button type="button" data-sync-resolution="local" title="保留本地版本并覆盖远端">保留本地</button>
        <button type="button" data-sync-resolution="remote" title="用已保存的远端副本覆盖本地">采用远端</button>
        <button type="button" data-sync-resolution="merge" title="编辑合并后的内容">合并</button>
      </div>
      <div class="sync-conflict-editor" hidden></div>
    </section>`).join('');
    host.querySelectorAll('[data-sync-resolution]').forEach((button) => button.addEventListener('click', () => handleSyncConflictAction(button)));
  } catch (error) {
    host.style.display = 'none';
  }
}

async function handleSyncConflictAction(button) {
  const section = button.closest('.sync-conflict');
  const id = section?.dataset.conflictId;
  const resolution = button.dataset.syncResolution;
  if (!id || !resolution) return;
  if (resolution === 'merge') {
    const editor = section.querySelector('.sync-conflict-editor');
    if (!editor) return;
    if (!editor.hidden) { editor.hidden = true; return; }
    try {
      const response = await fetch(`${API_BASE}/api/webdav/conflicts/${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok || !data.mergeable) { showSyncResult('info', '此冲突包含敏感配置或内容过大，请选择保留本地或采用远端。'); return; }
      editor.hidden = false;
      editor.innerHTML = `<label>合并后的完整 JSON</label><textarea spellcheck="false">${escapeHtml(data.localContent || '')}</textarea><div><button type="button" class="btn-primary">保存合并结果</button></div>`;
      editor.querySelector('button').addEventListener('click', () => resolveSyncConflict(id, 'merge', editor.querySelector('textarea').value));
    } catch (error) { showSyncResult('error', `读取冲突失败：${error.message}`); }
    return;
  }
  resolveSyncConflict(id, resolution);
}

async function resolveSyncConflict(id, resolution, content) {
  try {
    const response = await fetch(`${API_BASE}/api/webdav/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution, content }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '处理失败');
    showSyncResult('success', resolution === 'local' ? '已保留本地版本并更新远端。' : resolution === 'remote' ? '已采用远端版本。' : '已保存合并版本。');
    loadSyncConflicts();
  } catch (error) { showSyncResult('error', `冲突处理失败：${error.message}`); }
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
  const mode = getThemeMode();
  document.querySelectorAll('#themeSeg [data-theme-set]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeSet === mode);
  });
  renderAccentDots();
}

function initTheme() {
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

// =============================================================================
// Project files panel (OpenCode-style: empty until a project is opened)
// =============================================================================

let projectRoot = null;
let projectName = null;
let projectRecent = [];
let filesCurrentPath = '.';
let filesSelectedPath = '';
let filesPollTimer = null;
let filesLastSig = '';
let workbenchView = 'files';
let workspaceSearchTimer = null;
let workspaceSearchEpoch = 0;
let terminalSessions = [];
let activeTerminalId = '';
let terminalLastSeq = 0;
let terminalPollTimer = null;

function formatFileSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function switchWorkbenchView(view) {
  if (!['files', 'git', 'search', 'terminal'].includes(view)) return;
  workbenchView = view;
  const filesList = document.getElementById('filesList');
  const filesPreview = document.getElementById('filesPreview');
  const gitPanel = document.getElementById('gitPanel');
  const searchPanel = document.getElementById('searchPanel');
  const terminalPanel = document.getElementById('terminalPanel');
  if (filesList) filesList.style.display = view === 'files' ? '' : 'none';
  if (filesPreview) filesPreview.style.display = view === 'files' && filesPreview.dataset.open === 'true' ? 'flex' : 'none';
  if (gitPanel) gitPanel.style.display = view === 'git' ? 'block' : 'none';
  if (searchPanel) searchPanel.style.display = view === 'search' ? 'flex' : 'none';
  if (terminalPanel) terminalPanel.style.display = view === 'terminal' ? 'flex' : 'none';
  document.querySelectorAll('.workbench-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.workbenchView === view);
  });
  if (view === 'git') loadGitWorkbench();
  if (view === 'search') document.getElementById('workspaceSearchInput')?.focus();
  if (view === 'terminal') loadTerminalSessions();
}

function renderGitStatus(data) {
  const panel = document.getElementById('gitPanel');
  if (!panel) return;
  if (!projectRoot) {
    panel.innerHTML = '<div class="workbench-empty">打开项目后可查看 Git 更改。</div>';
    return;
  }
  if (!data.available || data.error) {
    panel.innerHTML = `<div class="workbench-empty">${escapeHtml(data.error || '无法读取 Git 状态。')}</div>`;
    return;
  }
  if (!data.repository) {
    panel.innerHTML = '<div class="workbench-empty">当前项目不是 Git 仓库。</div>';
    return;
  }
  const files = data.files || [];
  const branches = data.branches || [];
  const commits = data.commits || [];
  const counts = [];
  if (Number.isFinite(data.ahead) && data.ahead) counts.push(`↑${data.ahead}`);
  if (Number.isFinite(data.behind) && data.behind) counts.push(`↓${data.behind}`);
  const fileHtml = files.length ? files.map((file) => {
    const staged = file.index && file.index !== ' ';
    const working = file.workTree && file.workTree !== ' ';
    const label = `${staged ? file.index : ' '}${working ? file.workTree : ' '}`.trim() || '??';
    const action = `${staged
      ? '<button type="button" class="git-file-action" data-git-action="unstage">取消暂存</button>'
      : '<button type="button" class="git-file-action" data-git-action="stage">暂存</button>'}${working ? '<button type="button" class="git-file-action git-file-restore" data-git-action="restore">回滚</button>' : ''}`;
    return `<div class="git-file" data-path="${escapeHtml(file.path)}" data-staged="${staged && !working ? '1' : '0'}">
      <span class="git-file-status${staged ? ' is-staged' : ''}">${escapeHtml(label)}</span>
      <span class="git-file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span>
      ${action}
    </div>`;
  }).join('') : '<div class="workbench-empty">工作区干净，没有待提交的更改。</div>';
  const branchOptions = branches.map((branch) => `<option value="${escapeHtml(branch.name)}"${branch.current ? ' selected' : ''}>${escapeHtml(branch.name)}</option>`).join('');
  const commitHtml = commits.length ? commits.map((commit) => `<div class="git-log-entry" title="${escapeHtml(`${commit.hash}\n${commit.author}\n${commit.committedAt}`)}"><code>${escapeHtml(commit.shortHash)}</code><span>${escapeHtml(commit.subject)}</span></div>`).join('') : '<div class="git-log-empty">暂无提交记录</div>';
  panel.innerHTML = `
    <div class="git-overview">
      <span class="git-branch" title="${escapeHtml(data.branch || '')}">⌥ ${escapeHtml(data.branch || '(detached HEAD)')}</span>
      <span class="git-counts">${escapeHtml(counts.join(' ') || (files.length ? `${files.length} 项更改` : '已同步'))}</span>
    </div>
    <div class="git-toolbar">
      <select id="gitBranchSelect" aria-label="切换 Git 分支">${branchOptions || `<option>${escapeHtml(data.branch || '(detached HEAD)')}</option>`}</select>
      <button type="button" data-git-operation="create-branch" title="新建分支">＋</button>
      <button type="button" data-git-operation="pull" title="拉取（仅 fast-forward）">↓</button>
      <button type="button" data-git-operation="push" title="推送当前分支">↑</button>
    </div>
    ${files.length ? `<div class="git-section-label">更改 (${files.length})</div>${fileHtml}` : fileHtml}
    ${files.length ? `<div class="git-commit-box"><button type="button" class="git-stage-all" data-git-operation="stage-all">暂存全部</button><textarea id="gitCommitMessage" rows="2" placeholder="提交信息"></textarea><button type="button" class="git-commit-submit" data-git-operation="commit">提交</button></div>` : ''}
    <div class="git-section-label">最近提交</div>
    <div class="git-log">${commitHtml}</div>
    <div id="gitDiffHost"></div>
  `;
  panel.querySelectorAll('.git-file').forEach((row) => {
    row.addEventListener('click', (event) => {
      const action = event.target.closest('[data-git-action]');
      const target = row.dataset.path;
      if (!target) return;
      if (action) {
        event.stopPropagation();
        if (action.dataset.gitAction === 'restore' && !confirm(`确定回滚「${target}」的未暂存修改吗？`)) return;
        runGitMutation(action.dataset.gitAction, target);
      } else {
        openGitDiff(target, row.dataset.staged === '1');
      }
    });
  });
  panel.querySelector('#gitBranchSelect')?.addEventListener('change', (event) => {
    runGitOperation('switch', { branch: event.target.value });
  });
  panel.querySelectorAll('[data-git-operation]').forEach((button) => {
    button.addEventListener('click', () => {
      const operation = button.dataset.gitOperation;
      if (operation === 'create-branch') {
        const branch = window.prompt('输入新分支名称：');
        if (branch && branch.trim()) runGitOperation(operation, { branch: branch.trim() });
        return;
      }
      if (operation === 'commit') {
        const message = panel.querySelector('#gitCommitMessage')?.value || '';
        runGitOperation(operation, { message });
        return;
      }
      runGitOperation(operation, {});
    });
  });
}

async function loadGitWorkbench() {
  if (workbenchView !== 'git') return;
  const panel = document.getElementById('gitPanel');
  if (!panel) return;
  if (!projectRoot) { renderGitStatus({}); return; }
  panel.innerHTML = '<div class="workbench-empty">正在读取 Git 状态…</div>';
  try {
    const response = await fetch(`${API_BASE}/api/git/status`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取 Git 状态失败');
    if (data.repository) {
      const [branchesResponse, logResponse] = await Promise.all([
        fetch(`${API_BASE}/api/git/branches`),
        fetch(`${API_BASE}/api/git/log?limit=12`),
      ]);
      const branchesData = await branchesResponse.json();
      const logData = await logResponse.json();
      if (branchesResponse.ok) data.branches = branchesData.branches || [];
      if (logResponse.ok) data.commits = logData.entries || [];
    }
    renderGitStatus(data);
  } catch (error) {
    panel.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  }
}

async function runGitOperation(operation, body) {
  if (!operation) return;
  try {
    const response = await fetch(`${API_BASE}/api/git/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Git 操作失败');
    await loadGitWorkbench();
  } catch (error) {
    addError('Git 操作失败：' + (error.message || error));
  }
}

async function runGitMutation(action, target) {
  try {
    const response = await fetch(`${API_BASE}/api/git/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [target] }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Git 操作失败');
    renderGitStatus(data);
  } catch (error) {
    addError('Git 操作失败：' + (error.message || error));
  }
}

async function openGitDiff(target, staged) {
  const host = document.getElementById('gitDiffHost');
  if (!host) return;
  host.innerHTML = '<div class="workbench-empty">正在加载 Diff…</div>';
  try {
    const response = await fetch(`${API_BASE}/api/git/diff?path=${encodeURIComponent(target)}&staged=${staged ? '1' : '0'}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取 Diff 失败');
    const title = `${data.staged ? '已暂存' : '未暂存'} · ${data.path || target}`;
    host.innerHTML = `<div class="git-diff-head"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><button type="button" class="git-diff-close" aria-label="关闭 Diff">×</button></div><pre class="git-diff"></pre>`;
    const diff = host.querySelector('.git-diff');
    if (diff) diff.textContent = data.content || '没有可显示的差异。';
    if (data.truncated && diff) diff.textContent += '\n\n… Diff 已截断（最大 512 KB）';
    host.querySelector('.git-diff-close')?.addEventListener('click', () => { host.innerHTML = ''; });
  } catch (error) {
    host.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  }
}

function renderTerminalTabs() {
  const tabs = document.getElementById('terminalTabs');
  const stop = document.getElementById('terminalStopBtn');
  if (!tabs) return;
  tabs.innerHTML = terminalSessions.length ? terminalSessions.map((session) => {
    const active = session.id === activeTerminalId;
    const state = session.running ? '●' : '○';
    return `<button type="button" class="terminal-tab${active ? ' active' : ''}${session.running ? '' : ' ended'}" data-terminal-id="${escapeHtml(session.id)}" title="${escapeHtml(session.cwd)}">${state} ${escapeHtml(session.shell)}</button>`;
  }).join('') : '<span class="terminal-tabs-empty">没有运行中的终端</span>';
  tabs.querySelectorAll('[data-terminal-id]').forEach((button) => {
    button.addEventListener('click', () => selectTerminalSession(button.dataset.terminalId));
  });
  const active = terminalSessions.find((session) => session.id === activeTerminalId);
  if (stop) stop.disabled = !active || !active.running;
}

function selectTerminalSession(id) {
  if (!terminalSessions.some((session) => session.id === id)) return;
  activeTerminalId = id;
  terminalLastSeq = 0;
  const output = document.getElementById('terminalOutput');
  if (output) output.textContent = '';
  renderTerminalTabs();
  pollTerminalOutput();
}

function appendTerminalOutput(text) {
  const output = document.getElementById('terminalOutput');
  if (!output || !text) return;
  const next = output.textContent + text;
  output.textContent = next.length > 1_000_000 ? `…（早期终端输出已截断）\n${next.slice(-1_000_000)}` : next;
  output.scrollTop = output.scrollHeight;
}

function resizeActiveTerminal() {
  const output = document.getElementById('terminalOutput');
  if (!activeTerminalId || !output || output.clientWidth < 1 || output.clientHeight < 1) return;
  const cols = Math.max(20, Math.floor((output.clientWidth - 22) / 8));
  const rows = Math.max(5, Math.floor((output.clientHeight - 22) / 18));
  fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/resize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols, rows }),
  }).catch(() => {});
}

async function loadTerminalSessions() {
  if (workbenchView !== 'terminal') return;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取终端失败');
    terminalSessions = data.sessions || [];
    if (!activeTerminalId || !terminalSessions.some((session) => session.id === activeTerminalId)) {
      activeTerminalId = terminalSessions.find((session) => session.running)?.id || terminalSessions[0]?.id || '';
      terminalLastSeq = 0;
      const output = document.getElementById('terminalOutput');
      if (output) output.textContent = activeTerminalId ? '' : '打开项目后可新建终端。';
    }
    renderTerminalTabs();
    if (activeTerminalId) { resizeActiveTerminal(); pollTerminalOutput(); }
  } catch (error) {
    const output = document.getElementById('terminalOutput');
    if (output) output.textContent = '终端不可用：' + (error.message || error);
  }
}

async function createTerminalSession() {
  const shell = document.getElementById('terminalShell')?.value || 'powershell';
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shell }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建终端失败');
    activeTerminalId = data.session.id;
    terminalLastSeq = 0;
    const output = document.getElementById('terminalOutput');
    if (output) output.textContent = `[${data.session.shell} · ${data.session.cwd}]\n`;
    await loadTerminalSessions();
  } catch (error) {
    addError('创建终端失败：' + (error.message || error));
  }
}

async function pollTerminalOutput() {
  if (workbenchView !== 'terminal' || !activeTerminalId) return;
  const id = activeTerminalId;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(id)}?after=${terminalLastSeq}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取终端输出失败');
    if (id !== activeTerminalId) return;
    (data.chunks || []).forEach((chunk) => appendTerminalOutput(chunk.text));
    terminalLastSeq = Math.max(terminalLastSeq, Number(data.lastSeq) || 0);
    const known = terminalSessions.find((session) => session.id === id);
    if (known && known.running !== data.running) loadTerminalSessions();
  } catch (error) {
    appendTerminalOutput(`\n[终端连接错误：${error.message || error}]\n`);
  }
}

async function executeTerminalCommand() {
  const input = document.getElementById('terminalCommand');
  const command = input?.value || '';
  if (!activeTerminalId || !command.trim()) return;
  try {
    appendTerminalOutput(`\n$ ${command}\n`);
    if (input) input.value = '';
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '终端命令执行失败');
    setTimeout(pollTerminalOutput, 80);
  } catch (error) {
    appendTerminalOutput(`[命令失败：${error.message || error}]\n`);
  }
}

async function terminateTerminalSession() {
  if (!activeTerminalId) return;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/terminate`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '终止终端失败');
    setTimeout(loadTerminalSessions, 120);
  } catch (error) {
    addError('终止终端失败：' + (error.message || error));
  }
}

async function interruptTerminalSession() {
  if (!activeTerminalId) return;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '\u0003' }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '发送 Ctrl+C 失败');
    appendTerminalOutput('^C\n');
  } catch (error) {
    addError('终端中断失败：' + (error.message || error));
  }
}

function initTerminalPanel() {
  document.getElementById('terminalNewBtn')?.addEventListener('click', createTerminalSession);
  document.getElementById('terminalRunBtn')?.addEventListener('click', executeTerminalCommand);
  document.getElementById('terminalInterruptBtn')?.addEventListener('click', interruptTerminalSession);
  document.getElementById('terminalStopBtn')?.addEventListener('click', terminateTerminalSession);
  document.getElementById('terminalCommand')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); executeTerminalCommand(); }
  });
  if (terminalPollTimer) clearInterval(terminalPollTimer);
  terminalPollTimer = setInterval(() => pollTerminalOutput(), 350);
  const output = document.getElementById('terminalOutput');
  if (output && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resizeActiveTerminal()).observe(output);
}

function setMcpOutput(value) {
  const output = document.getElementById('mcpOutput');
  if (output) output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function renderMcpServers(servers) {
  const list = document.getElementById('mcpServerList');
  if (!list) return;
  if (!servers.length) {
    list.innerHTML = '<div class="workbench-empty">还没有配置 MCP Server。</div>';
    return;
  }
  list.innerHTML = servers.map((server) => {
    const tools = (server.tools || []).map((tool) => `<button type="button" class="mcp-tool" data-mcp-call="${escapeHtml(tool.name)}" title="${escapeHtml(tool.description || tool.name)}">${escapeHtml(tool.name)}</button>`).join('');
    const resources = (server.resources || []).map((resource) => `<button type="button" class="mcp-tool" data-mcp-resource="${escapeHtml(resource.uri)}" title="${escapeHtml(resource.uri)}">${escapeHtml(resource.name || resource.uri)}</button>`).join('');
    const logs = (server.logs || []).join('\n');
    return `<article class="mcp-server-card" data-mcp-server="${escapeHtml(server.id)}">
      <div class="mcp-server-head"><strong>${escapeHtml(server.name)}</strong><span class="mcp-state ${escapeHtml(server.status)}">${escapeHtml(server.status)}</span></div>
      <div class="mcp-server-meta">${escapeHtml(server.transport === 'http' ? server.url : `${server.command || ''} ${(server.args || []).join(' ')}`)}</div>
      ${server.error ? `<div class="mcp-server-error">${escapeHtml(server.error)}</div>` : ''}
      <div class="mcp-server-actions">
        <button type="button" data-mcp-action="connect">连接</button>
        <button type="button" data-mcp-action="disconnect">断开</button>
        <button type="button" data-mcp-action="remove">删除</button>
      </div>
      ${tools ? `<div class="mcp-tools">${tools}</div>` : ''}
      ${resources ? `<div class="mcp-tools mcp-resources">${resources}</div>` : ''}
      ${logs ? `<details class="mcp-logs"><summary>日志</summary><pre>${escapeHtml(logs)}</pre></details>` : ''}
    </article>`;
  }).join('');
  list.querySelectorAll('.mcp-server-card').forEach((card) => {
    const id = card.dataset.mcpServer;
    card.querySelectorAll('[data-mcp-action]').forEach((button) => button.addEventListener('click', () => runMcpAction(id, button.dataset.mcpAction)));
    card.querySelectorAll('[data-mcp-call]').forEach((button) => button.addEventListener('click', () => callMcpTool(id, button.dataset.mcpCall)));
    card.querySelectorAll('[data-mcp-resource]').forEach((button) => button.addEventListener('click', () => readMcpResource(id, button.dataset.mcpResource)));
  });
}

async function loadMcpServers() {
  const list = document.getElementById('mcpServerList');
  if (list) list.innerHTML = '<div class="workbench-empty">正在加载 MCP Server…</div>';
  try {
    const response = await fetch(`${API_BASE}/api/mcp/servers`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取 MCP Server 失败');
    renderMcpServers(data.servers || []);
  } catch (error) {
    if (list) list.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  }
}

async function runMcpAction(id, action) {
  if (!id || !action) return;
  if (action === 'remove' && !confirm('确定删除这个 MCP Server 配置吗？')) return;
  try {
    const response = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}${action === 'remove' ? '' : `/${action}`}`, { method: action === 'remove' ? 'DELETE' : 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'MCP 操作失败');
    if (data.server?.logs?.length) setMcpOutput(data.server.logs.join('\n'));
    await loadMcpServers();
  } catch (error) {
    setMcpOutput('MCP 操作失败：' + (error.message || error));
  }
}

async function callMcpTool(id, name) {
  if (!id || !name) return;
  const raw = window.prompt(`调用 ${name}\n输入 JSON 参数（留空表示 {}）：`, '{}');
  if (raw === null) return;
  let args;
  try { args = raw.trim() ? JSON.parse(raw) : {}; } catch { setMcpOutput('参数 JSON 无效。'); return; }
  try {
    setMcpOutput(`正在调用 ${name}…`);
    const response = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'MCP 工具调用失败');
    setMcpOutput(data.result);
    await loadMcpServers();
  } catch (error) {
    setMcpOutput('MCP 工具调用失败：' + (error.message || error));
  }
}

async function readMcpResource(id, uri) {
  if (!id || !uri) return;
  try {
    setMcpOutput(`正在读取资源 ${uri}…`);
    const response = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(id)}/resource`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取 MCP Resource 失败');
    setMcpOutput(data.result);
  } catch (error) {
    setMcpOutput('读取 MCP Resource 失败：' + (error.message || error));
  }
}

function parseMcpArgs(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return (text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((part) => part.replace(/^("|')|("|')$/g, ''));
}

function initMcpPanel() {
  const form = document.getElementById('mcpAddForm');
  const transport = document.getElementById('mcpTransport');
  const command = document.getElementById('mcpCommand');
  const args = document.getElementById('mcpArgs');
  const url = document.getElementById('mcpUrl');
  const syncTransport = () => {
    const http = transport?.value === 'http';
    if (command) { command.style.display = http ? 'none' : ''; command.required = !http; }
    if (args) args.style.display = http ? 'none' : '';
    if (url) { url.style.display = http ? '' : 'none'; url.required = http; }
  };
  transport?.addEventListener('change', syncTransport);
  syncTransport();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const response = await fetch(`${API_BASE}/api/mcp/servers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: document.getElementById('mcpName')?.value || '', transport: transport?.value, command: command?.value || '', args: parseMcpArgs(args?.value), url: url?.value || '' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '添加 MCP Server 失败');
      form.reset(); syncTransport(); setMcpOutput(`已添加 ${data.server.name}。`); await loadMcpServers();
    } catch (error) { setMcpOutput('添加 MCP Server 失败：' + (error.message || error)); }
  });
}

async function searchWorkspaceText(query) {
  const resultsHost = document.getElementById('workspaceSearchResults');
  if (!resultsHost) return;
  const trimmed = String(query || '').trim();
  const epoch = ++workspaceSearchEpoch;
  if (!projectRoot) {
    resultsHost.innerHTML = '<div class="workbench-empty">请先打开项目。</div>';
    return;
  }
  if (trimmed.length < 2) {
    resultsHost.innerHTML = '<div class="workbench-empty">输入至少 2 个字符以搜索项目内容。</div>';
    return;
  }
  resultsHost.innerHTML = '<div class="workbench-empty">正在搜索…</div>';
  try {
    const response = await fetch(`${API_BASE}/api/fs/search?q=${encodeURIComponent(trimmed)}&limit=100`);
    const data = await response.json();
    if (epoch !== workspaceSearchEpoch) return;
    if (!response.ok) throw new Error(data.error || '搜索失败');
    const results = data.results || [];
    if (!results.length) {
      resultsHost.innerHTML = '<div class="workbench-empty">没有找到匹配内容。</div>';
      return;
    }
    resultsHost.innerHTML = results.map((result) => `<button type="button" class="workspace-search-result" data-path="${escapeHtml(result.path)}" title="${escapeHtml(result.path)}:${result.line}"><span class="workspace-search-path">${escapeHtml(result.path)}:${result.line}:${result.column}</span><span class="workspace-search-preview">${escapeHtml(result.preview)}</span></button>`).join('');
    resultsHost.querySelectorAll('.workspace-search-result').forEach((button) => {
      button.addEventListener('click', async () => {
        const target = button.dataset.path;
        if (!target) return;
        switchWorkbenchView('files');
        await openFilePreview(target);
      });
    });
  } catch (error) {
    if (epoch === workspaceSearchEpoch) resultsHost.innerHTML = `<div class="workbench-empty">${escapeHtml(error.message || String(error))}</div>`;
  }
}

function fileIcon(entry) {
  const name = String(entry.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const icon = (kind, label, badge = '') => `
    <span class="file-type-icon file-type-icon-${kind} ${entry.type === 'dir' ? 'is-folder' : 'is-file'}" role="img" aria-label="${label}" title="${label}">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path class="file-type-icon-folder" d="M2.8 6.7c0-1 .8-1.8 1.8-1.8h5l1.8 2h8.1c1 0 1.8.8 1.8 1.8v8.6c0 1-.8 1.8-1.8 1.8H4.6c-1 0-1.8-.8-1.8-1.8V6.7Z"/>
        <path class="file-type-icon-document" d="M6 2.8h7.4l4.6 4.6v13.8H6c-1 0-1.8-.8-1.8-1.8V4.6C4.2 3.6 5 2.8 6 2.8Z"/>
        <path class="file-type-icon-fold" d="M13.2 2.8v4.7h4.8"/>
      </svg>
      ${badge ? `<span class="file-type-icon-badge">${badge}</span>` : ''}
    </span>`;

  if (entry.type === 'dir') {
    const folders = {
      '.git': ['git-folder', 'Git 文件夹', '◆'], '.github': ['github-folder', 'GitHub 文件夹', '◆'],
      'node_modules': ['node-folder', 'Node 依赖', '⬡'], 'src': ['source-folder', '源代码', '‹›'],
      'dist': ['build-folder', '构建产物', '▣'], 'build': ['build-folder', '构建目录', '▣'],
      'out': ['build-folder', '输出目录', '▣'], 'public': ['assets-folder', '公共资源', '◈'],
      'assets': ['assets-folder', '资源目录', '◈'], 'images': ['assets-folder', '图片目录', '◈'],
      'workspace': ['workspace-folder', '工作区', '⌘'], 'scripts': ['scripts-folder', '脚本目录', '>_'],
      'test': ['test-folder', '测试目录', 'T'], 'tests': ['test-folder', '测试目录', 'T'],
    };
    const found = folders[name] || ['folder', '文件夹', ''];
    return icon(found[0], found[1], found[2]);
  }

  const byName = {
    '.gitignore': ['git', 'Git 忽略文件', '◆'], '.gitattributes': ['git', 'Git 属性文件', '◆'],
    'package.json': ['npm', 'npm 配置', 'NPM'], 'package-lock.json': ['npm', 'npm 锁定文件', 'NPM'],
    'tsconfig.json': ['typescript', 'TypeScript 配置', 'TS'], 'readme.md': ['markdown', 'Markdown 文档', 'M↓'],
    'license': ['license', '许可证', '§'], 'dockerfile': ['docker', 'Docker 文件', '▣'],
    '.env': ['env', '环境变量', 'E'], '.env.local': ['env', '环境变量', 'E'],
  };
  const byExt = {
    js: ['javascript', 'JavaScript', 'JS'], mjs: ['javascript', 'JavaScript', 'JS'], cjs: ['javascript', 'JavaScript', 'JS'],
    ts: ['typescript', 'TypeScript', 'TS'], tsx: ['react', 'TSX React 组件', 'R'], jsx: ['react', 'JSX React 组件', 'R'],
    py: ['python', 'Python', 'Py'], json: ['json', 'JSON', '{}'], md: ['markdown', 'Markdown', 'M↓'], mdx: ['markdown', 'Markdown', 'M↓'],
    html: ['html', 'HTML', '5'], htm: ['html', 'HTML', '5'], css: ['css', 'CSS', '#'], scss: ['sass', 'SCSS', 'S'], sass: ['sass', 'Sass', 'S'], less: ['sass', 'Less', 'L'],
    yml: ['yaml', 'YAML', 'Y'], yaml: ['yaml', 'YAML', 'Y'], xml: ['xml', 'XML', 'XML'], toml: ['config', 'TOML', 'CFG'], ini: ['config', 'INI', 'CFG'], conf: ['config', '配置', 'CFG'],
    sh: ['shell', 'Shell 脚本', '>_'], bash: ['shell', 'Bash 脚本', '>_'], zsh: ['shell', 'Zsh 脚本', '>_'], bat: ['terminal', '批处理脚本', '>_'], cmd: ['terminal', '命令脚本', '>_'], ps1: ['powershell', 'PowerShell 脚本', 'PS'],
    png: ['image', 'PNG 图片', '▧'], jpg: ['image', 'JPG 图片', '▧'], jpeg: ['image', 'JPEG 图片', '▧'], gif: ['image', 'GIF 图片', '▧'], webp: ['image', 'WebP 图片', '▧'], svg: ['image', 'SVG 图片', '▧'], ico: ['image', '图标文件', '▧'],
    txt: ['text', '文本文件', '≡'], log: ['log', '日志文件', '≡'], csv: ['table', 'CSV 数据', '▦'], xlsx: ['table', 'Excel 表格', '▦'],
    zip: ['archive', '压缩文件', '▤'], rar: ['archive', '压缩文件', '▤'], '7z': ['archive', '压缩文件', '▤'],
    patch: ['diff', '补丁文件', '±'], diff: ['diff', '差异文件', '±'],
    c: ['c', 'C 源文件', 'C'], h: ['c', 'C/C++ 头文件', 'H'], cpp: ['cpp', 'C++ 源文件', 'C+'], hpp: ['cpp', 'C++ 头文件', 'H+'],
    java: ['java', 'Java', 'J'], go: ['go', 'Go', 'Go'], rs: ['rust', 'Rust', 'R'], php: ['php', 'PHP', 'PHP'], rb: ['ruby', 'Ruby', 'Rb'],
  };
  const found = byName[name] || byExt[ext] || ['file', '文件', ''];
  return icon(found[0], found[1], found[2]);
}

function showFilesEmpty(recent) {
  const list = document.getElementById('filesList');
  const pathEl = document.getElementById('filesPath');
  const crumb = document.getElementById('filesCrumb');
  const title = document.getElementById('filesPanelTitle');
  const refreshBtn = document.getElementById('filesRefreshBtn');
  const closeProj = document.getElementById('filesCloseProjectBtn');
  closeFilePreview();
  if (title) title.textContent = '项目';
  if (pathEl) pathEl.style.display = 'none';
  if (crumb) { crumb.style.display = 'none'; crumb.innerHTML = ''; }
  if (refreshBtn) refreshBtn.style.display = 'none';
  if (closeProj) closeProj.style.display = 'none';
  if (!list) return;

  let recentHtml = '';
  const items = recent || projectRecent || [];
  if (items.length) {
    recentHtml = `<div class="files-recent"><div class="files-recent-label">最近打开</div>` +
      items.map((r) => {
        const p = typeof r === 'string' ? r : r.path;
        const n = typeof r === 'string' ? (r.split(/[/\\]/).pop() || r) : (r.name || r.path);
        return `<button type="button" class="files-recent-item" data-root="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(n)}</button>`;
      }).join('') + `</div>`;
  }

  list.innerHTML = `
    <div class="files-empty-state" id="filesEmptyState">
      <div class="files-empty-icon">${uiIcon('folder')}</div>
      <p>尚未打开项目</p>
      <p class="files-empty-hint">打开一个文件夹后，这里会显示项目文件</p>
      <button type="button" class="btn-primary btn-sm" id="filesOpenBtnMain">打开项目</button>
      ${recentHtml}
    </div>
  `;
  const mainOpen = document.getElementById('filesOpenBtnMain');
  if (mainOpen) mainOpen.addEventListener('click', openProjectPicker);
  list.querySelectorAll('.files-recent-item').forEach((btn) => {
    btn.addEventListener('click', () => openProjectPath(btn.dataset.root));
  });
}

function renderFilesCrumb(relPath, rootName) {
  const el = document.getElementById('filesCrumb');
  if (!el) return;
  el.style.display = 'flex';
  const parts = (relPath === '.' || !relPath) ? [] : relPath.split('/').filter(Boolean);
  let html = `<button type="button" data-path=".">${escapeHtml(rootName || '项目')}</button>`;
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    html += `<span class="sep">/</span><button type="button" data-path="${escapeHtml(acc)}">${escapeHtml(p)}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => loadFilesList(btn.dataset.path || '.'));
  });
}

async function loadProjectState() {
  try {
    const resp = await fetch(`${API_BASE}/api/project`);
    const data = await resp.json();
    projectRoot = data.root || null;
    projectName = data.name || null;
    projectRecent = data.recent || [];
    if (projectRoot) {
      filesCurrentPath = '.';
      await loadFilesList('.', false);
    } else {
      showFilesEmpty(projectRecent);
    }
  } catch {
    showFilesEmpty([]);
  }
}

async function openProjectPath(rootPath) {
  if (!rootPath) return;
  try {
    const resp = await fetch(`${API_BASE}/api/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: rootPath }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '打开失败');
    projectRoot = data.root || null;
    projectName = data.name || null;
    projectRecent = data.recent || [];
    filesCurrentPath = '.';
    filesLastSig = '';
    closeFilePreview();
    await loadFilesList('.', false);
    if (workbenchView === 'git') loadGitWorkbench();
  } catch (err) {
    addError('打开项目失败：' + (err.message || err));
  }
}

async function openProjectPicker() {
  // Electron native folder dialog
  if (window.iexaDesktop && typeof window.iexaDesktop.pickFolder === 'function') {
    try {
      const folder = await window.iexaDesktop.pickFolder();
      if (folder) await openProjectPath(folder);
      return;
    } catch (err) {
      console.error(err);
    }
  }
  // Fallback: prompt for path (browser / no preload)
  const p = window.prompt('输入项目文件夹完整路径：');
  if (p && p.trim()) await openProjectPath(p.trim());
}

async function closeProject() {
  try {
    await fetch(`${API_BASE}/api/project/clear`, { method: 'POST' });
  } catch { /* */ }
  projectRoot = null;
  projectName = null;
  filesCurrentPath = '.';
  filesLastSig = '';
  switchWorkbenchView('files');
  await loadProjectState();
}

async function loadFilesList(relPath, silent) {
  const list = document.getElementById('filesList');
  const pathEl = document.getElementById('filesPath');
  const title = document.getElementById('filesPanelTitle');
  const refreshBtn = document.getElementById('filesRefreshBtn');
  const closeProj = document.getElementById('filesCloseProjectBtn');
  if (!list) return;

  if (!projectRoot) {
    showFilesEmpty(projectRecent);
    return;
  }

  const target = relPath == null ? filesCurrentPath : relPath;
  try {
    if (!silent) list.innerHTML = '<div class="files-empty">加载中…</div>';
    const resp = await fetch(`${API_BASE}/api/fs/list?path=${encodeURIComponent(target)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '加载失败');

    if (data.empty || !data.root) {
      projectRoot = null;
      showFilesEmpty(projectRecent);
      return;
    }

    projectRoot = data.root;
    projectName = data.name || projectName;
    filesCurrentPath = data.path || '.';

    if (title) title.textContent = projectName || '项目';
    if (pathEl) {
      pathEl.style.display = 'block';
      pathEl.textContent = data.root;
      pathEl.title = data.root;
    }
    if (refreshBtn) refreshBtn.style.display = 'flex';
    if (closeProj) closeProj.style.display = 'flex';
    renderFilesCrumb(filesCurrentPath, projectName);

    const entries = data.entries || [];
    const sig = entries.map((e) => e.name + e.type + e.size + e.mtime).join('|') + '@' + filesCurrentPath + '@' + projectRoot;
    if (silent && sig === filesLastSig) return;
    filesLastSig = sig;

    if (entries.length === 0) {
      list.innerHTML = '<div class="files-empty">空目录</div>';
      return;
    }

    const showUp = filesCurrentPath && filesCurrentPath !== '.';
    let html = '';
    if (showUp) {
      const parent = filesCurrentPath.split('/').slice(0, -1).join('/') || '.';
      html += `<button type="button" class="files-item" data-nav="${escapeHtml(parent)}">
        <span class="files-item-icon">⬆</span>
        <span class="files-item-name">..</span>
      </button>`;
    }
    html += entries.map((e) => `
      <button type="button" class="files-item${filesSelectedPath === e.path ? ' active' : ''}"
        data-type="${e.type}" data-path="${escapeHtml(e.path)}" title="${escapeHtml(e.path)}">
        <span class="files-item-icon">${fileIcon(e)}</span>
        <span class="files-item-name">${escapeHtml(e.name)}</span>
        <span class="files-item-meta">${e.type === 'dir' ? '' : formatFileSize(e.size || 0)}</span>
      </button>
    `).join('');
    list.innerHTML = html;

    list.querySelectorAll('.files-item').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.nav != null) {
          loadFilesList(btn.dataset.nav);
          return;
        }
        const p = btn.dataset.path;
        const t = btn.dataset.type;
        if (t === 'dir') {
          loadFilesList(p);
        } else {
          await openFilePreview(p);
          list.querySelectorAll('.files-item').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        }
      });
    });
  } catch (err) {
    if (!silent) list.innerHTML = `<div class="files-empty">加载失败：${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function openFilePreview(relPath) {
  const box = document.getElementById('filesPreview');
  const nameEl = document.getElementById('filesPreviewName');
  const bodyEl = document.getElementById('filesPreviewBody');
  if (!box || !bodyEl || !projectRoot) return;
  try {
    filesSelectedPath = relPath;
    const ext = (relPath.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
      box.dataset.open = 'true';
      box.style.display = 'flex';
      if (nameEl) nameEl.textContent = relPath.split('/').pop() || relPath;
      bodyEl.innerHTML = `<img class="files-preview-image" src="${API_BASE}/api/fs/raw?path=${encodeURIComponent(relPath)}" alt="${escapeHtml(relPath)}">`;
      return;
    }
    const resp = await fetch(`${API_BASE}/api/fs/read?path=${encodeURIComponent(relPath)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '读取失败');
    box.dataset.open = 'true';
    box.style.display = 'flex';
    if (nameEl) nameEl.textContent = data.name || relPath;
    bodyEl.textContent = data.content || '';
  } catch (err) {
    box.dataset.open = 'true';
    box.style.display = 'flex';
    if (nameEl) nameEl.textContent = relPath;
    bodyEl.textContent = '无法预览：' + (err.message || err);
  }
}

function closeFilePreview() {
  const box = document.getElementById('filesPreview');
  if (box) { box.dataset.open = 'false'; box.style.display = 'none'; }
  filesSelectedPath = '';
  document.querySelectorAll('.files-item.active').forEach((b) => b.classList.remove('active'));
}

function initFilesPanel() {
  document.querySelectorAll('.workbench-tab').forEach((button) => {
    button.addEventListener('click', () => switchWorkbenchView(button.dataset.workbenchView));
  });
  const searchInput = document.getElementById('workspaceSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (workspaceSearchTimer) clearTimeout(workspaceSearchTimer);
      workspaceSearchTimer = setTimeout(() => searchWorkspaceText(searchInput.value), 220);
    });
  }
  const openBtn = document.getElementById('filesOpenBtn');
  if (openBtn) openBtn.addEventListener('click', openProjectPicker);
  const refreshBtn = document.getElementById('filesRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    if (projectRoot) loadFilesList(filesCurrentPath);
  });
  const closeProj = document.getElementById('filesCloseProjectBtn');
  if (closeProj) closeProj.addEventListener('click', closeProject);
  const closeBtn = document.getElementById('filesPreviewClose');
  if (closeBtn) closeBtn.addEventListener('click', closeFilePreview);

  // Context menu: right-click on files list items
  const filesList = document.getElementById('filesList');
  const contextMenu = document.getElementById('filesContextMenu');
  let contextTarget = null;

  if (filesList) {
    filesList.addEventListener('contextmenu', (e) => {
      const btn = e.target.closest('.files-item');
      if (!btn || btn.dataset.nav != null) return; // ignore ".." button
      e.preventDefault();
      contextTarget = btn;
      contextMenu.style.display = 'flex';
      contextMenu.style.left = e.clientX + 'px';
      contextMenu.style.top = e.clientY + 'px';
    });
  }

  if (contextMenu) {
    contextMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('.files-context-item');
      if (!item || !contextTarget) return;
      contextMenu.style.display = 'none';
      const action = item.dataset.action;
      const path = contextTarget.dataset.path;
      const name = contextTarget.querySelector('.files-item-name')?.textContent || '';
      const type = contextTarget.dataset.type;

      if (action === 'delete') {
        const label = type === 'dir' ? '目录' : '文件';
        if (!confirm(`确定删除${label}「${name}」吗？\n此操作不可撤销！`)) return;
        try {
          const resp = await fetch(`${API_BASE}/api/fs/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || '删除失败');
          loadFilesList(filesCurrentPath);
        } catch (err) {
          alert('删除失败：' + (err.message || err));
        }
      } else if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(path);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = path;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
      } else if (action === 'copy-path') {
        const fullPath = projectRoot ? projectRoot.replace(/\\/g, '/') + '/' + path : path;
        try {
          await navigator.clipboard.writeText(fullPath);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = fullPath;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
      }
      contextTarget = null;
    });

    // Close menu on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.files-context-menu')) {
        contextMenu.style.display = 'none';
        contextTarget = null;
      }
    });
  }

  loadProjectState();
  if (filesPollTimer) clearInterval(filesPollTimer);
  filesPollTimer = setInterval(() => {
    if (projectRoot) loadFilesList(filesCurrentPath, true);
    if (projectRoot && workbenchView === 'git') loadGitWorkbench();
  }, 4000);
}

function refreshFilesPanelSoft() {
  if (projectRoot) loadFilesList(filesCurrentPath, true).catch(() => {});
}

// =============================================================================
// Skills management + slash trigger (iOS-style)
// =============================================================================

let skillsCache = [];

async function loadSkillsList() {
  const list = document.getElementById('skillList');
  if (!list) return;
  try {
    const resp = await fetch(`${API_BASE}/api/skills`);
    const data = await resp.json();
    skillsCache = data.skills || [];
    if (skillsCache.length === 0) {
      list.innerHTML = '<div class="profile-empty">暂无 Skill。点击「+ 导入」粘贴 SKILL.md。</div>';
      return;
    }
    list.innerHTML = skillsCache.map((s) => `
      <div class="skill-card ${s.enabled ? '' : 'disabled'}" data-id="${escapeHtml(s.id)}">
        <div class="skill-card-main">
          <div class="skill-card-title">
            <strong>${escapeHtml(s.name)}</strong>
            <span class="skill-badge">${escapeHtml(s.source || 'file')}</span>
            ${s.systemPrompt ? '<span class="skill-badge sys">系统级</span>' : ''}
            ${s.enabled ? '' : '<span class="skill-badge off">已关闭</span>'}
          </div>
          <div class="skill-card-desc">${escapeHtml(s.description || '（无描述）')}</div>
          <div class="skill-card-meta">使用 ${s.useCount || 0} 次 · v${escapeHtml(s.version || '1.0.0')}</div>
        </div>
        <div class="skill-card-actions">
          <button type="button" class="btn-secondary btn-sm" data-act="toggle">${s.enabled ? '禁用' : '启用'}</button>
          <button type="button" class="btn-secondary btn-sm" data-act="sysprompt">${s.systemPrompt ? '取消系统级' : '系统级'}</button>
          <button type="button" class="btn-secondary btn-sm" data-act="view">查看</button>
          <button type="button" class="btn-secondary btn-sm skill-del" data-act="delete">删除</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.skill-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'toggle') {
            const s = skillsCache.find((x) => x.id === id);
            await fetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: !(s && s.enabled) }),
            });
            loadSkillsList();
          } else if (act === 'sysprompt') {
            const s = skillsCache.find((x) => x.id === id);
            await fetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ systemPrompt: !(s && s.systemPrompt) }),
            });
            loadSkillsList();
          } else if (act === 'view') {
            openSkillViewer(id);
          } else if (act === 'delete') {
            if (!confirm('确定删除该 Skill？')) return;
            await fetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
            loadSkillsList();
          }
        });
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="profile-empty">加载失败：${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function openSkillViewer(id) {
  try {
    const resp = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '读取失败');
    const overlay = document.getElementById('skillEditorOverlay');
    const title = document.getElementById('skillEditorTitle');
    const content = document.getElementById('skillEditorContent');
    const saveBtn = document.getElementById('skillEditorSave');
    if (!overlay || !content) return;
    title.textContent = '编辑 · ' + (data.skill?.name || id);
    content.value = data.content || '';
    content.dataset.editId = id;
    saveBtn.textContent = '保存修改';
    overlay.style.display = 'flex';
  } catch (err) {
    addError(err.message || String(err));
  }
}

function openSkillImporter() {
  const overlay = document.getElementById('skillEditorOverlay');
  const title = document.getElementById('skillEditorTitle');
  const content = document.getElementById('skillEditorContent');
  const saveBtn = document.getElementById('skillEditorSave');
  if (!overlay || !content) return;
  title.textContent = '粘贴导入 Skill';
  content.value = '';
  delete content.dataset.editId;
  delete content.dataset.importSource;
  saveBtn.textContent = '保存';
  overlay.style.display = 'flex';
  content.focus();
}

function closeSkillEditor() {
  const overlay = document.getElementById('skillEditorOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function importSkillContent(text, source) {
  const resp = await fetch(`${API_BASE}/api/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, source: source || 'file' }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '导入失败');
  return data.skill;
}

async function saveSkillEditor() {
  const contentEl = document.getElementById('skillEditorContent');
  if (!contentEl) return;
  const text = contentEl.value.trim();
  if (!text) {
    addError('请填写或粘贴 SKILL.md 内容');
    return;
  }
  try {
    const editId = contentEl.dataset.editId;
    if (editId) {
      const resp = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '保存失败');
    } else {
      await importSkillContent(text, contentEl.dataset.importSource || 'paste');
    }
    closeSkillEditor();
    loadSkillsList();
  } catch (err) {
    addError(err.message || String(err));
  }
}

async function importSkillFromPicked(picked) {
  if (!picked) return;
  if (picked.error) {
    addError(picked.error);
    return;
  }
  if (!picked.content) {
    addError('未能读取 SKILL.md');
    return;
  }
  await importSkillContent(picked.content, 'file');
  loadSkillsList();
}

/** Pick SKILL.md file via Electron dialog or hidden file input */
async function importSkillFromFile() {
  if (window.iexaDesktop && typeof window.iexaDesktop.pickSkillFile === 'function') {
    try {
      const picked = await window.iexaDesktop.pickSkillFile();
      await importSkillFromPicked(picked);
      return;
    } catch (err) {
      console.error(err);
      addError(err.message || String(err));
      return;
    }
  }
  // Browser fallback
  const input = document.getElementById('skillFileInput');
  if (input) input.click();
}

/** Open IEXA PC's skills directory in Explorer for manual management */
async function openSkillsDirectory() {
  try {
    const resp = await fetch(`${API_BASE}/api/skills`);
    const data = await resp.json();
    const dir = data.skillsDir;
    if (!dir) throw new Error('无法获取 Skills 目录路径');

    if (window.iexaDesktop && typeof window.iexaDesktop.openPath === 'function') {
      const result = await window.iexaDesktop.openPath(dir);
      if (result && result.error) throw new Error(result.error);
    } else {
      // Browser fallback: show path
      window.prompt('Skills 目录路径（请手动在资源管理器中打开）：', dir);
    }
    // Rescan after user may have edited files on disk
    setTimeout(() => loadSkillsList(), 800);
  } catch (err) {
    addError(err.message || String(err));
  }
}

function onSkillFileInputChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const text = String(reader.result || '');
      if (!text.trim()) throw new Error('文件为空');
      await importSkillContent(text, 'file');
      loadSkillsList();
    } catch (err) {
      addError(err.message || String(err));
    }
  };
  reader.onerror = () => addError('读取文件失败');
  reader.readAsText(file);
}

function toggleSkillAddMenu(force) {
  const menu = document.getElementById('skillAddMenu');
  if (!menu) return;
  const show = force != null ? force : menu.style.display === 'none';
  menu.style.display = show ? 'flex' : 'none';
}

function closeSkillAddMenu() {
  toggleSkillAddMenu(false);
}

function initSkillsUI() {
  const addBtn = document.getElementById('skillAddBtn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('skillAddMenu');
      const open = menu && menu.style.display !== 'none';
      toggleSkillAddMenu(!open);
    });
  }

  const importBtn = document.getElementById('skillImportBtn');
  if (importBtn) importBtn.addEventListener('click', () => {
    closeSkillAddMenu();
    openSkillImporter();
  });
  const fileBtn = document.getElementById('skillImportFileBtn');
  if (fileBtn) fileBtn.addEventListener('click', () => {
    closeSkillAddMenu();
    importSkillFromFile();
  });
  const openDirBtn = document.getElementById('skillOpenDirBtn');
  if (openDirBtn) openDirBtn.addEventListener('click', () => {
    closeSkillAddMenu();
    openSkillsDirectory();
  });
  const fileInput = document.getElementById('skillFileInput');
  if (fileInput) fileInput.addEventListener('change', onSkillFileInputChange);
  const cancel = document.getElementById('skillEditorCancel');
  if (cancel) cancel.addEventListener('click', closeSkillEditor);
  const save = document.getElementById('skillEditorSave');
  if (save) save.addEventListener('click', saveSkillEditor);
  const overlay = document.getElementById('skillEditorOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSkillEditor();
    });
  }

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('skillAddWrap');
    if (wrap && !wrap.contains(e.target)) closeSkillAddMenu();
  });

  // Warm skills cache for slash menu
  fetch(`${API_BASE}/api/skills`).then((r) => r.json()).then((d) => {
    skillsCache = d.skills || [];
  }).catch(() => {});
}

// ---- Slash menu: type / to pick a skill (typing aid only, like iOS) ----
function hideSlashMenu() {
  const menu = document.getElementById('slashMenu');
  if (menu) menu.style.display = 'none';
}

function updateSlashMenu() {
  const menu = document.getElementById('slashMenu');
  if (!menu || !chatInput) return;
  const val = chatInput.value;
  // Only at start of input or after newline: "/xxx"
  const m = val.match(/(?:^|\n)\/([^\s\n]*)$/);
  if (!m) {
    hideSlashMenu();
    return;
  }
  const q = (m[1] || '').toLowerCase();
  const enabled = (skillsCache || []).filter((s) => s.enabled !== false);
  const matched = enabled.filter((s) => {
    const name = (s.name || '').toLowerCase();
    const id = (s.id || '').toLowerCase();
    return !q || name.includes(q) || id.includes(q);
  }).slice(0, 8);

  if (matched.length === 0) {
    hideSlashMenu();
    return;
  }

  menu.innerHTML = matched.map((s, i) => `
    <button type="button" class="slash-item${i === 0 ? ' active' : ''}" data-name="${escapeHtml(s.name)}">
      <span class="slash-item-name">/${escapeHtml(s.name)}</span>
      <span class="slash-item-desc">${escapeHtml((s.description || '').substring(0, 60))}</span>
    </button>
  `).join('');
  menu.style.display = 'flex';
  menu.querySelectorAll('.slash-item').forEach((btn) => {
    btn.addEventListener('click', () => applySlashSkill(btn.dataset.name || ''));
  });
}

function applySlashSkill(name) {
  if (!name || !chatInput) return;
  const val = chatInput.value;
  const replaced = val.replace(/(?:^|\n)\/[^\s\n]*$/, (match) => {
    const prefix = match.startsWith('\n') ? '\n' : '';
    return prefix + '/' + name + ' ';
  });
  // If no match replace (edge), just set
  chatInput.value = replaced === val ? ('/' + name + ' ') : replaced;
  chatInput.focus();
  hideSlashMenu();
  chatInput.dispatchEvent(new Event('input'));
}

// =============================================================================
// Text selection / editable field context menu
// =============================================================================

function initTextContextMenu() {
  const menu = document.getElementById('textContextMenu');
  if (!menu) return;
  const copyItem = menu.querySelector('[data-text-action="copy"]');
  const pasteItem = menu.querySelector('[data-text-action="paste"]');
  let selectedText = '';
  let editor = null;
  let editorSelection = null;

  const isEditable = (el) => el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);

  const close = () => {
    menu.style.display = 'none';
    selectedText = '';
    editor = null;
    editorSelection = null;
  };

  const copyText = async (text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = text;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }
  };

  const insertText = (target, text) => {
    if (!target || !text) return;
    target.focus();
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const start = editorSelection?.start ?? target.selectionStart ?? target.value.length;
      const end = editorSelection?.end ?? target.selectionEnd ?? start;
      target.setRangeText(text, start, end, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (target.isContentEditable) {
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      if (editorSelection?.range) selection.addRange(editorSelection.range);
      document.execCommand('insertText', false, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const placeMenu = (x, y) => {
    menu.style.display = 'flex';
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  };

  document.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.files-context-menu') || event.target.closest('#filesList')) return;
    const target = event.target instanceof Element ? event.target.closest('textarea, input, [contenteditable="true"]') : null;
    const editable = isEditable(target);
    const nativeSelection = window.getSelection();
    const pageSelection = nativeSelection ? nativeSelection.toString().trim() : '';
    const fieldSelection = editable && 'value' in target
      ? String(target.value).slice(target.selectionStart || 0, target.selectionEnd || 0)
      : '';
    const text = fieldSelection || pageSelection;
    if (!text && !editable) return;

    event.preventDefault();
    selectedText = text;
    editor = editable ? target : null;
    editorSelection = null;
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      editorSelection = { start: editor.selectionStart, end: editor.selectionEnd };
    } else if (editor && editor.isContentEditable && nativeSelection?.rangeCount) {
      editorSelection = { range: nativeSelection.getRangeAt(0).cloneRange() };
    }
    copyItem.hidden = !selectedText;
    pasteItem.hidden = !editor;
    placeMenu(event.clientX, event.clientY);
  });

  menu.addEventListener('click', async (event) => {
    const item = event.target.closest('[data-text-action]');
    if (!item) return;
    const action = item.dataset.textAction;
    if (action === 'copy') await copyText(selectedText);
    if (action === 'paste' && editor) {
      try {
        const text = await navigator.clipboard.readText();
        insertText(editor, text);
      } catch {
        editor.focus();
        document.execCommand('paste');
      }
    }
    close();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
}

// =============================================================================
// Session-scoped background task center
// =============================================================================
let jobsCache = [];
let jobsFilter = 'current';
let jobsRefreshTimer = null;
let jobsLoadError = '';

function jobStatusText(status) {
  return ({ queued: '等待中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] || '未知';
}
function jobTime(value) {
  const date = Number(value) ? new Date(Number(value)) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}
function renderJobs() {
  const list = document.getElementById('jobsList');
  const badge = document.getElementById('navJobBadge');
  if (!list) return;
  const runningCount = jobsCache.filter((job) => job.status === 'queued' || job.status === 'running').length;
  if (badge) { badge.hidden = runningCount === 0; badge.textContent = String(runningCount); }
  const visible = jobsFilter === 'current'
    ? jobsCache.filter((job) => job.sessionId === currentSessionId)
    : jobsCache;
  if (jobsLoadError) {
    list.innerHTML = `<div class="jobs-load-error"><strong>任务中心暂时无法加载</strong><span>${escapeHtml(jobsLoadError)}</span><button type="button" class="btn-secondary btn-sm" data-jobs-retry>重新连接</button></div>`;
    list.querySelector('[data-jobs-retry]')?.addEventListener('click', loadJobs);
    return;
  }
  if (!visible.length) {
    list.innerHTML = '<div class="profile-empty">当前还没有任务。发送消息后会先创建一条 AI 处理任务；调用工具时会额外显示工具子任务。</div>';
    return;
  }
  list.innerHTML = visible.map((job) => {
    const title = job.title || (job.kind === 'turn' ? 'AI 回复' : job.toolName || '工具任务');
    const kind = job.kind === 'turn' ? 'AI 回合' : (job.toolName || '工具');
    const session = (sessionsCache.find((item) => item.id === job.sessionId)?.title || job.sessionId).slice(0, 32);
    return `
    <article class="job-card is-${escapeHtml(job.status)} is-${escapeHtml(job.kind || 'tool')}">
      <div class="job-card-head"><span class="job-status-dot"></span><strong>${escapeHtml(title)}</strong><span class="job-status">${jobStatusText(job.status)}</span></div>
      <div class="job-card-meta"><span>${escapeHtml(kind)}</span><span>会话 ${escapeHtml(session)}</span><time>${jobTime(job.startedAt || job.createdAt)}</time></div>
      ${job.outputPreview ? `<pre class="job-output">${escapeHtml(job.outputPreview)}</pre>` : ''}
    </article>`;
  }).join('');
}
async function loadJobs() {
  const list = document.getElementById('jobsList');
  try {
    const scope = jobsFilter === 'current' && currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : '';
    const response = await fetch(`${API_BASE}/api/jobs${scope}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('当前桌面窗口仍在使用旧后端。请结束正在运行的任务后，完全退出并重新打开 IEXA。');
      }
      throw new Error(data.error || `服务返回 ${response.status}`);
    }
    jobsCache = Array.isArray(data.jobs) ? data.jobs : [];
    jobsLoadError = '';
    renderJobs();
  } catch (error) {
    jobsLoadError = error?.message || '无法连接本地 IEXA 服务。';
    console.error('Failed to load jobs:', error);
    if (list) renderJobs();
  }
}
function applyJobUpdate(job) {
  if (!job || !job.id) return;
  const index = jobsCache.findIndex((item) => item.id === job.id);
  if (index >= 0) jobsCache[index] = { ...jobsCache[index], ...job };
  else jobsCache.unshift(job);
  jobsLoadError = '';
  renderJobs();
}
function syncJobsPolling() {
  const active = document.getElementById('view-jobs')?.classList.contains('active');
  if (active && !jobsRefreshTimer) jobsRefreshTimer = window.setInterval(loadJobs, 2500);
  if (!active && jobsRefreshTimer) { window.clearInterval(jobsRefreshTimer); jobsRefreshTimer = null; }
}
function initJobsUI() {
  const refresh = document.getElementById('jobsRefreshBtn');
  if (refresh) refresh.addEventListener('click', loadJobs);
  const filter = document.getElementById('jobsFilter');
  if (filter) filter.addEventListener('click', (event) => {
    const button = event.target.closest('[data-jobs-filter]');
    if (!button) return;
    jobsFilter = button.dataset.jobsFilter || 'current';
    filter.querySelectorAll('button').forEach((item) => item.classList.toggle('is-active', item === button));
    loadJobs();
  });
}

const PERMISSION_MODE_LABELS = {
  ask: '请求批准',
  risk: '帮我批准',
  full: '完全访问权限',
};
let permissionMode = 'risk';

function syncPermissionModeUI() {
  const list = document.getElementById('permissionModeList');
  if (list) list.querySelectorAll('[data-permission-mode]').forEach((button) => {
    const active = button.dataset.permissionMode === permissionMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const label = document.getElementById('permissionModeLabel');
  if (label) label.textContent = PERMISSION_MODE_LABELS[permissionMode];
  const menu = document.getElementById('permissionModeMenu');
  if (menu) menu.querySelectorAll('[data-permission-menu-mode]').forEach((button) => {
    const active = button.dataset.permissionMenuMode === permissionMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

function setPermissionMenuOpen(open) {
  const button = document.getElementById('permissionModeBtn');
  const menu = document.getElementById('permissionModeMenu');
  if (!button || !menu) return;
  menu.style.display = open ? 'flex' : 'none';
  button.classList.toggle('is-open', open);
  button.setAttribute('aria-expanded', String(open));
}

async function setPermissionMode(mode) {
  if (!Object.prototype.hasOwnProperty.call(PERMISSION_MODE_LABELS, mode)) return;
  const previous = permissionMode;
  permissionMode = mode;
  syncPermissionModeUI();
  try {
    const response = await fetch(API_BASE + '/api/permissions/mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '权限模式保存失败');
    setPermissionMenuOpen(false);
  } catch (error) {
    permissionMode = previous;
    syncPermissionModeUI();
    addError(error.message || String(error));
  }
}

async function loadPermissionMode() {
  try {
    const response = await fetch(API_BASE + '/api/permissions/mode', { cache: 'no-store' });
    const data = await response.json();
    if (data && PERMISSION_MODE_LABELS[data.mode]) permissionMode = data.mode;
  } catch { /* The default risk mode remains usable while the server starts. */ }
  syncPermissionModeUI();
}

function initPermissionModeUI() {
  const list = document.getElementById('permissionModeList');
  if (list) list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-permission-mode]');
    if (button) setPermissionMode(button.dataset.permissionMode);
  });
  const button = document.getElementById('permissionModeBtn');
  const wrap = document.getElementById('permissionModeWrap');
  const menu = document.getElementById('permissionModeMenu');
  if (button && wrap && menu) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPermissionMenuOpen(menu.style.display !== 'flex');
    });
    menu.querySelectorAll('[data-permission-menu-mode]').forEach((option) => {
      option.addEventListener('click', () => setPermissionMode(option.dataset.permissionMenuMode));
    });
    document.addEventListener('click', (event) => {
      if (!wrap.contains(event.target)) setPermissionMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setPermissionMenuOpen(false);
    });
  }
  syncPermissionModeUI();
}

// =============================================================================
// Adjustable desktop panels
// =============================================================================

function initPanelResizers() {
  const root = document.documentElement;
  const sidebarResizer = document.getElementById('sidebarResizer');
  const filesResizer = document.getElementById('filesResizer');
  if (!sidebarResizer || !filesResizer) return;

  const defaults = { sidebar: 240, files: 300 };
  const readWidth = (key) => {
    const value = Number.parseInt(localStorage.getItem(`iexa-${key}-width`) || '', 10);
    return Number.isFinite(value) ? value : defaults[key];
  };
  let sidebarWidth = readWidth('sidebar');
  let filesWidth = readWidth('files');

  const limits = (key) => {
    const other = key === 'sidebar' ? filesWidth : sidebarWidth;
    return { min: key === 'sidebar' ? 180 : 220, max: Math.max(key === 'sidebar' ? 180 : 220, Math.min(key === 'sidebar' ? 460 : 560, window.innerWidth - other - 420)) };
  };
  const clamp = (value, key) => {
    const { min, max } = limits(key);
    return Math.round(Math.min(max, Math.max(min, value)));
  };
  const apply = (key, value, persist = true) => {
    const next = clamp(value, key);
    if (key === 'sidebar') sidebarWidth = next; else filesWidth = next;
    root.style.setProperty(key === 'sidebar' ? '--sidebar-width' : '--files-panel-width', `${next}px`);
    if (persist) localStorage.setItem(`iexa-${key}-width`, String(next));
  };
  const normalize = () => {
    apply('sidebar', sidebarWidth);
    apply('files', filesWidth);
  };

  normalize();
  window.addEventListener('resize', normalize);

  const bind = (handle, key) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      document.body.classList.add('is-resizing');
      const resize = (clientX) => apply(key, key === 'sidebar' ? clientX : window.innerWidth - clientX);
      const move = (moveEvent) => resize(moveEvent.clientX);
      const finish = () => {
        handle.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });

    handle.addEventListener('dblclick', () => apply(key, defaults[key]));
    handle.addEventListener('keydown', (event) => {
      const isSidebar = key === 'sidebar';
      let next = null;
      if (event.key === 'Home') next = limits(key).min;
      if (event.key === 'End') next = limits(key).max;
      if (event.key === 'ArrowLeft') next = (isSidebar ? sidebarWidth : filesWidth) + (isSidebar ? -16 : 16);
      if (event.key === 'ArrowRight') next = (isSidebar ? sidebarWidth : filesWidth) + (isSidebar ? 16 : -16);
      if (next === null) return;
      event.preventDefault();
      apply(key, next);
    });
  };

  bind(sidebarResizer, 'sidebar');
  bind(filesResizer, 'files');
}

// Start
async function init() {
  initTheme();
  initPermissionModeUI();
  await loadPermissionMode();
  initPanelResizers();
  initTextContextMenu();
  initFilesPanel();
  initTerminalPanel();
  initMcpPanel();
  initSkillsUI();
  initJobsUI();
  loadTokenUsage();
  await loadSystemInfo();
  await refreshModelSelector();
  await loadSessionList();
  loadJobs();
}

init();
