// =============================================================================
// Session management
//
// Session list, rename, pin, archive, delete, search and the per-session
// metadata sync.
//
// Classic script. Top-level declarations land in the global lexical scope, so
// app.js and the other services keep calling these by bare name. index.html
// fixes the load order; this file runs nothing when it is evaluated.
// =============================================================================
const sessionsList = document.getElementById('sessionsList');
const newSessionBtn = document.getElementById('newSessionBtn');
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const searchResults = document.getElementById('searchResults');

function sessionVersion(session) {
  return `${Number(session?.updated) || 0}:${Number(session?.messageCount) || 0}:${session?.title || ''}:${session?.archived === true}:${session?.pinned === true}:${Number(session?.pinnedAt) || 0}:${session?.projectRoot || ''}`;
}

function rememberSessionVersions(sessions) {
  sessionSyncSnapshot.clear();
  for (const session of sessions) sessionSyncSnapshot.set(session.id, sessionVersion(session));
}

async function loadSessionList() {
  try {
    const resp = await fetch(`${API_BASE}/api/sessions`);
    const data = await resp.json();
    sessionsCache = data.sessions || [];
    rememberSessionVersions(sessionsCache);
    // If no active session, pick first or create one
    if (!currentSessionId && sessionsCache.length > 0) {
      const activeId = sessionsCache.find(s => s.id === data.activeSessionId && s.archived !== true)?.id
        || sessionsCache.find(s => s.archived !== true)?.id;
      if (activeId) await switchSession(activeId, false);
      else await createSession();
    } else if (sessionsCache.length === 0 && !currentSessionId) {
      await createSession();
    }
    renderSessionList();
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

async function syncConversationMetadata(forceCurrentRefresh = false, forceSessionId = '', changeReason = '') {
  if (sessionSyncInFlight) {
    queuedSessionSync = true;
    if (forceCurrentRefresh || forceSessionId) queuedSessionSyncSessionId = forceSessionId || currentSessionId;
    return;
  }
  sessionSyncInFlight = true;
  try {
    const response = await fetch(`${API_BASE}/api/sessions`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
    const changed = new Set();
    const nextIds = new Set(nextSessions.map((session) => session.id));

    for (const session of nextSessions) {
      if (sessionSyncSnapshot.has(session.id) && sessionSyncSnapshot.get(session.id) !== sessionVersion(session)) {
        changed.add(session.id);
      }
    }
    for (const session of sessionsCache) {
      if (!nextIds.has(session.id)) changed.add(session.id);
    }

    const oldListVersion = sessionsCache.map((session) => `${session.id}:${sessionVersion(session)}`).join('|');
    const newListVersion = nextSessions.map((session) => `${session.id}:${sessionVersion(session)}`).join('|');
    sessionsCache = nextSessions;
    rememberSessionVersions(nextSessions);

    // A paired device may delete the conversation currently open on this
    // window. Move to the newest remaining conversation instead of leaving a
    // composer attached to an id that no longer exists on disk.
    if (currentSessionId && !nextIds.has(currentSessionId)) {
      const replacement = nextSessions.find(session => session.archived !== true)?.id || '';
      currentSessionId = '';
      visibleSessionId = '';
      if (replacement) await switchSession(replacement, false);
      else await createSession();
      return;
    }

    for (const sessionId of changed) {
      if (sessionId !== currentSessionId && !sessionRuntimes.get(sessionId)?.isProcessing) sessionRuntimes.delete(sessionId);
    }
    if (oldListVersion !== newListVersion) renderSessionList();

    const archiveOnly = changeReason === 'archived' || changeReason === 'unarchived';
    const shouldRefreshCurrent = !archiveOnly && currentSessionId && (
      forceCurrentRefresh ||
      changed.has(currentSessionId) ||
      (forceSessionId && forceSessionId === currentSessionId)
    );
    if (shouldRefreshCurrent) {
      const runtime = sessionRuntimes.get(currentSessionId);
      const liveDomOwned = Boolean(runtime?.liveTurnDomOwnedUntil && runtime.liveTurnDomOwnedUntil > Date.now());
      const startupHistoryLocked = Boolean(runtime?.startupHistoryLockUntil && runtime.startupHistoryLockUntil > Date.now());
      // The streamed DOM already holds every message the store knows about.
      // Rebuilding it would re-parse the whole transcript and lay out tens of
      // thousands of nodes for nothing, so compare counts instead of trusting
      // a time window: a turn saved moments after it finished must not trigger
      // a reload just because the window elapsed.
      const storeCount = nextSessions.find(session => session.id === currentSessionId)?.messageCount;
      const domMatchesStore = Number.isInteger(storeCount) && storeCount === countRenderedMessages(currentSessionId);
      if (startupHistoryLocked) {
        // Cold-start history is already mounted. Metadata changed/forced sync
        // must update the sidebar only; rebuilding this DOM would reset scroll
        // to zero before the anchor pass can run again.
        scrollHistoryToLatest(currentSessionId);
      } else if (liveDomOwned || (!forceCurrentRefresh && domMatchesStore)) {
        // The streamed DOM already contains the server's completed turn. Keep
        // it mounted while consuming the new session metadata version.
      } else if (!runtime?.isProcessing && !isProcessing) await refreshCurrentSessionHistory(currentSessionId);
      else pendingCurrentSessionSync = true;
    }
  } catch (err) {
    console.debug('Conversation sync deferred:', err);
  } finally {
    sessionSyncInFlight = false;
    if (queuedSessionSync) {
      const queuedForceSessionId = queuedSessionSyncSessionId;
      queuedSessionSync = false;
      queuedSessionSyncSessionId = '';
      window.setTimeout(() => syncConversationMetadata(true, queuedForceSessionId), 0);
    }
  }
}

function queueConversationEvent(work) {
  conversationEventQueue = conversationEventQueue.then(work, work);
}

function beginMirroredTurn(sessionId) {
  if (!sessionId || sessionId !== currentSessionId || isProcessing) return;
  const runtime = runtimeForSession(sessionId);
  runtime.isMirroredTurn = true;
  currentAssistantMsg = addMessage('assistant', '', undefined, { streaming: true });
  currentAssistantMsg.dataset.liveSessionId = sessionId;
  currentAssistantMsg.dataset.thinkingLevel = currentThinkingLevel;
  showWaitingIndicator();
  currentToolBlocks = {};
  currentTaskToolCount = 0;
  currentTaskStartedAt = 0;
  currentTaskSummary = null;
  if (currentTaskTimer) window.clearInterval(currentTaskTimer);
  currentTaskTimer = null;
  setProcessing(true);
  snapshotActiveSessionRuntime();
}

function applyMirroredStreamEvent(payload) {
  const sessionId = String(payload?.sessionId || '');
  const event = String(payload?.event || '');
  if (!sessionId || sessionId !== currentSessionId) return;
  if (event === 'turn_started') {
    beginMirroredTurn(sessionId);
    const level = normalizeThinkingLevel(payload.data?.thinkingLevel || currentThinkingLevel);
    if (currentAssistantMsg) {
      currentAssistantMsg.dataset.thinkingLevel = level;
      if (typeof payload.data?.transcriptTurnId === 'string') currentAssistantMsg.dataset.transcriptTurnId = payload.data.transcriptTurnId;
    }
    return;
  }
  const runtime = sessionRuntimes.get(sessionId);
  // If the initial turn_started frame was missed during an SSE reconnect,
  // recover the mirrored surface from the first subsequent stream frame.
  if (!runtime?.isMirroredTurn) {
    beginMirroredTurn(sessionId);
    if (!sessionRuntimes.get(sessionId)?.isMirroredTurn) return;
  }
  handleSSEEvent(`event: ${event}\ndata: ${JSON.stringify(payload.data ?? {})}`, activeChatTurnToken);
  if (event === 'done' || event === 'error' || event === 'cancelled') {
    runtime.isMirroredTurn = false;
    protectLiveTurnDom(sessionId);
  }
  snapshotActiveSessionRuntime();
}

let subAgentView;
// Opens the sub-agent drawer when a tool result asks for it.
function installSubAgentLinkBridge() {
  window.addEventListener('iexa:open-subagent', event => { if (typeof event.detail?.id === 'string') { syncSubAgentView(); void subAgentView?.open(event.detail.id); } });
}
function syncSubAgentView() {
  const host = document.getElementById('subAgentPanel');
  if (!host || !window.IexaSubAgentView) return;
  if (!subAgentView) subAgentView = window.IexaSubAgentView.create(host, { base: API_BASE, fetch: (...args) => fetch(...args), renderMarkdown: (element, text) => renderMarkdownContent(element, text, true), onPermission: showPermissionDialog, onPermissionClose: id => window.IexaPermissionDialog?.close(id) });
  subAgentView.session(currentSessionId);
}

function startConversationSync() {
  if (conversationEventSource) return;
  conversationEventSource = new EventSource(`${API_BASE}/api/session-events?clientId=${encodeURIComponent(conversationClientId)}&stream=delta`);
  conversationEventSource.addEventListener('subagent_changed', event => { try { subAgentView?.event(JSON.parse(event.data)); } catch { /* Ignore malformed transport. */ } });
  // A timed run happens without a renderer stream, so the server announces the
  // change and the panel refreshes itself instead of waiting for a reopen.
  conversationEventSource.addEventListener('scheduled_task_changed', () => {
    if (typeof loadScheduledTasks === 'function' && scheduledTasksLoaded) void loadScheduledTasks();
  });
  conversationEventSource.addEventListener('session_changed', (event) => {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch { return; }
    queueConversationEvent(async () => {
      // The prompt is already on disk when this event arrives. Load it before
      // applying turn_started so the mirrored assistant placeholder follows it.
      await syncConversationMetadata(payload.sessionId === currentSessionId, payload.sessionId || '', payload.reason || '');
    });
  });
  conversationEventSource.addEventListener('session_stream', (event) => {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch { return; }
    queueConversationEvent(() => applyMirroredStreamEvent(payload));
  });
  conversationEventSource.onerror = () => {
    // EventSource reconnects by itself. Refresh metadata immediately so a
    // mobile browser that briefly loses Wi-Fi still catches the desktop turn.
    syncConversationMetadata(true);
  };

  // SSE reconnects automatically. This low-frequency check covers a laptop
  // waking after events were emitted while its network connection was down.
  sessionSyncTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') { syncConversationMetadata(); syncSubAgentView(); }
  }, 1500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { syncConversationMetadata(); syncSubAgentView(); }
  });
  window.addEventListener('focus', () => syncConversationMetadata());
}

function renderSessionList() {
  document.querySelector('.session-menu')?.remove();
  const visibleSessions = sessionsCache.filter(session => session.archived !== true);
  if (visibleSessions.length === 0) {
    sessionsList.innerHTML = '<div class="sessions-empty">暂无会话</div>';
    return;
  }

  const groups = new Map();
  for (const session of visibleSessions) {
    const root = session.projectRoot || '';
    const key = root.toLowerCase();
    if (!groups.has(key)) groups.set(key, { root, name: session.projectName || (root ? root.split(/[\\/]/).pop() : '无项目'), sessions: [] });
    groups.get(key).sessions.push(session);
  }
  const currentKey = String(projectRoot || '').toLowerCase();
  const orderedGroups = [...groups.values()].sort((a, b) => {
    const aCurrent = a.root.toLowerCase() === currentKey ? 1 : 0;
    const bCurrent = b.root.toLowerCase() === currentKey ? 1 : 0;
    return bCurrent - aCurrent || String(a.name).localeCompare(String(b.name), 'zh-CN');
  });
  const renderItem = (s) => {
    const active = s.id === currentSessionId ? ' active' : '';
    const pinned = s.pinned === true ? ' pinned' : '';
    const timeStr = formatTime(s.updated);
    return `
      <div class="session-item${active}${pinned}" data-id="${escapeHtml(s.id)}">
        <div class="session-item-info" data-ui-action="switchSession" data-ui-arg="${escapeHtml(s.id)}">
          <span class="session-item-title" data-sid="${escapeHtml(s.id)}" data-ui-action="startRename" data-ui-arg="${escapeHtml(s.id)}" title="${escapeHtml(s.title)}" aria-label="${escapeHtml(s.title)}，点击重命名">${escapeHtml(s.title)}</span>
          <span class="session-item-time">${sessionRuntimes.get(s.id)?.isProcessing ? '<i class="session-running-dot" title="正在进行"></i>' : ''}${timeStr}</span>
        </div>
        <button type="button" class="session-item-more" data-ui-action="openSessionMenu" data-session-menu="${escapeHtml(s.id)}" data-ui-arg="${escapeHtml(s.id)}" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${uiIcon('more')}</button>
      </div>`;
  };
  sessionsList.innerHTML = orderedGroups.map(group => {
    const sorted = [...group.sessions].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0) || Number(b.updated) - Number(a.updated));
    return `<section class="session-project-group" data-project-root="${escapeHtml(group.root)}">
      <div class="session-project-heading" title="${escapeHtml(group.root || '未绑定项目')}">${uiIcon(group.root ? 'folder' : 'chat')}<span>${escapeHtml(group.name || '无项目')}</span><b>${sorted.length}</b></div>
      <div class="session-project-items">${sorted.map(renderItem).join('')}</div>
    </section>`;
  }).join('');
}

// One dots button per row replaces the old pin/archive/delete trio. The menu is
// mounted on <body> with fixed coordinates so the scrolling sidebar cannot clip
// it, and it always closes before the chosen action runs.
function closeSessionMenu(restoreFocus = false) {
  const menu = document.querySelector('.session-menu');
  const trigger = document.querySelector('.session-item-more[aria-expanded="true"]');
  if (menu) menu.remove();
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  document.removeEventListener('pointerdown', sessionMenuOutside, true);
  document.removeEventListener('keydown', sessionMenuKeyboard, true);
  window.removeEventListener('resize', sessionMenuViewportChanged);
  window.removeEventListener('scroll', sessionMenuViewportChanged, true);
}

function sessionMenuOutside(event) {
  const menu = document.querySelector('.session-menu');
  if (!menu) return;
  if (menu.contains(event.target) || event.target.closest?.('.session-item-more')) return;
  closeSessionMenu();
}

function sessionMenuKeyboard(event) {
  if (!document.querySelector('.session-menu')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSessionMenu(true); return; }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...document.querySelectorAll('.session-menu-item')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next].focus({ preventScroll: true });
}

function sessionMenuViewportChanged() { closeSessionMenu(); }

function openSessionMenu(sessionId, trigger) {
  const button = trigger || (typeof sessionId === 'string'
    ? document.querySelector(`.session-item-more[data-session-menu="${sessionId.replace(/["\\]/g, '\\$&')}"]`)
    : sessionId);
  if (!button) return false;
  if (button.getAttribute('aria-expanded') === 'true') { closeSessionMenu(true); return true; }
  closeSessionMenu();
  const session = sessionsCache.find(item => item.id === button.dataset.sessionMenu);
  if (!session) return false;
  const id = session.id;
  const pinLabel = session.pinned === true ? '取消置顶' : '置顶会话';
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '会话操作');
  menu.innerHTML = `
    <button type="button" role="menuitem" class="session-menu-item" data-ui-action="toggleSessionPin" data-ui-arg="${escapeHtml(id)}">${uiIcon('pin')}<span>${pinLabel}</span></button>
    <button type="button" role="menuitem" class="session-menu-item" data-ui-action="archiveSession" data-ui-arg="${escapeHtml(id)}">${uiIcon('archive')}<span>存档会话</span></button>
    <div class="session-menu-sep" role="separator"></div>
    <button type="button" role="menuitem" class="session-menu-item is-danger" data-ui-action="deleteSession" data-ui-arg="${escapeHtml(id)}">${uiIcon('trash')}<span>删除会话</span></button>`;
  document.body.appendChild(menu);
  button.setAttribute('aria-expanded', 'true');

  const rect = button.getBoundingClientRect();
  const width = Math.min(184, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.querySelector('.session-menu-item')?.focus({ preventScroll: true });

  document.addEventListener('pointerdown', sessionMenuOutside, true);
  document.addEventListener('keydown', sessionMenuKeyboard, true);
  window.addEventListener('resize', sessionMenuViewportChanged);
  window.addEventListener('scroll', sessionMenuViewportChanged, true);
  return true;
}

// Titles truncate by default; on hover the text glides right-to-left so a long
// name can be read in full. text-indent keeps the original text node intact,
// which matters because clicking the title swaps in a rename input.
function armSessionTitleMarquee(title) {
  if (!title || title.classList.contains('is-marquee')) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const overflow = title.scrollWidth - title.clientWidth;
  if (overflow <= 2) return;
  const distance = overflow + 12;
  const duration = Math.max(4, Math.min(20, distance / 28 + 2));
  title.style.setProperty('--marquee-shift', `-${distance}px`);
  title.style.setProperty('--marquee-duration', `${duration.toFixed(2)}s`);
  title.classList.add('is-marquee');
}

function disarmSessionTitleMarquee(title) {
  if (!title) return;
  title.classList.remove('is-marquee');
  title.style.removeProperty('--marquee-shift');
  title.style.removeProperty('--marquee-duration');
}

async function toggleSessionPin(sessionId) {
  const session = sessionsCache.find(item => item.id === sessionId);
  if (!session) return false;
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: session.pinned !== true }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '置顶操作失败');
    const index = sessionsCache.findIndex(item => item.id === sessionId);
    if (index >= 0) sessionsCache[index] = data.session;
    renderSessionList();
    return true;
  } catch (error) { await window.IexaDialogs.alert(error.message || String(error)); return false; }
}

async function setSessionArchived(sessionId, archived) {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '存档操作失败');
    const index = sessionsCache.findIndex(session => session.id === sessionId);
    if (index >= 0) sessionsCache[index] = data.session;
    renderSessionList();
    return true;
  } catch (error) { await window.IexaDialogs.alert(error.message || String(error)); return false; }
}

async function showArchiveManager() {
  if (document.getElementById('archiveManagerDialog')) return;
  const previous = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.id = 'archiveManagerDialog'; dialog.className = 'iexa-app-dialog archive-manager';
  dialog.setAttribute('aria-label', '已存档的聊天');
  const title = document.createElement('h2'); title.textContent = '已存档的聊天';
  const list = document.createElement('div'); list.className = 'archive-manager-list';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.className = 'archive-close';
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected) previous.focus(); }, { once: true });
  const render = () => {
    list.replaceChildren();
    const archived = sessionsCache.filter(session => session.archived === true);
    if (!archived.length) { const empty = document.createElement('p'); empty.textContent = '暂无已存档的聊天'; list.append(empty); }
    for (const session of archived) {
      const row = document.createElement('div'); row.className = 'archive-manager-row';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'archive-chat-title'; open.textContent = session.title;
      open.title = '查看会话';
      open.addEventListener('click', () => { dialog.close(); switchSession(session.id); });
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = '取消存档';
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        await setSessionArchived(session.id, false);
        if (dialog.isConnected) { render(); close.focus(); }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除';
      remove.addEventListener('click', async () => { await deleteSession(session.id); if (dialog.isConnected) { render(); close.focus(); } });
      row.append(open, restore, remove); list.append(row);
    }
  };
  dialog.append(title, list, close); document.body.append(dialog);
  render(); dialog.showModal(); close.focus();
  // Refresh metadata while preserving the existing conversation / running stream.
  await syncConversationMetadata();
  if (dialog.isConnected) render();
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
    const createEpoch = sessionViewEpoch;
    const createRequest = ++sessionCreateRequest;
    const resp = await fetch(`${API_BASE}/api/sessions`, { method: 'POST' });
    const data = await resp.json();
    if (data.session) {
      if (createEpoch !== sessionViewEpoch || createRequest !== sessionCreateRequest) { await loadSessionList(); return; }
      ++sessionViewEpoch;
      snapshotActiveSessionRuntime(true);
      currentSessionId = data.session.id;
      visibleSessionId = currentSessionId;
      activatedSessionId = currentSessionId;
      syncSubAgentView();
      sessionRuntimes.set(currentSessionId, { fragment: document.createDocumentFragment(), historyReady: true, isProcessing: false, currentToolBlocks: {}, promptQueue: [] });
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

function applySessionProject(project) {
  if (!project) return;
  projectRoot = project.root || null;
  projectName = project.name || null;
  projectRecent = project.recent || projectRecent;
  filesCurrentPath = '.'; filesLastSig = ''; gitStatusSignature = ''; gitLoadEpoch++;
  if (projectRoot) loadFilesList('.', false); else showFilesEmpty(projectRecent);
  window.syncHeroWorkspace?.();
}

function activateCachedSession(id) {
  const run = async () => {
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '切换会话失败');
    if (visibleSessionId === id) { activatedSessionId = id; applySessionProject(data.project); }
    return data;
  };
  const queued = sessionActivationQueue.then(run, run);
  sessionActivationQueue = queued.catch(() => {});
  return queued;
}

// Phones keep a bounded transcript. WebKit reloads a tab once a single page
// holds enough live DOM, and a long conversation built in one pass crosses that
// line: 600 turns measured ~106k nodes and 460k px of height in a single paint.
// Mobile renders the most recent window and grafts earlier chunks on demand;
// desktop keeps rendering the whole history exactly as before.
const MOBILE_HISTORY_INITIAL = 60;
const MOBILE_HISTORY_CHUNK = 40;

function mobileHistoryWindow() {
  return document.body.dataset.mobileClient === 'paired';
}

// One history message, exactly as the transcript has always painted it.
// Extracted so the mobile window can graft an earlier chunk on demand
// without a second copy of these layout rules drifting from this one.
function renderHistoryMessage(msg, messageIndex) {
        if (msg.role === 'user') {
          addMessage('user', msg.content, msg.attachments || [], { messageIndex, timestamp: msg.timestamp });
        } else {
          const el = addMessage('assistant', msg.content, undefined, { timestamp: msg.timestamp, messageIndex });
          if (msg.thinking) {
            const thinkBlock = document.createElement('details');
            thinkBlock.className = 'thinking-block is-complete';
            thinkBlock.open = false;
            thinkBlock._reasoning = String(msg.thinking);
            const level = normalizeThinkingLevel(msg.thinkingLevel || currentThinkingLevel);
            thinkBlock.dataset.thinkingLevel = level;
            thinkBlock.innerHTML = `<summary>${uiIcon('brain')}<span class="thinking-title">思考</span><span class="thinking-effort">${escapeHtml(thinkingEffortLabelFor(level))}</span><span class="thinking-token-count">0</span><span class="thinking-chevron" aria-hidden="true"></span></summary><pre class="thinking-content"></pre>`;
            window.IexaChatActivity.prepareThinking(thinkBlock);
            const content = thinkBlock.querySelector('.thinking-content');
            updateThinkingTokenCount(thinkBlock, String(msg.thinking));
            if (content) setPagedText(content, String(msg.thinking));
            stabilizeThinkingBlockWidth(thinkBlock);
            const answer = el.querySelector('.message-content');
            if (answer) answer.before(thinkBlock); else el.appendChild(thinkBlock);
          }
          // Render tool calls if present
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const steps = document.createElement('div');
            steps.className = 'tool-steps activity-list';
            const started = msg.toolCalls.map(tc => Number(tc.startedAt || tc.result?.startedAt)).filter(Number.isFinite);
            const finished = msg.toolCalls.map(tc => Number(tc.finishedAt || tc.result?.finishedAt)).filter(Number.isFinite);
            if (started.length) steps.dataset.startedAt = String(Math.min(...started));
            const taskSummary = createTaskSummary(msg.toolCalls.length);
            // 历史会话绝不应恢复为运行状态：创建函数默认带 spinner，
            // 因此加载后必须显式收口为静态完成态。
            taskSummary.classList.add('is-complete');
            if (started.length && finished.length === msg.toolCalls.length) {
              taskSummary.querySelector('.task-summary-time').textContent = formatTaskElapsed(Math.max(...finished) - Math.min(...started));
            }
            steps.appendChild(taskSummary);
            for (const tc of msg.toolCalls) {
              const block = document.createElement('div');
              block.className = 'tool-block is-done';
              block.dataset.toolId = tc.id;
              block.dataset.kind = toolKind(tc.name || '');
              if (Number.isFinite(Number(tc.startedAt || tc.result?.startedAt))) block.dataset.startedAt = String(Number(tc.startedAt || tc.result?.startedAt));
              if (Number.isFinite(Number(tc.finishedAt || tc.result?.finishedAt))) block.dataset.finishedAt = String(Number(tc.finishedAt || tc.result?.finishedAt));
              const histTitle = (tc.args && tc.args.tool_title) || toolDisplayName(tc.name);
              block.innerHTML = `
                <div class="tool-header" data-ui-action="toggleToolBody" data-ui-arg="tool-body-${escapeHtml(tc.id)}">
                  <span class="tool-icon">${toolIcon(tc.name)}</span>
                  <span class="tool-heading"><span class="tool-name">${escapeHtml(histTitle)}</span><span class="tool-meta">${escapeHtml(toolMeta(tc.name, tc.args))}</span></span>
                  <span class="tool-status done">${uiIcon('check')}<span>完成</span></span>
                  <span class="tool-chevron" aria-hidden="true"></span>
                </div>
                <div class="tool-body" id="tool-body-${escapeHtml(tc.id)}" style="display:none;">
                  <div class="tool-section-label">输入</div><pre class="tool-args"></pre>
                </div>
              `;
              window.IexaToolLifecycleView.applyResult(block, tc.result, setToolStepStatus);
              setPagedText(block.querySelector('.tool-args'), JSON.stringify(tc.args, null, 2));
              if (tc.result) {
                const body = block.querySelector('.tool-body');
                const result = document.createElement('pre');
                result.className = 'tool-result';
                body.appendChild(result);
                setPagedText(result, tc.result.output || '');
                if (tc.result.fileChange) renderFileChange(body, tc.result.fileChange);
                if (tc.result.artifacts && tc.result.artifacts.length) {
                  // Mirror the live layout: a display_file card belongs beside
                  // its step, not appended after the usage footer.
                  if (tc.name === 'display_file') renderToolArtifactsAfterStep(block, tc.result.artifacts);
                  else renderToolArtifacts(body, tc.result.artifacts);
                }
              }
              window.IexaChatActivity.updateTool(block, tc.name, tc.args, tc.result);
              steps.appendChild(block);
            }
            refreshToolGroupSummary(steps);
            // Match the live turn layout: thinking, task/tools, then answer.
            // Appending before the footer put the task duration below the
            // completed answer whenever history was restored.
            const answer = el.querySelector('.message-content');
            const footer = assistantFooterAnchor(el);
            if (answer) el.insertBefore(steps, answer);
            else if (footer) el.insertBefore(steps, footer);
            else el.appendChild(steps);
          }
          restoreTranscriptOrder(el, msg);
          const todoPlan = latestTodoPlanFromCalls(msg.toolCalls);
          if (todoPlan) renderTodoPlan(el, todoPlan, { restored: true });
          el.dataset.transcriptTurnId = msg.transcript?.turnId || '';
          el._fileUndoPaths = msg.fileUndo?.paths || [];
          const recordedChanges = (msg.toolCalls || []).filter(call => call.result?.success && call.result.fileChange).map(call => call.result.fileChange);
          if (recordedChanges.length || msg.deliverables) renderDeliverables(el, recordedChanges.length ? recordedChanges : msg.deliverables);
          // Render usage if present
          if (msg.usage || (msg.durationMs !== undefined && msg.durationMs !== null)) {
            const durationMs = Number(msg.durationMs);
            if (Number.isFinite(durationMs) && durationMs >= 0) el.dataset.durationMs = String(durationMs);
            const generationMs = Number(msg.generationMs);
            if (Number.isFinite(generationMs) && generationMs > 0) {
              el.dataset.generationMs = String(generationMs);
              el.dataset.generationRateVersion = String(Number(msg.generationRateVersion) || 0);
              if (Number(msg.firstTokenMs) > 0) el.dataset.firstTokenMs = String(msg.firstTokenMs);
            }
            const usageEl = document.createElement('div');
            usageEl.className = 'message-usage';
            const footer = el.querySelector('.assistant-message-footer');
            const actions = el.querySelector('.assistant-message-actions');
            if (footer && actions) footer.insertBefore(usageEl, actions); else el.appendChild(usageEl);
            // Render after insertion: the metrics element reads its owning
            // message for the timestamp and the turn duration.
            renderMessageUsage(usageEl, (msg.usage && msg.usage.inputTokens) || 0, (msg.usage && msg.usage.outputTokens) || 0,
              msg.usage && msg.usage.cacheReadInputTokens, { pending: !msg.usage });
          }
          // Replayed turns land folded, like the turn looked the moment it
          // finished. The stored duration was applied just above, so the bar
          // paints the real number rather than zero.
          window.IexaTurnSummary?.settle(el);
        }
}

function showLoadEarlierAffordance(sessionId, runtime) {
  const existing = chatMessages.querySelector('.load-earlier-messages');
  if (existing) existing.remove();
  if (!mobileHistoryWindow() || !runtime || runtime.historyStartIndex <= 0) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'load-earlier-messages';
  button.textContent = `加载更早的消息（还有 ${runtime.historyStartIndex} 条）`;
  button.addEventListener('click', () => { void loadEarlierHistory(sessionId); });
  chatMessages.insertBefore(button, chatMessages.firstChild);
}

async function loadEarlierHistory(sessionId) {
  // A switch while the chunk is being built must not graft it onto another
  // conversation, so every exit re-checks which session is actually visible.
  if (sessionId !== visibleSessionId || sessionId !== currentSessionId) return;
  const runtime = runtimeForSession(sessionId);
  const messages = runtime.historyMessages;
  if (!mobileHistoryWindow() || !Array.isArray(messages) || runtime.historyStartIndex <= 0) return;
  const button = chatMessages.querySelector('.load-earlier-messages');
  if (button) { button.disabled = true; button.textContent = '正在加载…'; }

  const nextStart = Math.max(0, runtime.historyStartIndex - MOBILE_HISTORY_CHUNK);
  const added = runtime.historyStartIndex - nextStart;
  const live = chatMessages;
  // addMessage() asks the transcript to follow the newest message. While an
  // earlier chunk is being collected that request would yank the reader to the
  // bottom once the queued animation frame runs, so following is stopped first
  // and the scroll position is restored by hand below.
  stopFollowingLatestMessage();
  const previousTop = live.scrollTop;
  const previousHeight = live.scrollHeight;

  // addMessage appends to `chatMessages` and scrolls to the bottom after every
  // message. Staging the chunk in a detached container keeps that side effect
  // off the live transcript; the nodes are grafted in one batch below.
  const staging = document.createElement('div');
  const created = [];
  try {
    chatMessages = staging;
    for (let index = nextStart; index < runtime.historyStartIndex; index += 1) {
      const before = staging.childElementCount;
      renderHistoryMessage(messages[index], index);
      for (let nodeIndex = before; nodeIndex < staging.childElementCount; nodeIndex += 1) {
        const node = staging.children[nodeIndex];
        if (node) created.push(node);
      }
    }
  } catch (error) {
    // A half-built chunk is discarded rather than grafted; the affordance comes
    // back enabled so the next tap can retry.
    chatMessages = live;
    console.error('Failed to load earlier messages:', error);
    showLoadEarlierAffordance(sessionId, runtime);
    return;
  } finally {
    chatMessages = live;
  }

  if (sessionId !== visibleSessionId || sessionId !== currentSessionId) return;

  const fragment = document.createDocumentFragment();
  for (const node of created) fragment.appendChild(node);
  live.insertBefore(fragment, live.firstChild);
  runtime.historyStartIndex = nextStart;
  runtime.historyRenderedCount = (Number(runtime.historyRenderedCount) || 0) + added;
  // Keep the reader where they were: the transcript grew above the viewport.
  live.scrollTop = previousTop + (live.scrollHeight - previousHeight);
  showLoadEarlierAffordance(sessionId, runtime);
}

async function switchSession(id, updateList = true) {
  if (!id || (id === visibleSessionId && sessionRuntimes.get(id)?.historyReady)) return;
  // An edit belongs to the conversation that showed it; leaving drops the mode
  // but keeps the draft text, which the user may still want to send.
  window.cancelPendingEdit?.(false);
  const viewEpoch = ++sessionViewEpoch;
  // Switching only changes the visible surface. Background SSE streams continue.
  snapshotActiveSessionRuntime(true);
  for (const [cachedId, cached] of sessionRuntimes) {
    if (sessionRuntimes.size <= 4) break;
    if (cachedId === id || cachedId === currentSessionId || cached.isProcessing || cached.turnStopPending || cached.promptQueue?.length || pendingStreamUpdates.has(cachedId)) continue;
    if (cached.currentTaskTimer) clearInterval(cached.currentTaskTimer);
    sessionRuntimes.delete(cachedId);
  }
  currentSessionId = id;
  visibleSessionId = id;
  window.syncPausedBanner?.();
  void refreshGoalBanner();
  syncSubAgentView();
  const targetRuntime = runtimeForSession(id);
  if (targetRuntime.historyReady || targetRuntime.isProcessing) {
    mountSessionRuntime(id);
    scrollHistoryToLatest(id);
    syncActiveSessionUI();
    refreshModelSelector().catch(() => {});
    if (activatedSessionId !== id) activateCachedSession(id).catch(error => console.error('Failed to activate session:', error));
  } else {
    chatMessages = visibleChatMessages;
    applySessionRuntime(id);
    clearChat();
    const loading = document.createElement('div');
    loading.className = 'history-loading';
    loading.setAttribute('role', 'status');
    loading.textContent = '正在加载对话…';
    chatMessages.appendChild(loading);
    setProcessing(false);

  // Load messages
  try {
    const resp = await fetch(`${API_BASE}/api/sessions/${id}`);
    if (!resp.ok) throw new Error(`History HTTP ${resp.status}`);
    const data = await resp.json();
    if (activatedSessionId !== id) activateCachedSession(id).catch(error => console.error('Failed to activate session:', error));
    // A newer click selected another session while this request was in flight.
    // Do not append stale history into the current visible chat. The placeholder
    // must still be dropped on this path: an epoch bump from a newer
    // switchSession() used to strand "正在加载对话…" on screen forever.
    if (viewEpoch !== sessionViewEpoch || visibleSessionId !== id || targetRuntime.isProcessing || targetRuntime.historyReady) {
      loading.remove();
      return;
    }
    applySessionProject(data.project);
    // The session carries its request size across restarts; paint it before the
    // first turn of this process instead of leaving the ring at zero.
    applySessionContextStatus(id, data.context || null);
    clearChat();
    targetRuntime.fragment.replaceChildren();
    targetRuntime.historyReady = true;
    targetRuntime.historyRenderedCount = 0;
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
      // A long history (hundreds of messages, thousands of tool blocks) used to
      // be built in one synchronous pass: the browser then had to lay out the
      // whole subtree before it could paint, freezing the window for seconds.
      // Yield to the next frame once a batch exceeds the frame budget so the
      // transcript paints progressively and stays interactive.
      const windowed = mobileHistoryWindow();
      const startIndex = windowed ? Math.max(0, msgs.length - MOBILE_HISTORY_INITIAL) : 0;
      let batchStartedAt = performance.now();
      for (let messageIndex = startIndex; messageIndex < msgs.length; messageIndex++) {
        if (performance.now() - batchStartedAt > 8) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
          if (viewEpoch !== sessionViewEpoch || visibleSessionId !== id) {
            targetRuntime.historyReady = false;
            return;
          }
          batchStartedAt = performance.now();
        }
        renderHistoryMessage(msgs[messageIndex], messageIndex);
      }
      targetRuntime.historyMessages = msgs;
      targetRuntime.historyStartIndex = startIndex;
      targetRuntime.historyRenderedCount = msgs.length - startIndex;
      if (startIndex > 0) showLoadEarlierAffordance(id, targetRuntime);
      // A turn that was still running when the process died is now on disk as
      // `interrupted`. Surface it so the user can continue instead of assuming
      // the work was lost.
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
      const unfinished = lastAssistant && ['running', 'paused', 'interrupted'].includes(lastAssistant.status);
      targetRuntime.interruptedTurn = unfinished ? {
        status: lastAssistant.status,
        toolCalls: (lastAssistant.toolCalls || []).filter((tc) => tc.result).length,
        at: Number(lastAssistant.timestamp) || 0,
      } : null;
      // Mark the restored bubble so 继续 revives it instead of appending a new one.
      if (unfinished) {
        const bubbles = chatMessages.querySelectorAll('.message.assistant');
        const lastBubble = bubbles[bubbles.length - 1];
        if (lastBubble) lastBubble.dataset.parkedTurn = '1';
      }
      window.syncPausedBanner?.();
    }
  } catch (err) {
    console.error('Failed to load messages:', err);
    if (viewEpoch !== sessionViewEpoch || visibleSessionId !== id || targetRuntime.isProcessing || targetRuntime.historyReady) {
      loading.remove();
      return;
    }
    chatMessages.replaceChildren();
    const retry = document.createElement('button');
    retry.className = 'history-loading';
    retry.textContent = '对话加载失败，点击重试';
    retry.addEventListener('click', () => switchSession(id));
    chatMessages.appendChild(retry);
  }
  snapshotActiveSessionRuntime();
  scrollHistoryToLatest(id);
  }

  // Reconcile live ask_user cards when re-opening a conversation that is still running.
  if (window.IexaQuestionCard && runtimeForSession(id)?.isProcessing) {
    window.IexaQuestionCard.syncPending(id, Object.assign(questionCardOptions(), {
      isCurrent: () => visibleSessionId === id && currentSessionId === id,
    }));
  }

  // The composer always describes the selected conversation's pinned route.
  refreshModelSelector().catch(() => {});

  if (updateList) renderSessionList();
}

async function deleteSession(id) {
  if (!(await window.IexaDialogs.confirm('确定删除这个会话？'))) return;

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
    span.title = newTitle;
    span.setAttribute('aria-label', `${newTitle}，点击重命名`);
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
  chatMessages.replaceChildren();
  isNearChatBottom = true;
  updateScrollToBottomButton();
  currentAssistantMsg = null;
  currentToolBlocks = {};
  promptQueue = [];
  isDrainingQueue = false;
  suppressQueueDrain = false;
}

/**
 * Remove transcript DOM from a branch point, without refetching the session.
 *
 * `keepBranchPoint=false` also drops the clicked bubble itself, which matches a
 * server reset sent with `retainSelected: false` (the prompt is re-persisted by
 * the following /api/chat). `keepBranchPoint=true` mirrors `retainSelected: true`.
 */
function truncateTranscriptFrom(branchEl, keepBranchPoint) {
  if (!branchEl) return;
  let node = keepBranchPoint ? branchEl.nextElementSibling : branchEl;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
}

/**
 * Drop per-turn bookkeeping while leaving the transcript DOM untouched.
 *
 * Branch operations (reset / resend) edit the visible transcript in place, so
 * they must not go through clearChat(), which would wipe the kept messages.
 */
function resetTurnBookkeeping() {
  currentAssistantMsg = null;
  currentToolBlocks = {};
  currentTaskSummary = null;
  currentTaskToolCount = 0;
  currentTaskStartedAt = 0;
  if (currentTaskTimer) {
    window.clearInterval(currentTaskTimer);
    currentTaskTimer = null;
  }
  isNearChatBottom = true;
  updateScrollToBottomButton();
  snapshotActiveSessionRuntime();
}

function showWelcome() {
  const template = document.createElement('template');
  template.innerHTML = `
    <div class="welcome">
      <div class="welcome-head">
        <img class="welcome-logo" src="mobile-pair-logo.png" width="34" height="34" alt="IEXA">
        <h2>今天想构建什么？</h2>
      </div>
      <p>从一个想法、一处问题，或一个项目开始。</p>
      <div class="quick-actions">
        <button class="quick-btn" data-ui-action="sendQuick" data-ui-arg="列出当前目录的文件">${uiIcon('folder')}<span>列出文件</span></button>
        <button class="quick-btn" data-ui-action="sendQuick" data-ui-arg="我的操作系统和硬件配置是什么？">${uiIcon('monitor')}<span>系统信息</span></button>
        <button class="quick-btn" data-ui-action="sendQuick" data-ui-arg="创建一个简单的 Python Web 服务器脚本">${uiIcon('code')}<span>生成 Python 脚本</span></button>
      </div>
    </div>
  `;
  chatMessages.replaceChildren(template.content);
}

// Event: New session button
function installSessionListControls() {
  newSessionBtn.addEventListener('click', () => createSession());
  sessionsList?.addEventListener('pointerover', event => {
    const title = event.target.closest?.('.session-item-title');
    if (!title || !sessionsList.contains(title)) return;
    if (event.relatedTarget && title.contains(event.relatedTarget)) return;
    armSessionTitleMarquee(title);
  });
  sessionsList?.addEventListener('pointerout', event => {
    const title = event.target.closest?.('.session-item-title');
    if (!title) return;
    if (event.relatedTarget && title.contains(event.relatedTarget)) return;
    disarmSessionTitleMarquee(title);
  });
  sessionsList?.addEventListener('scroll', () => closeSessionMenu(), { passive: true });
  // Runs after app.js's capture handler on the same node: the menu is removed
  // before the queued action reads the session id it was clicked for.
  document.addEventListener('click', event => {
    if (event.target.closest?.('.session-menu [data-ui-action]')) closeSessionMenu();
  }, true);
}

// Called once from app.js init(); the module installs no listeners on load.
function initSessionListModule() {
  installSubAgentLinkBridge();
  installSessionListControls();
}
