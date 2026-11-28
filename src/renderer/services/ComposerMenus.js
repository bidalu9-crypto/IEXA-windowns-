/* Composer model-bar popovers.
 *
 * The model, reasoning, context-capacity and permission controls each own a
 * small panel. Those panels were positioned relative to their own trigger, so a
 * short model name pulled every later control to the left and the widest panel
 * (context capacity) slid under the sidebar, cut off mid-way.
 *
 * Two rules are enforced here instead:
 *   1. A panel is fixed to the viewport and centred horizontally, clamped so it
 *      never touches a window edge no matter how narrow the trigger is.
 *   2. Only one panel may be open. Opening another closes the previous one,
 *      rather than stacking two menus over the same strip of screen.
 *
 * Placement is inline styling only, so the modules keep owning their own
 * display/aria state and nothing here has to know their internals.
 */
(() => {
  'use strict';

  const EDGE = 12;   // never closer than this to a window edge
  const GAP = 6;     // breathing room between the panel and the chat box border

  /** Panel id -> the module function that closes it. */
  const OWNERS = {
    modelSelectorMenu: 'setModelMenuOpen',
    thinkingLevelMenu: 'setThinkingMenuOpen',
    contextCompactionMenu: 'setContextCompactionMenuOpen',
    permissionModeMenu: 'setPermissionMenuOpen',
    checkpointPopover: 'setCheckpointOpen',
    proactiveModeMenu: 'setProactiveMenuOpen',
  };

  let openPanel = null;   // { menu, triggerId }

  function menuOf(id) {
    return document.getElementById(id);
  }

  /** Visible means "shown by its owner", which is `display` plus the hidden flag. */
  function visible(menu) {
    return Boolean(menu) && menu.hidden !== true && menu.style.display !== 'none';
  }

  function closePanel(id) {
    const menu = menuOf(id);
    if (!visible(menu)) return;
    // Prefer the owner's own closer so its trigger state resets with it.
    const closer = globalThis[OWNERS[id]];
    if (typeof closer === 'function') closer(false);
    else menu.style.display = 'none';
  }

  /** Close every composer panel except `keepId` (pass '' to close them all). */
  function closeOthers(keepId) {
    for (const id of Object.keys(OWNERS)) {
      if (id === keepId) continue;
      closePanel(id);
    }
    if (keepId !== (openPanel && openPanel.menu.id)) openPanel = null;
  }

  function place(menu, triggerId, capPx) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    menu.style.position = 'fixed';
    menu.style.right = 'auto';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.bottom = 'auto';
    // CSS 里为了「没走到这里也能居中」留了 translateX(-50%) 兜底。一旦这里
    // 接管定位，那个位移就会把面板整体左移半个宽度，必须清掉。
    menu.style.transform = 'none';
    menu.style.boxSizing = 'border-box';
    menu.style.maxWidth = `${Math.max(120, viewportWidth - EDGE * 2)}px`;

    // The chat view carries `content-visibility: hidden`, which implies
    // `contain: paint` - and that makes it the containing block for fixed
    // descendants. Viewport maths therefore landed these panels at the far
    // right of that box, next to the send button. Measuring the containing
    // block's own origin first keeps the maths correct either way: on a plain
    // viewport origin it is 0,0, inside a contained ancestor it is not.
    const column = document.querySelector('#view-chat .chat-input-area')
      || document.querySelector('.chat-input-area');
    const bounds = column ? column.getBoundingClientRect() : null;
    const borderTop = bounds && bounds.width ? bounds.top : viewportHeight;
    const targetBottom = Math.min(borderTop - GAP, viewportHeight - EDGE);

    // Cap the height before measuring so a tall panel cannot grow past the top.
    const room = targetBottom - EDGE;
    const limit = Number(capPx) > 0 ? Math.min(room, Number(capPx)) : room;
    menu.style.maxHeight = `${Math.max(96, Math.round(limit))}px`;

    const probe = menu.getBoundingClientRect();
    const originX = probe.left;
    const originY = probe.top;
    const width = Math.min(probe.width, viewportWidth - EDGE * 2);
    const height = probe.height;

    // Centred on the conversation column, not the window: the sidebar owns the
    // left edge, so window-centring reads as "pushed right".
    const centerX = bounds && bounds.width ? bounds.left + bounds.width / 2 : viewportWidth / 2;
    const targetLeft = Math.max(EDGE, Math.min(centerX - width / 2, viewportWidth - EDGE - width));
    // Bottom edge sits on the composer's top border and crosses it by OVERLAP.
    const targetTop = Math.max(EDGE, targetBottom - height);

    menu.style.left = `${Math.round(targetLeft - originX)}px`;
    menu.style.top = `${Math.round(targetTop - originY)}px`;
    menu.style.bottom = 'auto';
  }

  /**
   * Show `id` centred over the composer, closing whatever else was open.
   * `capPx` optionally limits how tall the panel may grow.
   * Call right after the owning module made the panel visible.
   */
  function open(id, triggerId, capPx) {
    const menu = menuOf(id);
    if (!menu) return;
    closeOthers(id);
    openPanel = { menu, triggerId: triggerId || '', capPx: Number(capPx) || 0 };
    place(menu, triggerId, openPanel.capPx);
  }

  function reposition() {
    if (!openPanel) return;
    if (!visible(openPanel.menu)) { openPanel = null; return; }
    place(openPanel.menu, openPanel.triggerId, openPanel.capPx);
  }

  window.addEventListener('resize', reposition);
  window.addEventListener('orientationchange', reposition);

  // Any click that hides a panel leaves nothing to track. Runs after the
  // click's own handlers so it observes the final state.
  document.addEventListener('click', () => {
    queueMicrotask(() => { if (openPanel && !visible(openPanel.menu)) openPanel = null; });
  }, true);

  globalThis.IexaComposerMenu = { open, closeOthers, reposition, isOpen: (id) => visible(menuOf(id)) };
})();
