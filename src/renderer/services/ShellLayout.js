// =============================================================================
// Shell layout
//
// Panel resizers, sidebar wheel routing, mobile drawers and chat focus mode.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
function initPanelResizers() {
  const root = document.documentElement;
  const sidebarResizer = document.getElementById('sidebarResizer');
  const filesResizer = document.getElementById('filesResizer');
  if (!sidebarResizer || !filesResizer) return;

  const defaults = { sidebar: 240, files: 300 };
  const widthVariable = (key) => (key === 'sidebar' ? '--sidebar-width' : '--files-panel-width');
  const panels = { sidebar: document.querySelector('.sidebar'), files: document.querySelector('.files-panel') };
  const readWidth = (key) => {
    const cssName = key === 'sidebar' ? '--sidebar-width' : '--files-panel-width';
    const pinned = panels[key] ? Number.parseInt(getComputedStyle(panels[key]).getPropertyValue(cssName), 10) : NaN;
    if (Number.isFinite(pinned)) return pinned;
    const persisted = Number.parseInt(getComputedStyle(root).getPropertyValue(cssName), 10);
    if (Number.isFinite(persisted)) return persisted;
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
  // `live` writes the panel's own width, `commit` writes the custom property.
  //
  // The property is scoped to the panel instead of :root on purpose. It is
  // inherited, so a :root write invalidates the style of all 34k nodes in a long
  // transcript - measured 128ms per write (≈8fps) versus 14ms when the same
  // value is set on .sidebar itself.
  const apply = (key, value, persist = true, live = false) => {
    const next = clamp(value, key);
    if (key === 'sidebar') sidebarWidth = next; else filesWidth = next;
    const panel = panels[key];
    if (live && panel) {
      panel.style.width = `${next}px`;
      return;
    }
    if (panel) {
      panel.style.width = '';
      panel.style.setProperty(widthVariable(key), `${next}px`);
    } else {
      root.style.setProperty(widthVariable(key), `${next}px`);
    }
    if (persist) {
      localStorage.setItem(`iexa-${key}-width`, String(next));
      scheduleAppearanceSave();
    }
  };
  // Normalising is a layout pass, not an edit: seeding the value that was just
  // read back from storage would write a default on every load and race the
  // first real drag.
  const normalize = () => {
    apply('sidebar', sidebarWidth, false);
    apply('files', filesWidth, false);
  };

  normalize();
  // Appearance can resolve before init() runs, and in that window the seeding
  // path writes the widths on :root because this module is not reachable yet.
  // Panels are authoritative now, so drop the inherited copy: an inline :root
  // value makes every later write look like a global style invalidation, and a
  // drag that lands while it is still set fails the "no inherited write" rule.
  if (panels.sidebar) root.style.removeProperty('--sidebar-width');
  if (panels.files) root.style.removeProperty('--files-panel-width');
  window.addEventListener('resize', normalize);

  // Appearance settings arrive before this module runs, so they seed the :root
  // fallback; later loads have to go through the panels to stay authoritative.
  window.IexaPanelWidths = {
    set(sidebar, files) {
      if (Number.isFinite(sidebar)) apply('sidebar', sidebar, false);
      if (Number.isFinite(files)) apply('files', files, false);
    },
  };

  // A full-viewport shield is how the drag keeps `cursor: col-resize` over every
  // element. The old rule was `body.is-resizing *`, which forced the style engine
  // to match a universal selector against all 34k nodes on every recalc.
  let dragShield = null;
  const setDragShield = (visible) => {
    if (visible) {
      if (!dragShield) {
        dragShield = document.createElement('div');
        dragShield.className = 'panel-drag-shield';
        dragShield.setAttribute('aria-hidden', 'true');
        document.body.appendChild(dragShield);
      }
      dragShield.hidden = false;
      return;
    }
    if (dragShield) dragShield.hidden = true;
  };

  const bind = (handle, key) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      handle.classList.add('is-dragging');
      // Pin the transcript to its current width before the drag starts. A width
      // change reflows every message; on a 34k-node transcript that is ~13ms of
      // layout per frame. Holding the width keeps the drag at 60fps and the real
      // width is applied once, on release. The pin is written inline on the
      // element: a class or custom property on :root would re-match the whole
      // document (measured 128ms per style pass).
      const chatColumn = document.getElementById('chatMessages');
      if (chatColumn) {
        const pinned = Math.round(chatColumn.getBoundingClientRect().width);
        if (pinned > 0) {
          chatColumn.style.width = `${pinned}px`;
          chatColumn.style.overflowX = 'hidden';
        }
      }
      setDragShield(true);
      let pending = null;
      let frame = 0;
      let settled = false;
      const flush = () => {
        frame = 0;
        if (pending === null) return;
        apply(key, pending, false, true);
        pending = null;
      };
      const resize = (clientX) => {
        pending = key === 'sidebar' ? clientX : window.innerWidth - clientX;
        // Pointer events can arrive far faster than the compositor can paint;
        // coalescing to one write per frame is what keeps the drag smooth.
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const move = (moveEvent) => resize(moveEvent.clientX);
      const finish = () => {
        if (settled) return;
        settled = true;
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        flush();
        if (chatColumn) {
          chatColumn.style.width = '';
          chatColumn.style.overflowX = '';
        }
        apply(key, key === 'sidebar' ? sidebarWidth : filesWidth);
        handle.classList.remove('is-dragging');
        setDragShield(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        window.removeEventListener('blur', finish);
      };
      // Listening on window means the drag still ends if the browser cancels
      // pointer capture (alt-tab, touch interruption, context menu).
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      window.addEventListener('blur', finish);
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

function initSidebarNavigationScroll() {
  const sidebar = document.getElementById('sidebar');
  const navigation = sidebar?.querySelector('.sidebar-nav');
  if (!sidebar || !navigation) return;

  // When the pointer is over non-scrollable sidebar chrome, route the wheel
  // to the function rail. The conversation list and the rail keep their own
  // native scrolling when the pointer is directly over either one.
  sidebar.addEventListener('wheel', (event) => {
    if (navigation.scrollHeight <= navigation.clientHeight || navigation.contains(event.target)) return;
    const sessions = event.target.closest?.('.sessions-list, .search-results');
    if (sessions && sessions.scrollHeight > sessions.clientHeight) return;
    navigation.scrollTop += event.deltaY;
    event.preventDefault();
  }, { passive: false });

  navigation.querySelectorAll('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => button.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });
}

function closeMobileDrawers() {
  document.body.classList.remove('mobile-sidebar-open', 'mobile-files-open');
  const backdrop = document.getElementById('mobileDrawerBackdrop');
  if (backdrop) backdrop.hidden = true;
}

function initMobileDrawers() {
  const backdrop = document.getElementById('mobileDrawerBackdrop');
  const open = (kind) => {
    closeMobileDrawers();
    document.body.classList.add(kind === 'files' ? 'mobile-files-open' : 'mobile-sidebar-open');
    if (backdrop) backdrop.hidden = false;
  };
  document.getElementById('mobileMenuBtn')?.addEventListener('click', () => open('sidebar'));
  document.getElementById('mobileFilesBtn')?.addEventListener('click', () => open('files'));
  backdrop?.addEventListener('click', closeMobileDrawers);
  window.addEventListener('resize', () => { if (innerWidth > 760) closeMobileDrawers(); });
}

function initChatFocusMode() {
  const button = document.getElementById('chatFocusToggle');
  if (!button) return;
  const root = document.body;
  const saved = localStorage.getItem('iexa-chat-focus-mode') === '1';
  const update = (focused) => {
    root.classList.toggle('chat-focus-mode', focused);
    button.setAttribute('aria-pressed', focused ? 'true' : 'false');
    button.title = focused ? IexaI18n.t('layout.restorePanels') : IexaI18n.t('layout.hidePanels');
    const label = button.querySelector('.chat-focus-toggle-label');
    if (label) label.textContent = focused ? IexaI18n.t('layout.restore') : IexaI18n.t('layout.expandChat');
  };
  update(saved);
  button.addEventListener('click', () => {
    const focused = !root.classList.contains('chat-focus-mode');
    update(focused);
    localStorage.setItem('iexa-chat-focus-mode', focused ? '1' : '0');
  });
}
