// The island page runs sandboxed: it gets exactly four verbs and no filesystem,
// no IPC channel names, no host details.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iexaIsland', {
  initial: () => ipcRenderer.sendSync('iexa:island-initial'),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('iexa:island-state', listener);
    return () => ipcRenderer.removeListener('iexa:island-state', listener);
  },
  resize: (height) => ipcRenderer.send('iexa:island-resize', Number(height) || 0),
});
