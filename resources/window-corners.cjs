'use strict';
const os = require('node:os');

// Use only with a frameless window. On Win10 thickFrame is disabled so these
// device-independent coordinates match the actual client/window surface.
function roundedWindowRects(width, height, radius = 12) {
  width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(width / 2), Math.floor(height / 2)));
  if (!r) return [{ x: 0, y: 0, width, height }];
  const rects = [];
  for (let y = 0; y < r; y++) {
    const inset = Math.ceil(r - Math.sqrt(r * r - (r - y - 0.5) ** 2));
    rects.push({ x: inset, y, width: width - inset * 2, height: 1 });
    rects.push({ x: inset, y: height - y - 1, width: width - inset * 2, height: 1 });
  }
  if (height > 2 * r) rects.push({ x: 0, y: r, width, height: height - 2 * r });
  return rects.filter(rect => rect.width > 0);
}

function installWindowCorners(win, options = {}) {
  const platform = options.platform || process.platform;
  const release = options.release || os.release();
  // Windows 11 keeps DWM's native rounding/shadow for the frameless window.
  // Do not install a custom region there: it would override the native treatment.
  const build = Number(release.split('.')[2]) || 0;
  if (options.frameless !== true || platform !== 'win32' || build >= 22000 || typeof win.setShape !== 'function') return () => {};
  let lastKey = '', disposed = false;
  const refresh = () => {
    if (disposed || win.isDestroyed()) return;
    const [width, height] = win.getSize();
    const rectangular = win.isMaximized() || (options.getFullScreen ? options.getFullScreen() : win.isFullScreen());
    const scale = options.getScaleFactor ? options.getScaleFactor() : 1;
    const key = rectangular ? 'rectangular' : `${width}:${height}:${scale}`;
    if (key === lastKey) return;
    try {
      win.setShape(rectangular ? [] : roundedWindowRects(width, height, options.radius ?? 12));
      lastKey = key;
    } catch (error) {
      // A compositor/driver rejecting the optional shape must not prevent launch.
      try { win.setShape([]); } catch { /* retain the OS frame */ }
      (options.onError || console.warn)('[IEXA] Window corner fallback:', error.message);
    }
  };
  const events = ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore', 'show'];
  for (const event of events) win.on(event, refresh);
  const cleanup = () => { disposed = true; for (const event of events) win.removeListener(event, refresh); win.removeListener('closed', cleanup); };
  win.once('closed', cleanup);
  refresh();
  return cleanup;
}
module.exports = { roundedWindowRects, installWindowCorners };
