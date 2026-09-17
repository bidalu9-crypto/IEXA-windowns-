/* Main Electron window only. No browser/mobile window management or generic IPC. */
(() => {
  'use strict';
  const bridge = window.iexaDesktop;
  const controls = document.getElementById('windowControls');
  if (!controls || !bridge?.initialWindowState?.custom || typeof bridge.windowCommand !== 'function') return;
  document.documentElement.dataset.windowChrome = 'custom';
  controls.hidden = false;
  const maximize = document.getElementById('windowMaximize');
  function sync(state) {
    if (!state?.custom) return;
    document.documentElement.dataset.windowExpanded = String(!!(state.maximized || state.fullscreen));
    const label = state.fullscreen ? '退出全屏' : state.maximized ? '还原窗口' : '最大化';
    maximize.title = label; maximize.setAttribute('aria-label', label);
  }
  sync(bridge.initialWindowState);
  const unsubscribe = bridge.onWindowState?.(sync);
  for (const [id, command] of [['windowMinimize','minimize'],['windowMaximize','toggle-maximize'],['windowClose','close']]) {
    document.getElementById(id).addEventListener('click', () => {
      Promise.resolve(bridge.windowCommand(command)).catch(error => console.error('Window control:', error.message));
    });
  }
  const handles = [];
  let drag = null, frame = 0;
  const resize = request => Promise.resolve(bridge.windowResize(request)).catch(error => console.error('Window resize:', error.message));
  const finishResize = () => {
    if (!drag) return;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    resize({ phase: 'update' }); resize({ phase: 'end' }); drag = null;
  };
  if (typeof bridge.windowResize === 'function') for (const edge of ['n','s','e','w','ne','nw','se','sw']) {
    const handle = document.createElement('div');
    handle.className = 'window-resize-handle'; handle.dataset.edge = edge; handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId); drag = { edge, pointerId: event.pointerId };
      resize({ phase: 'start', edge });
    });
    handle.addEventListener('pointermove', () => {
      if (!drag || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (drag) resize({ phase: 'update' }); });
    });
    for (const event of ['pointerup','pointercancel','lostpointercapture']) handle.addEventListener(event, finishResize);
    document.body.appendChild(handle); handles.push(handle);
  }
  window.addEventListener('blur', finishResize);
  window.addEventListener('pagehide', () => { finishResize(); unsubscribe?.(); window.removeEventListener('blur', finishResize); handles.forEach(handle => handle.remove()); }, { once: true });
})();
