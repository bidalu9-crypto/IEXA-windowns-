(() => {
  const frame = document.querySelector('[data-live-frame]');
  const placeholder = document.querySelector('[data-live-placeholder]');
  const status = document.querySelector('[data-live-status]');
  const toggle = document.querySelector('[data-live-toggle]');
  const pin = document.querySelector('[data-live-pin]');
  const pinLabel = document.querySelector('[data-pin-label]');
  let enabled = true;
  let polling = false;
  let timer;
  let frameUrl;

  function setPinned(pinned) {
    pin.setAttribute('aria-pressed', String(Boolean(pinned)));
    pinLabel.textContent = pinned ? '置顶' : '普通';
  }

  async function request(path, init) {
    const response = await fetch(path, init);
    if (!response.ok) throw new Error(`请求失败 (${response.status})`);
    return response;
  }

  async function poll() {
    if (!enabled || polling) return;
    if (document.visibilityState !== 'visible') {
      timer = setTimeout(poll, 400);
      return;
    }
    polling = true;
    const started = performance.now();
    try {
      const response = await request('/api/desktop-live/frame', {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      const blob = await response.blob();
      if (!enabled) return;
      const previous = frameUrl;
      frameUrl = URL.createObjectURL(blob);
      frame.src = frameUrl;
      frame.hidden = false;
      placeholder.hidden = true;
      if (previous) URL.revokeObjectURL(previous);
      status.textContent = `${Math.round(performance.now() - started)} ms · ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (enabled) status.textContent = error?.message || '桌面服务连接失败';
    } finally {
      polling = false;
      if (enabled) timer = setTimeout(poll, Math.max(100, 250 - (performance.now() - started)));
    }
  }

  toggle.addEventListener('click', () => {
    enabled = !enabled;
    toggle.textContent = enabled ? '暂停预览' : '继续预览';
    clearTimeout(timer);
    if (enabled) poll();
    else status.textContent = '预览已暂停';
  });

  document.querySelector('[data-live-stop]').addEventListener('click', async () => {
    try {
      await request('/api/desktop-live/cancel', { method: 'POST' });
      status.textContent = '已停止并释放输入';
    } catch (error) { status.textContent = error?.message || '停止请求失败'; }
  });

  document.querySelector('[data-live-resume]').addEventListener('click', async () => {
    try {
      await request('/api/desktop-live/resume', { method: 'POST' });
      status.textContent = '操作权限已恢复';
    } catch (error) { status.textContent = error?.message || '恢复请求失败'; }
  });

  pin.addEventListener('click', async () => {
    const next = pin.getAttribute('aria-pressed') !== 'true';
    const state = await window.iexaDesktop?.setDesktopLivePinned?.(next);
    setPinned(state?.pinned ?? next);
  });
  document.querySelector('[data-window-minimize]').addEventListener('click', () => window.iexaDesktop?.minimizeDesktopLiveWindow?.());
  document.querySelector('[data-window-close]').addEventListener('click', () => window.iexaDesktop?.closeDesktopLiveWindow?.());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.iexaDesktop?.closeDesktopLiveWindow?.();
  });
  document.addEventListener('visibilitychange', () => {
    if (enabled && document.visibilityState === 'visible') poll();
  });
  window.addEventListener('beforeunload', () => {
    enabled = false;
    clearTimeout(timer);
    if (frameUrl) URL.revokeObjectURL(frameUrl);
  });

  window.iexaDesktop?.getDesktopLiveWindowState?.().then((state) => setPinned(state?.pinned !== false));
  poll();
})();
