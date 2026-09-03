// =============================================================================
// IEXA PC - Electron preload (safe bridge for folder picker)
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iexaDesktop', {
  initialAppearance: ipcRenderer.sendSync('iexa:get-initial-appearance'),
  pickFolder: () => ipcRenderer.invoke('iexa:pick-folder'),
  pickPluginFolder: () => ipcRenderer.invoke('iexa:pick-plugin-folder'),
  pickSkillFile: () => ipcRenderer.invoke('iexa:pick-skill-file'),
  openPath: (p) => ipcRenderer.invoke('iexa:open-path', p),
  revealPath: (p) => ipcRenderer.invoke('iexa:reveal-path', p),
  isDesktop: true,
});
