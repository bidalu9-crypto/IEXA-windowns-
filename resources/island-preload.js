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
  /**
   * main clamps to 132–340 wide and 40–560 tall, and accepts either a number
   * (height only) or `{ width, height }`. Passing the object straight through is
   * the whole contract: coercing it numerically yields NaN, which the old code
   * turned into 0, so every resize arrived as "height 0" and the pill could
   * never hug its text or grow when expanded.
   */
  resize: (request) => ipcRenderer.send('iexa:island-resize', request),
  /**
   * Dragging is a pointer gesture in the renderer because a CSS drag region
   * swallows clicks. `dragStart` returns the window origin once, `dragMove` sends
   * absolute x/y computed from it, so the window cannot drift on rounding.
   */
  dragStart: () => ipcRenderer.invoke('iexa:island-drag-start'),
  dragMove: (x, y) => ipcRenderer.send('iexa:island-drag-move', x, y),
  dragEnd: () => ipcRenderer.send('iexa:island-drag-end'),
});
