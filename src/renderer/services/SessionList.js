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

// ---------------------------------------------------------------------------
// Collapsed project groups
//
// The sidebar keeps one group per project. A machine with a dozen projects
// turns that into a wall of rows, so each group can be folded to a single
// header. The folded set is stored as project roots rather than indexes: it
// survives reordering, renames and newly added projects, and an empty string
// covers the "no project" bucket.
// ---------------------------------------------------------------------------
const COLLAPSED_PROJECTS_KEY = 'iexa-collapsed-projects';

function readCollapsedProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((value) => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedProjects(collapsed) {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage full or disabled: the fold still works for this session.
  }
}

// ---------------------------------------------------------------------------
// Sidebar categories
//
// A category is a user-named group in the sidebar. It is independent of the
// open project folder: opening a folder changes the file workbench and nothing
// else, so several folders can share a category and Uncategorized holds every
// conversation the user has not filed yet.
// ---------------------------------------------------------------------------
let sidebarCategoryCache = [];

function sidebarCategories() {
  return sidebarCategoryCache;
}

function setSidebarCategories(list) {
  sidebarCategoryCache = Array.isArray(list) ? list : [];
}

async function loadSidebarCategories() {
  try {
    const resp = await fetch(`${API_BASE}/api/categories`, { cache: 'no-store' });
    if (!resp.ok) return sidebarCategoryCache;
    const data = await resp.json();
    setSidebarCategories(data.categories);
    return sidebarCategoryCache;
  } catch {
    return sidebarCategoryCache;
  }
}

async function createSidebarCategory(name) {
  const resp = await fetch(`${API_BASE}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || IexaI18n.t('session.categoryCreateFailed'));
  setSidebarCategories(data.categories);
  renderSessionList();
  return data.category;
}

async function renameSidebarCategory(id, name) {
  const resp = await fetch(`${API_BASE}/api/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || IexaI18n.t('session.categoryCreateFailed'));
  setSidebarCategories(data.categories);
  renderSessionList();
}

async function deleteSidebarCategory(id) {
  const resp = await fetch(`${API_BASE}/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || IexaI18n.t('session.categoryCreateFailed'));
  setSidebarCategories(data.categories);
  await loadSessionList();
}

async function assignSessionCategory(sessionId, categoryId) {
  const resp = await fetch(`${API_BASE}/api/sessions/category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, categoryId: categoryId || '' }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || IexaI18n.t('session.categoryCreateFailed'));
  const cached = sessionsCache.find(session => session.id === sessionId);
  if (cached) cached.categoryId = categoryId || '';
  renderSessionList();
}


/** Sessions whose assistant is composing an unprompted line right now. */
const naturalSpeakingSessions = new Set();

/**
 * 她此刻是不是正在说话——给标题栏的「对方正在输入」用。
 *
 * 两个来源：服务端广播的 natural_speaking（模型正在生成），以及前端的
 * naturalPacing（已经生成完，正按 3-7 秒的节奏往外吐气泡）。少算第二个的话，
 * 提示会在第一句出现时就消失，后面十几秒像卡住了。
 *
 * 只认当前会话：别的会话在说，不该在这里亮。
 */
function isNaturalSpeakingNow(sessionId) {
  const id = sessionId || currentSessionId;
  if (!id) return false;
  if (naturalSpeakingSessions.has(id)) return true;
  const runtime = sessionRuntimes.get(id);
  return runtime?.naturalPacing === true;
}

function setNaturalSpeaking(sessionId, speaking) {
  if (!sessionId) return;
  const had = naturalSpeakingSessions.has(sessionId);
  if (speaking) {
    naturalSpeakingSessions.add(sessionId);
  } else {
    naturalSpeakingSessions.delete(sessionId);
    // The list response carries `speaking: true` while she talks, and that copy
    // stays in sessionsCache. Without clearing it here the mark survived the
    // stop event and stayed on screen until something else changed the row.
    const cached = sessionsCache.find((entry) => entry.id === sessionId);
    if (cached && cached.speaking === true) delete cached.speaking;
  }
  if (had !== speaking) renderSessionList();
}

function sessionVersion(session) {
  // `updated` is deliberately absent: the server touches it on every metadata
  // read, so including it made every 1.5s poll look like a change and repaint
  // the sidebar. Message count plus the visible fields already move whenever
  // anything the list actually shows changes.
  return `${Number(session?.messageCount) || 0}:${session?.title || ''}:${session?.archived === true}:${session?.pinned === true}:${Number(session?.pinnedAt) || 0}:${session?.locked === true}:${session?.projectRoot || ''}:${session?.categoryId || ''}`;
}

function rememberSessionVersions(sessions) {
  sessionSyncSnapshot.clear();
  for (const session of sessions) sessionSyncSnapshot.set(session.id, sessionVersion(session));
}

async function loadSessionList() {
  try {
    const [resp] = await Promise.all([
      fetch(`${API_BASE}/api/sessions`),
      loadSidebarCategories(),
    ]);
    const data = await resp.json();
    sessionsCache = data.sessions || [];
    rememberSessionVersions(sessionsCache);
    // If no active session, pick first or create one
    if (!currentSessionId && sessionsCache.length > 0) {
      // The mode is the user's last choice, and it outranks the server's
      // activeSessionId: that field records whichever conversation was open when
      // the process stopped, which is often a standard one. Restoring it while
      // the sidebar is on natural chat showed the wrong transcript under the
      // right label.
      const naturalMode = window.IexaNaturalChat?.currentChatMode() === 'natural';
      const usable = sessionsCache.filter((session) => session.archived !== true);
      const activeId = (naturalMode
        ? usable.find((session) => session.natural === true)?.id
        : usable.find((session) => session.id === data.activeSessionId && session.natural !== true)?.id
          || usable.find((session) => session.natural !== true)?.id)
        || usable.find((session) => session.id === data.activeSessionId)?.id
        || usable[0]?.id;
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
    // The badge reads from sessionsCache, so it follows every list refresh -
    // including one triggered by a reconnect after the tab was asleep.
    window.IexaNaturalChat?.renderUnreadBadge?.();

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
      } else if (liveDomOwned || domMatchesStore) {
        // The streamed DOM already contains the server's completed turn. Keep
        // it mounted while consuming the new session metadata version.
      } else if (!runtime?.isProcessing && !isProcessing
        && runtime?.naturalPacing !== true
        && Number.isInteger(storeCount)
        && storeCount > countRenderedMessages(currentSessionId)) {
        // Rebuild only when the stored transcript now holds MORE bubbles than
        // the mounted DOM. Any other mismatch - equal counts, or a DOM that
        // carries local notices the store never saved - would tear down and
        // re-lay out the whole transcript for no visible change, which is what
        // read as the chat reloading itself whenever the window regained focus.
        await refreshCurrentSessionHistory(currentSessionId);
      } else pendingCurrentSessionSync = true;
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
  // 刷新之后，这一轮已经由磁盘上的检查点渲染出来了，带 parkedTurn 标记。
  // 直接接管那个气泡继续往里写，不要另开一个——否则同一段回复会出现两次。
  const last = chatMessages.lastElementChild;
  const adopt = last
    && last.classList.contains('message')
    && last.classList.contains('assistant')
    && last.dataset.parkedTurn === '1'
    ? last
    : null;
  if (adopt) {
    currentAssistantMsg = adopt;
    delete adopt.dataset.parkedTurn;
    adopt.classList.add('is-streaming');
    adopt.classList.remove('is-filtered-out');
    adopt.dataset.liveSessionId = sessionId;
    // 这一轮其实还在跑，不是中断，把「继续」横幅撤掉。
    runtime.interruptedTurn = null;
    window.syncPausedBanner?.();
  } else {
    currentAssistantMsg = addMessage('assistant', '', undefined, { streaming: true });
    currentAssistantMsg.dataset.liveSessionId = sessionId;
  }
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
    // She is composing an unprompted line. The sidebar shows this with its own
    // mark, so a self-initiated message never reads as a task the user started.
    if (payload.reason === 'natural_speaking') {
      setNaturalSpeaking(payload.sessionId, payload.speaking === true);
      return;
    }
    // An unprompted natural line is already a finished message, not a metadata
    // change. Append it in place so the transcript keeps its scroll position
    // instead of being rebuilt from disk.
    // Natural chat delivers one reply as several bursts with pauses between
    // them, so the transcript must not be rebuilt while they arrive.
    if (payload.reason === 'natural_segments' && Array.isArray(payload.segments)) {
      if (payload.sessionId === currentSessionId) {
        void appendNaturalBursts(payload.segments, payload.unprompted === true);
        // The lines are on screen, so tell the server they have been read.
        void window.IexaNaturalChat?.markRead?.(payload.sessionId);
      }
      return;
    }
    if (payload.reason === 'natural_message' && typeof payload.text === 'string') {
      if (payload.sessionId === currentSessionId) appendNaturalLine(payload.text);
      return;
    }
    // `natural` means the stored reply is still a single paragraph: the
    // segmented lines arrive in their own event moments later. Rebuilding now
    // would paint that paragraph and then the bursts on top of it.
    if (payload.reason === 'turn_finished' && payload.natural === true) return;
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
  // EventSource reconnects by itself. Metadata is re-read after a drop, but
  // never with force: a tab that was hidden, minimised or asleep comes back
  // with the transcript still mounted, and forcing a refresh rebuilt the whole
  // DOM even when nothing had changed - that rewrite is what looked like the
  // chat reloading itself every time the window regained focus.
  let eventStreamOpened = false;
  conversationEventSource.onopen = () => {
    if (!eventStreamOpened) { eventStreamOpened = true; return; }
    syncConversationMetadata();
  };
  conversationEventSource.onerror = () => { syncConversationMetadata(); };

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

/**
 * Both chevrons ship in the markup and CSS picks one from the group's
 * `is-collapsed` class. Choosing the glyph at render time did not work: folding
 * a group only toggles a class, so the arrow stayed frozen on whatever state
 * the last render saw.
 */
function sessionChevronMarkup() {
  return '<svg class="ui-icon ui-icon-chevron-down session-chevron-open" aria-hidden="true"><use href="#ui-chevron-down"></use></svg>'
    + '<svg class="ui-icon ui-icon-chevron-right session-chevron-closed" aria-hidden="true"><use href="#ui-chevron-right"></use></svg>';
}

function renderSessionList() {
  document.querySelector('.session-menu')?.remove();
  // The list is rebuilt wholesale: every node inside the scroller is replaced,
  // and the browser then re-anchors that scroller wherever it likes. That is the
  // jump felt on every click - one conversation, one view switch. Remember the
  // offset, hand it back after the swap, and once more on the next frame while
  // the lazy layout settles.
  const scroller = document.getElementById('sidebarScroll');
  const keptTop = scroller ? scroller.scrollTop : 0;
  const visibleSessions = sessionsCache.filter(session => session.archived !== true);
  const naturalMode = window.IexaNaturalChat?.currentChatMode() === 'natural';
  // Natural chat is its own list: one continuous conversation, no categories,
  // and standard threads never appear inside it.
  const scopedSessions = naturalMode
    ? visibleSessions.filter((session) => session.natural === true)
    : visibleSessions.filter((session) => session.natural !== true);
  const categories = naturalMode ? [] : sidebarCategories();
  // A named category has to render even while it is still empty, otherwise a
  // group created a moment ago looks like it was never saved.
  if (scopedSessions.length === 0 && categories.length === 0) {
    sessionsList.innerHTML = '<div class="sessions-empty">'
      + (naturalMode ? '还没有小楠(Preview)' : IexaI18n.t('ui.2'))
      + '</div>';
    restoreSidebarScroll(scroller, keptTop);
    return;
  }

  // Group by sidebar category first. The file project is a workbench scope, so
  // several different folders can share one category and Uncategorized holds
  // everything the user has not filed yet.
  const groups = new Map();
  if (naturalMode) {
    groups.set('', { root: '', name: '小楠(Preview)', sessions: [] });
  } else {
    for (const category of categories) {
      groups.set(String(category.id), { root: String(category.id), name: category.name, sessions: [] });
    }
  }
  for (const session of scopedSessions) {
    const categoryId = String(session.categoryId || '');
    const known = categoryId ? categories.find(entry => entry.id === categoryId) : null;
    const key = known ? categoryId : '';
    if (!groups.has(key)) {
      groups.set(key, {
        root: key,
        name: known ? known.name : IexaI18n.t('session.noProject'),
        sessions: [],
      });
    }
    groups.get(key).sessions.push(session);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => {
    // Uncategorized always trails the named categories.
    if (!a.root) return 1;
    if (!b.root) return -1;
    return String(a.name).localeCompare(String(b.name), 'zh-CN');
  });
  const renderItem = (s) => {
    const active = s.id === currentSessionId ? ' active' : '';
    const pinned = s.pinned === true ? ' pinned' : '';
    // A background session can keep streaming while another chat is open, so
    // the running state has to come from that session's runtime, not from the
    // global `isProcessing` flag the composer reads.
    // Breathing wins while she is still delivering her own lines: the model may
    // already be finished, but she has not stopped talking yet. A reply the user
    // asked for keeps the working ring for the whole pacing window.
    const runtime = sessionRuntimes.get(s.id);
    const selfPacing = runtime?.naturalPacing === true && runtime?.naturalUnprompted === true;
    const speaking = naturalSpeakingSessions.has(s.id) || s.speaking === true || selfPacing;
    const running = !speaking && (runtime?.isProcessing === true || runtime?.naturalPacing === true);
    const timeStr = formatTime(s.created || s.updated);
    return `
      <div class="session-item${active}${pinned}${running ? ' is-running' : ''}${speaking ? ' is-natural-speaking' : ''}" data-id="${escapeHtml(s.id)}">
        <div class="session-item-info" data-ui-action="switchSession" data-ui-arg="${escapeHtml(s.id)}">
          <span class="session-item-title" data-sid="${escapeHtml(s.id)}" title="${escapeHtml(s.title)}" aria-label="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
          <span class="session-item-time">${speaking ? '<i class="session-speaking-bars" title="' + IexaI18n.t('session.speaking') + '"><b></b><b></b><b></b></i>' : running ? '<i class="session-running-dot" title="' + IexaI18n.t('session.running') + '"></i>' : ''}${timeStr}</span>
        </div>
        <button type="button" class="session-item-more" data-ui-action="openSessionMenu" data-session-menu="${escapeHtml(s.id)}" data-ui-arg="${escapeHtml(s.id)}" title="${IexaI18n.t('session.more')}" aria-label="${IexaI18n.t('session.more')}" aria-haspopup="menu" aria-expanded="false">${uiIcon('more')}</button>
      </div>`;
  };
  const collapsedProjects = readCollapsedProjects();
  sessionsList.innerHTML = orderedGroups.map(group => {
    const sorted = [...group.sessions].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)
      || (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0)
      // Ordered by when the conversation was STARTED. Sorting on `updated` made
      // the list reshuffle whenever a session was merely opened, which is what
      // looked like the order changing on its own.
      || (Number(b.created) || Number(b.updated) || 0) - (Number(a.created) || Number(a.updated) || 0));
    // A folded group that holds the open conversation unfolds itself: hiding the
    // row you are currently in reads as a bug, not as a tidy sidebar. The stored
    // preference stays untouched, so it folds again once you move elsewhere.
    const groupKey = String(group.root || '').toLowerCase();
    const holdsActive = sorted.some(session => session.id === currentSessionId);
    const collapsed = collapsedProjects.has(groupKey) && !holdsActive;
    const title = escapeHtml(group.name || IexaI18n.t('session.noProject'));
    // Named categories get rename/delete affordances; Uncategorized is a fixed
    // bucket and only its rows can be filed elsewhere.
    const groupTools = group.root
      ? `<button type="button" class="session-project-tool" data-category-rename="${escapeHtml(group.root)}" title="${IexaI18n.t('session.categoryRename')}" aria-label="${IexaI18n.t('session.categoryRename')}">${uiIcon('edit')}</button>` +
        `<button type="button" class="session-project-tool is-danger" data-category-delete="${escapeHtml(group.root)}" title="${IexaI18n.t('session.categoryDelete')}" aria-label="${IexaI18n.t('session.categoryDelete')}">${uiIcon('trash')}</button>`
      : '';
    return `<section class="session-project-group${collapsed ? ' is-collapsed' : ''}${naturalMode ? ' is-natural' : ''}" data-project-root="${escapeHtml(group.root)}">
      <div class="session-project-head">
        <button type="button" class="session-project-heading" data-project-toggle="${escapeHtml(group.root)}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${title}">${sessionChevronMarkup()}${uiIcon(group.root ? 'folder' : 'chat')}<span>${escapeHtml(group.name || IexaI18n.t('session.noProject'))}</span><b>${sorted.length}</b></button>
        ${groupTools}
      </div>
      <div class="session-project-items">${sorted.map(renderItem).join('')}</div>
    </section>`;
  }).join('');
  restoreSidebarScroll(scroller, keptTop);
}

/** Put the sidebar back where the reader had it after the list was rebuilt. */
function restoreSidebarScroll(scroller, top) {
  if (!scroller || !top) return;
  scroller.scrollTop = top;
  requestAnimationFrame(() => {
    if (document.getElementById('sidebarScroll') === scroller) scroller.scrollTop = top;
  });
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
  const pinLabel = session.pinned === true ? IexaI18n.t('session.unpin') : IexaI18n.t('session.pin');
  const locked = session.locked === true;
  const lockLabel = locked ? IexaI18n.t('session.unlock') : IexaI18n.t('session.lock');
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', IexaI18n.t('session.actions'));
  const currentSession = sessionsCache.find(entry => entry.id === id);
  const currentCategory = String(currentSession?.categoryId || '');
  // Categories belong to the standard list. A natural conversation lives outside
  // them, so filing it into one would make it appear in the other sidebar.
  const naturalMode = window.IexaNaturalChat?.currentChatMode() === 'natural';
  const categoryButtons = naturalMode ? '' : [{ id: '', name: IexaI18n.t('session.noProject') }, ...sidebarCategories()]
    .map(entry => `<button type="button" role="menuitemradio" aria-checked="${entry.id === currentCategory ? 'true' : 'false'}"
        class="session-menu-item${entry.id === currentCategory ? ' is-checked' : ''}"
        data-ui-action="moveSessionCategory" data-ui-arg="${escapeHtml(id)}" data-category-id="${escapeHtml(entry.id)}">${uiIcon('folder')}<span>${escapeHtml(entry.name)}</span></button>`)
    .join('');
  menu.innerHTML = `
    <button type="button" role="menuitem" class="session-menu-item" data-ui-action="toggleSessionLock" data-ui-arg="${escapeHtml(id)}">${uiIcon('lock')}<span>${lockLabel}</span></button>
    <button type="button" role="menuitem" class="session-menu-item" data-ui-action="startRename" data-ui-arg="${escapeHtml(id)}">${uiIcon('edit')}<span>${IexaI18n.t('session.rename')}</span></button>
    <button type="button" role="menuitem" class="session-menu-item" data-ui-action="toggleSessionPin" data-ui-arg="${escapeHtml(id)}">${uiIcon('pin')}<span>${pinLabel}</span></button>
    <button type="button" role="menuitem" class="session-menu-item" data-ui-action="archiveSession" data-ui-arg="${escapeHtml(id)}">${uiIcon('archive')}<span>${IexaI18n.t('session.archive')}</span></button>
    <div class="session-menu-sep" role="separator"></div>
    ${categoryButtons ? `<div class="session-menu-label">${IexaI18n.t('session.moveToCategory')}</div>
    ${categoryButtons}
    <div class="session-menu-sep" role="separator"></div>` : ''}
    <button type="button" role="menuitem" class="session-menu-item is-danger${locked ? ' is-disabled' : ''}" data-ui-action="deleteSession" data-ui-arg="${escapeHtml(id)}"${locked ? ' disabled aria-disabled="true"' : ''}>${uiIcon('trash')}<span>${IexaI18n.t('session.delete')}</span></button>`;
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
    if (!response.ok) throw new Error(data.error || IexaI18n.t('session.pinFailed'));
    const index = sessionsCache.findIndex(item => item.id === sessionId);
    if (index >= 0) sessionsCache[index] = data.session;
    renderSessionList();
    return true;
  } catch (error) { await window.IexaDialogs.alert(error.message || String(error)); return false; }
}

async function toggleSessionLock(sessionId) {
  const session = sessionsCache.find(item => item.id === sessionId);
  if (!session) return false;
  const next = session.locked !== true;
  // 只有解锁要确认：锁上不会丢东西，解开才会把删除放出来。
  if (!next && !(await window.IexaDialogs.confirm(IexaI18n.t('session.confirmUnlock')))) return false;
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: next }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || IexaI18n.t('session.lockFailed'));
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
    if (!response.ok) throw new Error(data.error || IexaI18n.t('session.archiveFailed'));
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
  dialog.setAttribute('aria-label', IexaI18n.t('session.archivedTitle'));
  const title = document.createElement('h2'); title.textContent = IexaI18n.t('session.archivedTitle');
  const list = document.createElement('div'); list.className = 'archive-manager-list';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = IexaI18n.t('msg.close'); close.className = 'archive-close';
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected) previous.focus(); }, { once: true });
  const render = () => {
    list.replaceChildren();
    const archived = sessionsCache.filter(session => session.archived === true);
    if (!archived.length) { const empty = document.createElement('p'); empty.textContent = IexaI18n.t('session.archivedEmpty'); list.append(empty); }
    for (const session of archived) {
      const row = document.createElement('div'); row.className = 'archive-manager-row';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'archive-chat-title'; open.textContent = session.title;
      open.title = IexaI18n.t('session.view');
      open.addEventListener('click', () => { dialog.close(); switchSession(session.id); });
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = IexaI18n.t('session.unarchive');
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        await setSessionArchived(session.id, false);
        if (dialog.isConnected) { render(); close.focus(); }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = IexaI18n.t('ui.56');
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

  if (diffMin < 1) return IexaI18n.t('time.justNow');
  if (diffMin < 60) return IexaI18n.t('time.minutesAgo', { count: diffMin });
  if (diffHr < 24) return IexaI18n.t('time.hoursAgo', { count: diffHr });
  if (diffDay < 7) return IexaI18n.t('time.daysAgo', { count: diffDay });
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
  // 小楠只有一条对话，任何「新建」都会跟它抢位置：服务端会把那条原样退回来，
  // 界面却照样重新挂载、清屏、跳到欢迎页——看着就像聊天被重置了。
  // 按钮已经停用，这里再挡一道，Ctrl+N、命令面板和将来任何调用点都进不来。
  // 切回 Agent 时 chatMode 已经是 standard，那条回退路径不受影响。
  if (window.IexaNaturalChat?.currentChatMode?.() === 'natural') return;
  try {
    // A new session must not cancel a different session running in background.
    const createEpoch = sessionViewEpoch;
    const createRequest = ++sessionCreateRequest;
    // 伴侣聊天原本也走这条路，只是带上 natural 标记。现在小楠模式在上面就返回了，
    // 这个分支只为防御未来有人绕过守卫——留着比删掉安全，代价是三行。
    const naturalMode = window.IexaNaturalChat?.currentChatMode?.() === 'natural';
    const resp = await fetch(`${API_BASE}/api/sessions`, naturalMode
      ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ natural: true }),
      }
      : { method: 'POST' });
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
  if (typeof syncIDEProject === 'function') void syncIDEProject();
  filesCurrentPath = '.'; filesLastSig = ''; gitStatusSignature = ''; gitLoadEpoch++;
  if (projectRoot) loadFilesList('.', false); else showFilesEmpty(projectRecent);
  window.syncHeroWorkspace?.();
}

function activateCachedSession(id) {
  const run = async () => {
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || IexaI18n.t('session.switchFailed'));
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

// Windowing used to be a mobile-only concession. A cold start on desktop is
// the worst case (hundreds of messages), so every transcript mounts one
// window and grafts older chunks as the reader scrolls up.
function mobileHistoryWindow() {
  return true;
}

// Estimated height of a message that is not mounted. Good enough to keep the
// scrollbar honest without building the DOM behind it.
const HISTORY_SPACER_ESTIMATE = 72;

function updateHistorySpacer(runtime) {
  if (!runtime) return;
  let spacer = chatMessages.querySelector(".history-spacer");
  if (runtime.historyStartIndex > 0) {
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.className = "history-spacer";
      spacer.setAttribute("aria-hidden", "true");
      chatMessages.insertBefore(spacer, chatMessages.firstChild);
    }
    // Zero height on purpose. The spacer used to reserve an estimated height for
    // every unloaded message, which painted as a screen of empty space above the
    // "load earlier" button. Scroll continuity is handled by restoring scrollTop
    // around the insert instead, so the element only serves as an anchor now.
    spacer.style.height = '0px';
  } else if (spacer) {
    spacer.remove();
  }
}

// One history message, exactly as the transcript has always painted it.
// Extracted so the mobile window can graft an earlier chunk on demand
// without a second copy of these layout rules drifting from this one.
function renderHistoryMessage(msg, messageIndex) {
        if (msg.role === 'user') {
          addMessage('user', msg.content, msg.attachments || [], { messageIndex, timestamp: msg.timestamp });
        } else {
          // `hasToolCalls` / `hasThinking` tell addMessage the bubble has real
          // progress even when the text is empty - a turn interrupted mid-flight
          // stores its tool steps but no answer text.
          const el = addMessage('assistant', msg.content, undefined, {
            timestamp: msg.timestamp,
            messageIndex,
            hasToolCalls: Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0,
            hasThinking: Boolean(String(msg.thinking || '').trim()),
          });
          if (msg.thinking) {
            const thinkBlock = document.createElement('details');
            thinkBlock.className = 'thinking-block is-complete';
            thinkBlock.open = false;
            thinkBlock._reasoning = String(msg.thinking);
            const level = normalizeThinkingLevel(msg.thinkingLevel || currentThinkingLevel);
            thinkBlock.dataset.thinkingLevel = level;
            thinkBlock.innerHTML = `<summary>${uiIcon('brain')}<span class="thinking-title">${IexaI18n.t('msg.thinking')}</span><span class="thinking-effort">${escapeHtml(thinkingEffortLabelFor(level))}</span><span class="thinking-token-count">0</span><span class="thinking-chevron" aria-hidden="true"></span></summary><pre class="thinking-content"></pre>`;
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
            // 没跑完的回合保留进行态，跑完的收口成静态完成态。
            //
            // 原来无条件加 is-complete：重启后那条 running 的任务显示成「已完成」，
            // 用户看不到断在哪一步，以为进度丢了。spinner 只在真正未完成时才转。
            const unfinishedTurn = ['running', 'paused', 'interrupted'].includes(msg.status);
            if (!unfinishedTurn) taskSummary.classList.add('is-complete');
            if (started.length && finished.length === msg.toolCalls.length) {
              taskSummary.querySelector('.task-summary-time').textContent = formatTaskElapsed(Math.max(...finished) - Math.min(...started));
            }
            steps.appendChild(taskSummary);
            for (const tc of msg.toolCalls) {
              const block = document.createElement('div');
              // 有 result 才算跑完。中断的回合里最后几个工具没有结果，
              // 硬标 is-done 会让它们看起来已经执行过。
              block.className = 'tool-block' + (tc.result ? ' is-done' : '');
              block.dataset.toolId = tc.id;
              block.dataset.kind = toolKind(tc.name || '');
              if (Number.isFinite(Number(tc.startedAt || tc.result?.startedAt))) block.dataset.startedAt = String(Number(tc.startedAt || tc.result?.startedAt));
              if (Number.isFinite(Number(tc.finishedAt || tc.result?.finishedAt))) block.dataset.finishedAt = String(Number(tc.finishedAt || tc.result?.finishedAt));
              const histTitle = toolDisplayName(tc.name);
              const histElapsed = Number(tc.result?.durationMs || 0);
              block.innerHTML = `
                <div class="tool-header" data-ui-action="toggleToolBody" data-ui-arg="tool-body-${escapeHtml(tc.id)}">
                  <span class="tool-icon">${toolIcon(tc.name)}</span>
                  <span class="tool-heading"><span class="tool-name">${escapeHtml(histTitle)}</span><span class="tool-meta">${escapeHtml(toolMeta(tc.name, tc.args))}</span></span>
                  <span class="tool-status done">${histElapsed ? escapeHtml(formatTaskElapsed(histElapsed)) : ''}</span>
                  <span class="tool-chevron" aria-hidden="true"></span>
                </div>
                <div class="tool-body" id="tool-body-${escapeHtml(tc.id)}" style="display:none;">
                  ${window.IexaToolCard ? window.IexaToolCard.bodyMarkup(tc.id) : '<pre class="tool-args"></pre>'}
                </div>
              `;
              window.IexaToolLifecycleView.applyResult(block, tc.result, setToolStepStatus);
              setPagedText(block.querySelector('.tool-args'), JSON.stringify(tc.args, null, 2));
              if (tc.result) {
                const result = block.querySelector('.tool-result');
                if (result) setPagedText(result, tc.result.output || '');
                const diffPane = block.querySelector('[data-pane="diff"]');
                if (tc.result.fileChange && diffPane) renderFileChange(diffPane, tc.result.fileChange);
              }
              window.IexaChatActivity.updateTool(block, tc.name, tc.args, tc.result);
              steps.appendChild(block);
              // Attach artifacts only once the step is in the tree: the card is
              // placed with `block.after(card)`, and `after()` on a detached node
              // is a no-op — that is how restored images used to disappear.
              if (tc.result && tc.result.artifacts && tc.result.artifacts.length) {
                // Media belongs beside the row, never inside the collapsible
                // body: a folded turn must not swallow the picture.
                renderToolArtifactsAfterStep(block, tc.result.artifacts);
              }
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
          // The plan lives in the composer dock now (DeepSeek Harness's
          // TodoPanel position); rendering it here too would duplicate it.
          restoreTranscriptOrder(el, msg);
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
          // A restored turn folds exactly like a live one: reasoning blocks and
          // tool rails go behind one "elapsed" line instead of leaving a column
          // of identical capsules for every step of a long conversation.
          //
          // A parked turn is the exception. Folding it hides exactly what the
          // reader needs - which step it stopped at - so it stays expanded, and
          // the paused banner below it offers the continuation.
          const parked = ['running', 'paused', 'interrupted'].includes(msg.status);
          if (!parked) {
            window.IexaTurnSummary?.settle(el);
          }
        }
}

function showLoadEarlierAffordance(sessionId, runtime) {
  const existing = chatMessages.querySelector('.load-earlier-messages');
  if (existing) existing.remove();
  if (!runtime || runtime.historyStartIndex <= 0) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'load-earlier-messages';
  button.textContent = IexaI18n.t('session.loadEarlier', { count: runtime.historyStartIndex });
  button.addEventListener('click', () => { void loadEarlierHistory(sessionId); });
  const spacer = chatMessages.querySelector(".history-spacer");
  chatMessages.insertBefore(button, spacer ? spacer.nextSibling : chatMessages.firstChild);
}

async function loadEarlierHistory(sessionId) {
  // A switch while the chunk is being built must not graft it onto another
  // conversation, so every exit re-checks which session is actually visible.
  if (sessionId !== visibleSessionId || sessionId !== currentSessionId) return;
  const runtime = runtimeForSession(sessionId);
  const messages = runtime.historyMessages;
  if (!mobileHistoryWindow() || !Array.isArray(messages) || runtime.historyStartIndex <= 0) return;
  const button = chatMessages.querySelector('.load-earlier-messages');
  if (button) { button.disabled = true; button.textContent = IexaI18n.t('common.loading'); }

  const nextStart = Math.max(0, runtime.historyStartIndex - MOBILE_HISTORY_CHUNK);
  const added = runtime.historyStartIndex - nextStart;
  const live = chatMessages;
  // addMessage() asks the transcript to follow the newest message. While an
  // earlier chunk is being collected that request would yank the reader to the
  // bottom once the queued animation frame runs, so following is stopped first
  // and the scroll position is restored by hand below.
  stopFollowingLatestMessage();
  const previousTop = live.scrollTop;
  // Anchor on a real element: the spacer above is an estimate, so a raw
  // height delta would drift the reader when the estimate is off.
  const anchorEl = live.querySelector('.message');
  const anchorTop = anchorEl ? anchorEl.offsetTop : 0;
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
  // The spacer always stays first: it represents everything still unmounted.
  const spacerAtTop = live.querySelector('.history-spacer');
  live.insertBefore(fragment, spacerAtTop ? spacerAtTop.nextSibling : live.firstChild);
  runtime.historyStartIndex = nextStart;
  updateHistorySpacer(runtime);
  runtime.historyRenderedCount = (Number(runtime.historyRenderedCount) || 0) + added;
  // Keep the reader where they were: the transcript grew above the viewport.
  const anchorAfter = anchorEl ? anchorEl.offsetTop : 0;
  live.scrollTop = previousTop + Math.max(0, anchorAfter - anchorTop);
  showLoadEarlierAffordance(sessionId, runtime);
}

async function switchSession(id, updateList = true) {
  // 从别的视图点一条会话，就该看到那段对话。必须放在最前面：点的正好是当前
  // 这一条时，下面第一行就 return 了，晚一步就什么都不会发生——那正是「还得
  // 先去点一下『对话』」。
  if (typeof chatViewIsActive === 'function' && !chatViewIsActive()) {
    document.querySelector('.nav-btn[data-view="chat"]')?.click();
  }
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
  window.IexaTrajectory?.switchSession?.();
  window.IexaPlanDock?.reset();
  window.IexaQueueDock?.reset();
  window.IexaTrajectory?.reset();
  window.syncPausedBanner?.();
  void refreshGoalBanner();
  syncSubAgentView();
  const targetRuntime = runtimeForSession(id);
  if (targetRuntime.historyReady || targetRuntime.isProcessing) {
    // 回到一段读过的对话：上次不在底部，就停在他离开的地方。无脑钉到最新会
    // 把读者的位置扔掉——那正是「点一下聊天，滚动就没了」。
    const resumeAt = Number.isFinite(targetRuntime.scrollTop) && targetRuntime.isNearChatBottom === false
      ? targetRuntime.scrollTop
      : null;
    mountSessionRuntime(id);
    if (resumeAt === null) scrollHistoryToLatest(id);
    else restoreSessionScroll(id, resumeAt);
    // Still pacing: flush the lines that came due while this conversation was
    // hidden. Their moment has passed, so they land together, and the pacing
    // loop keeps running for the rest - no rebuild, no lost rhythm.
    if (targetRuntime.naturalPacing === true) {
      const undrawn = Array.isArray(targetRuntime.naturalUndrawn) ? targetRuntime.naturalUndrawn : [];
      if (undrawn.length) {
        targetRuntime.naturalUndrawn = [];
        for (const line of undrawn) {
          addMessage('assistant', line);
          targetRuntime.mountedMessageCount = (Number(targetRuntime.mountedMessageCount) || 0) + 1;
        }
        scrollToBottom();
      }
    }
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
    loading.textContent = IexaI18n.t('session.loadingConversation');
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
    // Remember what this view mounted. A later metadata poll compares against
    // this count, so an unchanged conversation is never torn down and rebuilt -
    // that rebuild is the flash seen when returning to the window.
    if (Number.isInteger(sess?.messageCount)) targetRuntime.mountedMessageCount = sess.messageCount;

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
      // Cold start used to build the whole transcript inside the visible
      // scroller, yielding every 8ms: the reader watched the conversation grow
      // from the first message down to the last. Mount one window with the
      // surface hidden, then reveal it already parked at the newest message.
      const hydrating = windowed && msgs.length > 0;
      if (hydrating) chatMessages.classList.add('is-hydrating');
      try {
        let batchStartedAt = performance.now();
        // 伴侣聊天按轮插时间分隔：她的新一次开口（上一句是他说的，或隔了
        // 三分钟以上）之前放一行居中的时间。别的模式不插。
        const dividerSession = (typeof sessionsCache !== 'undefined' && Array.isArray(sessionsCache))
          ? sessionsCache.find((entry) => entry.id === id) : null;
        const wantsDivider = dividerSession?.natural === true;
        for (let messageIndex = startIndex; messageIndex < msgs.length; messageIndex++) {
          if (performance.now() - batchStartedAt > 8) {
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            if (viewEpoch !== sessionViewEpoch || visibleSessionId !== id) {
              targetRuntime.historyReady = false;
              return;
            }
            batchStartedAt = performance.now();
          }
          if (wantsDivider) {
            const msg = msgs[messageIndex];
            const prev = messageIndex > startIndex ? msgs[messageIndex - 1] : null;
            const startsRound = !prev
              || prev.role === 'user'
              || (Number(msg.timestamp) || 0) - (Number(prev.timestamp) || 0) > 180000;
            if (msg.role === 'assistant' && startsRound) appendChatTimeDivider(msg.timestamp);
          }
          renderHistoryMessage(msgs[messageIndex], messageIndex);
        }
      } finally {
        if (hydrating) {
          // Park first, reveal second. Removing the class before the scroll
          // lands lets a paint slip through at the top for one frame, which is
          // the last way the transcript can still flash its first message.
          if (visibleChatMessages === chatMessages) {
            visibleChatMessages.scrollTop = visibleChatMessages.scrollHeight;
          }
          chatMessages.classList.remove('is-hydrating');
        }
      }
      targetRuntime.historyMessages = msgs;
      targetRuntime.historyTotal = msgs.length;
      // A plan is live progress, not a record. Rebuild it only when this
      // session actually has a turn running right now; a finished turn's plan
      // was resurrecting on every reload and page restore, frozen on whatever
      // step was reported first.
      window.IexaPlanDock?.setTodos(id, window.IexaPlanDock.extractTodos(msgs), { live: targetRuntime.isProcessing === true });
      targetRuntime.historyStartIndex = startIndex;
      updateHistorySpacer(targetRuntime);
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
    retry.textContent = IexaI18n.t('session.loadFailed');
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
  if (!(await window.IexaDialogs.confirm(IexaI18n.t('session.confirmDelete')))) return;

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
    span.setAttribute('aria-label', newTitle);
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
 * 切模式前调用：清空可见区，并让下一次 switchSession 一定重新加载。
 *
 * 标准聊天和小楠的消息不能同屏：之前切过去时旧的 DOM 还挂着，新会话
 * 因为「id 没变 + historyReady」直接 return，页面上就留着一整屏另一种模式
 * 的内容。这里把可见会话置空、把缓存标成未就绪，强制走完整的挂载与取历史。
 */
function detachVisible() {
  clearChat();
  showWelcome();
  window.syncPausedBanner?.();
  visibleSessionId = '';
  const runtime = sessionRuntimes.get(currentSessionId);
  if (runtime) runtime.historyReady = false;
}
window.IexaSessionView = { detachVisible, clearChat, showWelcome, isNaturalSpeakingNow };

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
  // Natural chat is one continuous personal thread, so its landing screen drops
  // the product mark and the task-oriented shortcuts and offers a single
  // opening line instead.
  if (window.IexaNaturalChat?.currentChatMode() === 'natural') {
    template.innerHTML = `
    <div class="welcome is-natural">
      <div class="welcome-head">
        <h2>${IexaI18n.t('ui.naturalTitle')}</h2>
      </div>
      <p>${IexaI18n.t('ui.naturalSubtitle')}</p>
      <div class="quick-actions">
        <button class="quick-btn" data-ui-action="sendQuick" data-ui-arg="${IexaI18n.t('quick.naturalGreet')}">${uiIcon('chat')}<span>${IexaI18n.t('ui.naturalGreet')}</span></button>
      </div>
    </div>
  `;
    chatMessages.replaceChildren(template.content);
    return;
  }
  template.innerHTML = `
    <div class="welcome">
      <div class="welcome-head">
        <img class="welcome-logo" src="mobile-pair-logo.png" width="34" height="34" alt="iExA">
        <h2>${IexaI18n.t('ui.9')}</h2>
      </div>
      <p>${IexaI18n.t('ui.10')}</p>
      <div class="quick-actions">
        <button class="quick-btn" data-ui-action="sendQuick" data-ui-arg="${IexaI18n.t('quick.listFiles')}">${uiIcon('folder')}<span>${IexaI18n.t('ui.11')}</span></button>
        <button class="quick-btn" data-ui-action="sendQuick" data-ui-arg="${IexaI18n.t('quick.systemInfo')}">${uiIcon('monitor')}<span>${IexaI18n.t('ui.12')}</span></button>
        <button class="quick-btn" data-ui-action="sendQuick" data-ui-arg="${IexaI18n.t('quick.pythonServer')}">${uiIcon('code')}<span>${IexaI18n.t('ui.13')}</span></button>
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
  // Fold / unfold one project group. Toggled on the live node rather than by
  // re-rendering: a re-render would reset the sidebar scroll offset and blink
  // every other row, which is exactly the kind of jitter a sidebar should not
  // have. The choice is persisted so a restart keeps the sidebar tidy.
  sessionsList?.addEventListener('click', event => {
    // Category rename / delete live on the group header, so they run before the
    // fold toggle that shares the same container.
    const renameBtn = event.target.closest?.('[data-category-rename]');
    if (renameBtn && sessionsList.contains(renameBtn)) {
      event.stopPropagation();
      const id = renameBtn.dataset.categoryRename || '';
      const current = sidebarCategories().find(entry => entry.id === id);
      if (!current) return;
      void (async () => {
        const name = await window.IexaDialogs.prompt(IexaI18n.t('session.categoryHint'), current.name);
        if (!name || !name.trim()) return;
        try { await renameSidebarCategory(id, name.trim()); }
        catch (err) { addError(err.message || String(err)); }
      })();
      return;
    }
    const deleteBtn = event.target.closest?.('[data-category-delete]');
    if (deleteBtn && sessionsList.contains(deleteBtn)) {
      event.stopPropagation();
      const id = deleteBtn.dataset.categoryDelete || '';
      void (async () => {
        const ok = await window.IexaDialogs.confirm(IexaI18n.t('session.categoryDeleteHint'));
        if (!ok) return;
        try { await deleteSidebarCategory(id); }
        catch (err) { addError(err.message || String(err)); }
      })();
      return;
    }
    const heading = event.target.closest?.('[data-project-toggle]');
    if (!heading || !sessionsList.contains(heading)) return;    const group = heading.closest('.session-project-group');
    if (!group) return;
    const collapsed = group.classList.toggle('is-collapsed');
    heading.setAttribute('aria-expanded', String(!collapsed));
    const key = String(heading.dataset.projectToggle || '').toLowerCase();
    const stored = readCollapsedProjects();
    if (collapsed) stored.add(key); else stored.delete(key);
    writeCollapsedProjects(stored);
  });
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
  // Standard / natural switching. Installed before the first render so the
  // sidebar already knows which list it is painting.
  window.IexaNaturalChat?.install();
  // The sidebar's "+" creates a category; it never opens a folder or a chat.
  document.getElementById('shellNewCategory')?.addEventListener('click', () => {
    void (async () => {
      const name = await window.IexaDialogs.prompt(IexaI18n.t('session.categoryHint'));
      if (!name || !name.trim()) return;
      try { await createSidebarCategory(name.trim()); }
      catch (err) { addError(err.message || String(err)); }
    })();
  });
}
