// =============================================================================
// Zoom controls
//
// Electron's default menu maps zoom to `CommandOrControl+Plus`, `+` requires
// Shift+= on most layouts, so Ctrl+= produced the `=` key and did nothing. The
// built-in zoomOut had no floor either: repeated presses walked the factor down
// to Chromium's 0.25 and the only way back was Ctrl+0, which nobody knew.
//
// This module owns zoom end to end: it strips the default accelerators (so the
// handler below is the single source of truth) and clamps the factor to a
// readable range, which makes "stuck at an unusable size" impossible.
// =============================================================================

const DEFAULTS = { min: 0.75, max: 2, step: 0.1 };

/** Round to two decimals so 0.1 + 0.2 does not drift. */
function round(factor) {
  return Math.round(factor * 100) / 100;
}

function clampZoom(factor, { min = DEFAULTS.min, max = DEFAULTS.max } = {}) {
  const value = Number(factor);
  if (!Number.isFinite(value)) return 1;
  return round(Math.min(max, Math.max(min, value)));
}

function stepZoom(factor, direction, options = {}) {
  const { step = DEFAULTS.step } = { ...DEFAULTS, ...options };
  const base = Number.isFinite(Number(factor)) ? Number(factor) : 1;
  return clampZoom(base + direction * step, { ...DEFAULTS, ...options });
}

/** Which zoom command a key event means, or null. Alt is reserved for menus. */
function zoomCommandFor(input) {
  if (!input || input.type !== 'keyDown') return null;
  if (!(input.control || input.meta) || input.alt) return null;
  const key = String(input.key || '');
  const code = String(input.code || '');
  if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') return 'in';
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'out';
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset';
  return null;
}

/**
 * Rebuild the live application menu without the zoom entries.
 *
 * Dropping only the `accelerator` is not enough: a `zoomIn`/`zoomOut`/`resetZoom`
 * role re-attaches its default accelerator when the menu is built, so the item
 * itself has to go. Everything else is preserved — the default menu is expanded
 * into a template, so roles, labels and the other accelerators survive. This is
 * what makes the handler below authoritative: otherwise a real Ctrl+- would be
 * handled twice, once here and once by the menu role.
 */
function stripZoomAccelerators(Menu) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return null;
  const isZoomRole = (role) => /^(zoom|zoomin|zoomout|resetzoom)$/i.test(String(role || ''));

  const toTemplate = (items) => {
    const mapped = [];
    for (const item of items) {
      // The role would re-add its accelerator, so the whole item goes away.
      if (isZoomRole(item.role)) continue;
      if (item.type === 'separator') { mapped.push({ type: 'separator' }); continue; }
      const entry = {};
      if (item.role) entry.role = item.role;
      if (!item.role && item.label) entry.label = item.label;
      if (item.type && item.type !== 'normal') entry.type = item.type;
      if (item.accelerator) entry.accelerator = item.accelerator;
      if (item.submenu) entry.submenu = toTemplate(item.submenu.items);
      else if (item.click) entry.click = item.click;
      mapped.push(entry);
    }
    // Removing entries can leave doubled or dangling separators behind.
    return mapped.filter((entry, index) => {
      if (entry.type !== 'separator') return true;
      const previous = mapped[index - 1];
      const next = mapped[index + 1];
      return Boolean(previous) && previous.type !== 'separator' && Boolean(next);
    });
  };

  const rebuilt = Menu.buildFromTemplate(toTemplate(menu.items));
  Menu.setApplicationMenu(rebuilt);
  return rebuilt;
}

/**
 * Wire Ctrl/Cmd + = / + / - / 0 on one webContents.
 * Returns a disposer and the current factor reader, which the tests use.
 */
function installZoomControls(webContents, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  const apply = (factor) => {
    const next = clampZoom(factor, settings);
    webContents.setZoomFactor(next);
    if (onChange) onChange(next);
    return next;
  };

  const onInput = (event, input) => {
    const command = zoomCommandFor(input);
    if (!command) return;
    // Claim the key so neither the page nor a leftover accelerator sees it.
    event.preventDefault();
    if (command === 'reset') { apply(1); return; }
    apply(stepZoom(webContents.getZoomFactor(), command === 'in' ? 1 : -1, settings));
  };

  webContents.on('before-input-event', onInput);
  return {
    dispose() { webContents.removeListener('before-input-event', onInput); },
    current: () => webContents.getZoomFactor(),
    reset: () => apply(1),
  };
}

module.exports = {
  DEFAULTS,
  clampZoom,
  stepZoom,
  zoomCommandFor,
  stripZoomAccelerators,
  installZoomControls,
};
