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
  openDesktopLiveWindow: () => ipcRenderer.invoke('iexa:desktop-live-open'),
  getDesktopLiveWindowState: () => ipcRenderer.invoke('iexa:desktop-live-state'),
  setDesktopLivePinned: (pinned) => ipcRenderer.invoke('iexa:desktop-live-pin', Boolean(pinned)),
  minimizeDesktopLiveWindow: () => ipcRenderer.invoke('iexa:desktop-live-minimize'),
  closeDesktopLiveWindow: () => ipcRenderer.invoke('iexa:desktop-live-close'),
  onDesktopLiveClosed: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('iexa:desktop-live-closed', listener);
    return () => ipcRenderer.removeListener('iexa:desktop-live-closed', listener);
  },
  isDesktop: true,
});
