'use strict';
const fullscreenStates = new WeakMap();
function isWindowFullscreen(win) { return fullscreenStates.has(win) ? fullscreenStates.get(win) : win.isFullScreen(); }
function trackWindowState(win) {
  fullscreenStates.set(win, win.isFullScreen());
  // Win10 thickFrame:false emits fullscreen events but Electron's widget query
  // remains false. Track the authoritative transition events for this window.
  win.on('enter-full-screen', () => fullscreenStates.set(win, true));
  win.on('leave-full-screen', () => fullscreenStates.set(win, false));
  win.once('closed', () => fullscreenStates.delete(win));
}

function mainWindowChromeOptions(platform = process.platform, release = require('node:os').release()) {
  if (platform !== 'win32') return {};
  const legacyWindows = (Number(release.split('.')[2]) || 0) < 22000;
  // On Win10 remove the invisible native sizing frame too: its geometry and
  // classic non-client painting conflict with a shaped, modern client surface.
  return { frame: false, roundedCorners: true, ...(legacyWindows ? { thickFrame: false } : {}) };
}
function mainWindowState(win, platform = process.platform) {
  if (platform !== 'win32' || !win || win.isDestroyed()) return null;
  return { custom: true, maximized: win.isMaximized(), fullscreen: isWindowFullscreen(win) };
}
function runWindowCommand(win, sender, command, platform = process.platform) {
  if (!mainWindowState(win, platform) || sender !== win.webContents) throw new Error('Window control sender rejected');
  if (!['minimize', 'toggle-maximize', 'close'].includes(command)) throw new Error('Unknown window command');
  if (command === 'minimize') win.minimize();
  else if (command === 'toggle-maximize') {
    if (isWindowFullscreen(win)) win.setFullScreen(false);
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else win.close(); // Preserve the application's existing close/shutdown lifecycle.
}
const resizeEdges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
function resizedBounds(bounds, origin, cursor, edge, minimum, maximum = [0, 0]) {
  if (!resizeEdges.includes(edge)) throw new Error('Unknown resize edge');
  const dx = cursor.x - origin.x, dy = cursor.y - origin.y;
  const result = { ...bounds };
  const clamp = (value, min, max) => Math.max(min || 1, Math.min(max || Infinity, value));
  if (edge.includes('e')) result.width = clamp(bounds.width + dx, minimum[0], maximum[0]);
  if (edge.includes('s')) result.height = clamp(bounds.height + dy, minimum[1], maximum[1]);
  if (edge.includes('w')) { result.width = clamp(bounds.width - dx, minimum[0], maximum[0]); result.x = bounds.x + bounds.width - result.width; }
  if (edge.includes('n')) { result.height = clamp(bounds.height - dy, minimum[1], maximum[1]); result.y = bounds.y + bounds.height - result.height; }
  return result;
}
function createWindowResize(win, getCursor) {
  let start = null;
  const cancel = () => { start = null; };
  for (const event of ['blur', 'maximize', 'enter-full-screen', 'closed']) win.on(event, cancel);
  return (sender, request) => {
    if (win.isDestroyed() || sender !== win.webContents) throw new Error('Resize sender rejected');
    if (!request || !['start', 'update', 'end'].includes(request.phase)) throw new Error('Unknown resize phase');
    if (request.phase === 'end') { cancel(); return; }
    if (win.isMaximized() || isWindowFullscreen(win)) { cancel(); return; }
    if (request.phase === 'start') {
      if (!resizeEdges.includes(request.edge)) throw new Error('Unknown resize edge');
      start = { edge: request.edge, bounds: win.getBounds(), cursor: getCursor() }; return;
    }
    if (start) win.setBounds(resizedBounds(start.bounds, start.cursor, getCursor(), start.edge, win.getMinimumSize(), win.getMaximumSize()), false);
  };
}
module.exports = { mainWindowChromeOptions, mainWindowState, runWindowCommand, resizedBounds, createWindowResize, trackWindowState, isWindowFullscreen };
