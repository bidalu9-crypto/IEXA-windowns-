// =============================================================================
// IEXA PC - Electron preload (safe bridge for folder picker)
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iexaDesktop', {
  pickFolder: () => ipcRenderer.invoke('iexa:pick-folder'),
  pickSkillFile: () => ipcRenderer.invoke('iexa:pick-skill-file'),
  openPath: (p) => ipcRenderer.invoke('iexa:open-path', p),
  isDesktop: true,
});
