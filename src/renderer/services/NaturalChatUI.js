/**
 * Natural-chat mode switch.
 *
 * Standard conversations and natural ones are two separate lists. The mode is a
 * view preference, stored locally, and it never creates a second natural
 * conversation: the sidebar offers exactly one, because the feature is a single
 * continuous relationship rather than a set of threads.
 *
 * Selecting a mode swaps what the sidebar renders and, when the target mode has
 * no conversation yet, creates it once.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'iexa-chat-mode';

  function readMode() {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'natural' ? 'natural' : 'standard';
    } catch {
      return 'standard';
    }
  }

  let chatMode = readMode();
  // The standard conversation the user was reading when they jumped to natural
  // chat. Coming back restores it; without this, returning always landed on the
  // newest conversation, which read as "it forgot where I was".
  let lastStandardSessionId = '';

  function currentChatMode() {
    return chatMode;
  }

  function isNatural(session) {
    return Boolean(session) && session.natural === true;
  }

  function syncModeButtons() {
    document.querySelectorAll('[data-session-mode]').forEach((button) => {
      const active = button.dataset.sessionMode === chatMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const toggle = document.getElementById('naturalChatBtn');
    if (toggle) {
      const active = chatMode === 'natural';
      toggle.classList.toggle('is-active', active);
      toggle.setAttribute('aria-pressed', String(active));
    }
    document.body.dataset.chatMode = chatMode;
    // 小楠只有一条对话，再点「新聊天」就是让它俩抢位置。按钮留在原处（拿走的话
    // 侧栏会缺一块），但停用：disabled 连点击、回车、Ctrl+N 一起挡住，读屏也会
    // 念成不可用。提示文案跟着换，停在按钮上就能看到原因。
    const newThread = document.getElementById('shellNewThread');
    const newSession = document.getElementById('newSessionBtn');
    const blocked = chatMode === 'natural';
    for (const button of [newThread, newSession]) {
      if (!button) continue;
      button.disabled = blocked;
      button.setAttribute('aria-disabled', String(blocked));
    }
    if (newThread) {
      const key = blocked ? 'tip.newTaskBlocked' : 'tip.newTaskShortcut';
      if (newThread.dataset.i18nTitle !== key) {
        newThread.dataset.i18nTitle = key;
        newThread.title = IexaI18n.t(key);
      }
    }
    // 小楠那边没有「项目」这一层，但那一行要留着——它上面是会话区的标题，下面是
    // 模式开关；行高一变，开关就上下跳。标题换成一句话，data-i18n 一起换，
    // 否则切语言时 I18n.apply() 会把「项目与对话」写回来。
    const heading = document.querySelector('.sidebar-sessions .sessions-title');
    if (heading) {
      const key = chatMode === 'natural' ? 'session.naturalHeading' : 'ui.1';
      if (heading.dataset.i18n !== key) {
        heading.dataset.i18n = key;
        heading.textContent = IexaI18n.t(key);
      }
    }
  }

  /**
   * 小楠那条唯一的对话。
   *
   * 缓存里没有不代表服务器上没有：刚启动时 sessionsCache 还是空的，2026-11-28
   * 就是这样凭空建出了两条空会话，还把真正有历史的那条挤到看不见。所以先问
   * 服务器，问过确实没有才建；真有重复时认消息最多的那条。
   */
  async function ensureNaturalSession() {
    const richest = (list) => {
      const naturals = list.filter(isNatural);
      if (!naturals.length) return null;
      return naturals.slice().sort((a, b) =>
        (Number(b.messageCount) || 0) - (Number(a.messageCount) || 0)
        || (Number(a.created) || 0) - (Number(b.created) || 0))[0];
    };
    let existing = richest(sessionsCache);
    if (!existing) {
      try {
        const response = await fetch(`${API_BASE}/api/sessions`, { cache: 'no-store' });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.sessions)) sessionsCache = data.sessions;
          existing = richest(sessionsCache);
        }
      } catch { /* 读不到再退回创建 */ }
    }
    if (existing) return existing.id;
    const response = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ natural: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.session) throw new Error(data.error || '创建小楠(Preview)会话失败');
    // 服务端也可能把已有那条原样退回来，别再往缓存里塞一份。
    if (!sessionsCache.some((session) => session.id === data.session.id)) {
      sessionsCache = [data.session, ...sessionsCache];
    }
    return data.session.id;
  }

  /** Newest standard conversation, so returning from natural chat lands somewhere real. */
  function latestStandardSessionId() {
    const standard = sessionsCache
      .filter((session) => session.archived !== true && !isNatural(session))
      .sort((a, b) => (Number(b.created) || Number(b.updated) || 0) - (Number(a.created) || Number(a.updated) || 0));
    return standard[0]?.id || '';
  }

  async function applyMode(next, options = {}) {
    const mode = next === 'natural' ? 'natural' : 'standard';
    // Capture the outgoing side before chatMode flips: leaving standard chat is
    // the only moment the session to restore is known.
    if (chatMode === 'standard' && mode === 'natural' && currentSessionId) {
      const current = sessionsCache.find((session) => session.id === currentSessionId);
      if (current && !isNatural(current)) lastStandardSessionId = currentSessionId;
    }
    chatMode = mode;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* private mode */ }
    syncModeButtons();
    renderSessionList();

    // Coming back to natural chat may land after an unprompted line started, so
    // the live event is already gone. One metadata read re-syncs the marks.
    if (mode === 'natural') void syncConversationMetadata();

    if (options.skipNavigation) return;

    // 先关掉当前内容，再切。两种模式的记录不能同屏。
    try { window.IexaSessionView?.detachVisible?.(); } catch { /* view not mounted yet */ }

    try {
      if (mode === 'natural') {
        const id = await ensureNaturalSession();
        // Opening the conversation clears its badge: whatever was counted while
        // the user was elsewhere is now on screen.
        if (id) {
          await markRead(id);
          // detachVisible 已经把可见会话置空，这里无条件走一次完整加载。
          await switchSession(id, false);
        }
      } else {
        // Prefer the conversation the user was in before switching away. Fall
        // back to the newest one only when that session is gone or archived.
        const remembered = lastStandardSessionId
          && sessionsCache.some((session) => session.id === lastStandardSessionId
            && session.archived !== true && !isNatural(session))
          ? lastStandardSessionId
          : '';
        const id = remembered || latestStandardSessionId();
        if (id) await switchSession(id, false);
        else await createSession();
      }
    } catch (error) {
      addError?.(error.message || String(error));
    }
  }

  function install() {
    document.querySelectorAll('[data-session-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.sessionMode === chatMode) return;
        void applyMode(button.dataset.sessionMode);
      });
    });
    // The toolbar control is a shortcut: it always jumps to natural chat, and
    // toggles back to standard once you are already there.
    document.getElementById('naturalChatBtn')?.addEventListener('click', () => {
      void applyMode(chatMode === 'natural' ? 'standard' : 'natural');
    });
    syncModeButtons();
    renderUnreadBadge();
    void installProactiveMode();
    // Coming back to the tab re-syncs the badge: events emitted while it slept
    // were never delivered, so the server's count is the only truth.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') renderUnreadBadge();
    });
  }

  // ---- 主动模式（热情 / 安静）---------------------------------------------
  //
  // 只管一件事：她会不会主动开口。回复本身完全不走这里——安静模式下
  // 他发消息，她照常回。状态存在服务端 settings 里，重启后还在。

  let proactiveMode = true;

  function renderProactiveMode() {
    const button = document.getElementById('proactiveModeBtn');
    const label = document.getElementById('proactiveModeLabel');
    if (!button || !label) return;
    label.textContent = proactiveMode ? '热情' : '安静';
    button.dataset.mode = proactiveMode ? 'warm' : 'quiet';
    document.querySelectorAll('.proactive-mode-option').forEach((option) => {
      option.setAttribute('aria-checked', String(option.dataset.proactive === String(proactiveMode)));
    });
  }

  async function setProactiveMode(next) {
    const wanted = next === true;
    const previous = proactiveMode;
    proactiveMode = wanted;
    renderProactiveMode();
    try {
      const response = await fetch(`${API_BASE}/api/proactive-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proactive: wanted }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '切换主动模式失败');
      }
      const data = await response.json();
      proactiveMode = data.proactive !== false;
      renderProactiveMode();
    } catch (error) {
      // 服务端没改成，界面就不能停在改过的样子——否则按钮显示「安静」，
      // 她其实还在主动开口，用户以为关掉了。退回去再报错。
      proactiveMode = previous;
      renderProactiveMode();
      addError?.(error.message || String(error));
    }
  }

  /**
   * 关掉其他 composer 面板。
   *
   * 不依赖 ComposerMenus 的登记表——那张表通过 globalThis[name] 反查各个模块的
   * 关闭函数，任何一环没对上（名字不一致、模块还没挂上、IIFE 执行顺序）都会
   * 静默失败，于是两个菜单叠在一起。这里直接按名字挨个调，调不到就算了。
   */
  function closeOtherComposerMenus() {
    const closers = [
      'setModelMenuOpen',
      'setThinkingMenuOpen',
      'setContextCompactionMenuOpen',
      'setPermissionMenuOpen',
      'setCheckpointOpen',
    ];
    for (const name of closers) {
      const close = globalThis[name];
      if (typeof close !== 'function') continue;
      try { close(false); } catch { /* 面板自己出错不该挡住关闭别的 */ }
    }
  }

  function setProactiveMenuOpen(open) {
    const button = document.getElementById('proactiveModeBtn');
    const menu = document.getElementById('proactiveModeMenu');
    if (!button || !menu) return;
    if (open) closeOtherComposerMenus();
    // 必须是 flex，不能是 block：选项之间的 gap 只有 flex/grid 容器才生效。
    // 这里写成 block 时，CSS 的 display:flex 被内联样式盖掉，gap 一直没起作用，
    // 两块选项直接贴在一起。
    menu.style.display = open ? 'flex' : 'none';
    button.classList.toggle('is-open', !!open);
    button.setAttribute('aria-expanded', String(!!open));
    // 交给 composer 菜单管理器定位：它会把面板贴在输入框上方居中。
    if (open) globalThis.IexaComposerMenu?.open('proactiveModeMenu', 'proactiveModeBtn');
  }

  function closeProactiveMenu() {
    setProactiveMenuOpen(false);
  }

  async function installProactiveMode() {
    const wrap = document.getElementById('proactiveModeWrap');
    const button = document.getElementById('proactiveModeBtn');
    const menu = document.getElementById('proactiveModeMenu');
    if (!wrap || !button || !menu) return;

    try {
      const response = await fetch(`${API_BASE}/api/proactive-mode`);
      if (response.ok) {
        const data = await response.json();
        proactiveMode = data.proactive !== false;
      }
    } catch { /* 读不到就按热情显示，不拦着聊天 */ }
    renderProactiveMode();

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setProactiveMenuOpen(menu.style.display === 'none');
    });

    menu.querySelectorAll('.proactive-mode-option').forEach((option) => {
      option.addEventListener('click', () => {
        closeProactiveMenu();
        void setProactiveMode(option.dataset.proactive === 'true');
      });
    });

    // 点自己以外的地方就收起来。用 capture：别的按钮（模型、思考档位、访问
    // 权限）在自己的 click 里调了 stopPropagation，冒泡阶段收不到，面板会一直
    // 挂着跟别人叠在一起。
    document.addEventListener('click', (event) => {
      if (menu.style.display === 'none') return;
      if (wrap.contains(event.target)) return;
      closeProactiveMenu();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (menu.style.display === 'none') return;
      closeProactiveMenu();
      button.focus();
    });
  }

  // ---- Unread counter (display only) --------------------------------------
  //
  // The number comes from the server, which is the only place that knows a
  // line was persisted. A renderer-side tally missed everything that arrived
  // while the tab was hidden, the window was minimised or the client was
  // closed - which is exactly when unread matters. The pill has no click
  // handler on purpose: it is a status readout, not a control.

  function totalUnread() {
    if (typeof sessionsCache === 'undefined' || !Array.isArray(sessionsCache)) return 0;
    return sessionsCache.reduce((sum, session) => {
      if (session.natural !== true) return sum;
      return sum + (Number(session.unread) || 0);
    }, 0);
  }

  let markingRead = false;

  function renderUnreadBadge() {
    const box = document.getElementById('sidebarUnread');
    const badge = document.getElementById('sidebarUnreadBadge');
    if (!box || !badge) return;
    // Anything counted for the conversation currently on screen has been read.
    // Clearing here covers the case the live event cannot: a reconnect after the
    // tab slept replays nothing, so those lines would otherwise stay counted
    // while their bubbles are already visible.
    if (!markingRead && document.visibilityState === 'visible'
      && typeof sessionsCache !== 'undefined' && Array.isArray(sessionsCache)) {
      const open = sessionsCache.find((session) => session.id === currentSessionId);
      if (open && open.natural === true && (Number(open.unread) || 0) > 0) {
        markingRead = true;
        void markRead(open.id).finally(() => { markingRead = false; });
        return;
      }
    }
    const total = totalUnread();
    if (total <= 0) { box.hidden = true; return; }
    box.hidden = false;
    // iOS convention: anything past 99 collapses so the pill cannot grow.
    badge.textContent = total > 99 ? '99+' : String(total);
  }

  /** Tell the server the conversation is on screen, then clear the badge. */
  async function markRead(sessionId) {
    if (!sessionId) return;
    const cached = typeof sessionsCache !== 'undefined'
      ? sessionsCache.find((session) => session.id === sessionId) : null;
    if (cached) cached.unread = 0;
    renderUnreadBadge();
    try {
      await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/read`, { method: 'POST' });
    } catch { /* the next list refresh re-syncs it */ }
  }

  window.IexaNaturalChat = {
    currentChatMode,
    isNatural,
    applyMode,
    ensureNaturalSession,
    install,
    installProactiveMode,
    markRead,
    renderUnreadBadge,
  };
  // ComposerMenus 通过 globalThis[name] 找各个面板的关闭函数，名字必须与
  // OWNERS 里登记的一致。挂在这里而不是模块内，是因为这个文件是 IIFE。
  globalThis.setProactiveMenuOpen = setProactiveMenuOpen;
})();
