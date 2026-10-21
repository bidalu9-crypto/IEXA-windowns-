// =============================================================================
// IEXA - Desktop pet preload
//
// A deliberately small bridge: the pet surface may move its own window, report
// a click and ask for the menu actions. It gets no filesystem, no IPC channel
// names and no way to reach the main window's DOM.
// =============================================================================
const { contextBridge, ipcRenderer } = require('electron');

const send = (channel, payload) => {
  try { ipcRenderer.send(channel, payload); } catch { /* host gone */ }
};

contextBridge.exposeInMainWorld('iexaPet', {
  /** Current sprite version and behaviour config, read once at load. */
  initialState: (() => {
    try { return ipcRenderer.sendSync('iexa:pet-initial-state'); } catch { return null; }
  })(),
  ready: () => send('iexa:pet-ready'),
  dragStart: (point) => send('iexa:pet-drag-start', point),
  dragMove: (delta) => send('iexa:pet-drag-move', delta),
  dragEnd: () => send('iexa:pet-drag-end'),
  poked: () => send('iexa:pet-poked'),
  openMain: () => send('iexa:pet-open-main'),
  setWander: (wander) => send('iexa:pet-set-wander', Boolean(wander)),
  menuAction: (action) => send('iexa:pet-menu', String(action)),
});
