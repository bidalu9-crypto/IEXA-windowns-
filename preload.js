// =============================================================================
// IEXA PC - Electron preload (safe bridge for folder picker)
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

const ideCall = async (name, input) => {
  const result = await ipcRenderer.invoke(`iexa:ide:${name}`, input);
  if (result && result.__ideError) {
    const error = new Error(result.__ideError.message);
    error.code = result.__ideError.code;
    error.diagnostics = result.__ideError.diagnostics || [];
    throw error;
  }
  return result;
};
const ide = {
  chooseFolder: () => ideCall('choose-folder'),
  projects: () => ideCall('projects'),
  currentProject: () => ideCall('current-project'),
  list: input => ideCall('list', input),
  search: input => ideCall('search', input),
  read: input => ideCall('read', input),
  write: input => ideCall('write', input),
  create: input => ideCall('create', input),
  rename: input => ideCall('rename', input),
  remove: input => ideCall('remove', input),
  inspect: input => ideCall('inspect', input),
  runPlan: input => ideCall('run-plan', input),
  // Keep formatter diagnostics as structured data across contextBridge; custom
  // properties attached to a thrown Error are not preserved by every Electron.
  format: input => ipcRenderer.invoke('iexa:ide:format', input),
  formatCancel: input => ideCall('format-cancel', input),
  languageRequest: input => ideCall('language-request', input),
  languageStatus: input => ideCall('language-status', input),
  gitStatus: input => ideCall('git-status', input),
  gitDiff: input => ideCall('git-diff', input),
  reviewList: input => ideCall('review-list', input),
  reviewRead: input => ideCall('review-read', input),
  reviewAction: input => ideCall('review-action', input),
  start: input => ideCall('start', input),
  stop: input => ideCall('stop', input),
  restart: input => ideCall('restart', input),
  status: input => ideCall('status', input),
  preview: input => ideCall('preview', input),
  context: input => ideCall('context', input),
  onEvent: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, event) => callback(event);
    ipcRenderer.on('iexa:ide:event', listener);
    return () => ipcRenderer.removeListener('iexa:ide:event', listener);
  },
};

contextBridge.exposeInMainWorld('iexaDesktop', {
  ide,
  initialAppearance: ipcRenderer.sendSync('iexa:get-initial-appearance'),
  initialWindowState: ipcRenderer.sendSync('iexa:get-window-state'),
  windowResize: (request) => ipcRenderer.invoke('iexa:window-resize', request),
  windowCommand: (command) => ipcRenderer.invoke('iexa:window-command', command),
  onWindowState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('iexa:window-state', listener);
    return () => ipcRenderer.removeListener('iexa:window-state', listener);
  },
  pickFolder: () => ipcRenderer.invoke('iexa:pick-folder'),
  pickPluginFolder: () => ipcRenderer.invoke('iexa:pick-plugin-folder'),
  pickSkillFile: () => ipcRenderer.invoke('iexa:pick-skill-file'),
  openPath: (p) => ipcRenderer.invoke('iexa:open-path', p),
  openFile: (p) => ipcRenderer.invoke('iexa:open-file', p),
  runFile: (p) => ipcRenderer.invoke('iexa:run-file', p),
  openExternal: (url) => ipcRenderer.invoke('iexa:open-external', url),
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
