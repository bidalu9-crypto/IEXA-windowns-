// =============================================================================
// IEXA PC - capture picker preload
//
// The picker page runs without Node access; this bridge exposes exactly two
// calls: pick a surface, or cancel. The source list is injected by the main
// process after the page loads (ipcMain.handle is rejected for file:// senders).
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capturePicker', {
  choose: (id) => ipcRenderer.send('iexa:capture-choose', String(id || '')),
  cancel: () => ipcRenderer.send('iexa:capture-cancel'),
});
