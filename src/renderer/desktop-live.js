(() => {
  const frame = document.querySelector('[data-live-frame]');
  const placeholder = document.querySelector('[data-live-placeholder]');
  const status = document.querySelector('[data-live-status]');
  const toggle = document.querySelector('[data-live-toggle]');
  const pin = document.querySelector('[data-live-pin]');
  const pinLabel = document.querySelector('[data-pin-label]');
  const controlMode = document.querySelector('[data-live-control-mode]');
  const controlRoute = document.querySelector('[data-live-control-route]');
  let enabled = true;
  let polling = false;
  let timer;
  let frameUrl;

  function showControl(state) {
    const control = state?.control;
    if (!control || typeof control !== 'object' || Array.isArray(control)) {
      controlMode.textContent = '模式未记录'; controlMode.dataset.mode = 'unknown'; controlMode.title = '';
      controlRoute.textContent = state?.observed === false ? '等待首次桌面操作' : '等待实际操控路径'; controlRoute.title = ''; return;
    }
    const mode = control.mode === 'background' || control.mode === 'foreground' ? control.mode : 'unknown';
    const backend = typeof control.backend === 'string' ? control.backend : '';
    const route = backend === 'native-isolated' ? '独立桌面' : backend === 'chromium-cdp' ? '浏览器' : backend === 'native' ? '应用控件' : '后端未记录';
    controlMode.textContent = mode === 'foreground' ? '前台 · 鼠标键盘' : `${mode === 'background' ? '后台' : '模式未记录'} · ${route}`;
    controlMode.dataset.mode = mode;
    const info = [backend ? `路径 ${backend.slice(0, 100)}` : '路径未记录'];
    if (typeof control.capability === 'string') info.push(control.capability.slice(0, 100));
    if (state.success === false) info.push('最近操作未成功');
    if (Number.isFinite(state.updatedAt) && state.updatedAt > 0) info.push(new Date(state.updatedAt).toLocaleTimeString());
    controlRoute.textContent = info.join(' · ');
    const detail = [controlMode.textContent, ...info];
    if (mode === 'background') detail.push('后台路径不回退到物理鼠标键盘。');
    if (control.providerMayChangeFocus === true) detail.push(backend === 'native' ? '应用控件可能自行改变焦点；此路径不代表独立桌面隔离。' : '应用控件或页面事件可能自行改变焦点。');
    controlMode.title = controlRoute.title = detail.join('\n');
  }

  function setPinned(pinned) {
    pin.setAttribute('aria-pressed', String(Boolean(pinned)));
    pinLabel.textContent = pinned ? '置顶' : '普通';
  }

  async function request(path, init) {
    const response = await fetch(path, init);
    if (!response.ok) {
      let detail = '';
      try {
        const payload = await response.clone().json();
        detail = typeof payload?.error === 'string' ? payload.error.trim() : '';
      } catch {}
      const error = new Error(detail || `请求失败 (${response.status})`); error.status = response.status; throw error;
    }
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
      try {
        const snapshot = await request('/api/desktop-live/status', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
        showControl(await snapshot.json());
      } catch (error) {
        controlMode.textContent = '模式未同步'; controlMode.dataset.mode = 'unknown';
        controlRoute.textContent = error?.message || '实际路径读取失败'; controlRoute.title = controlRoute.textContent;
      }
      // Frame transport is independent: a status failure never freezes the
      // last observation, and a returned image does not prove action success.
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
      const capturedAt = Number(response.headers.get('x-captured-at'));
      status.textContent = `最近观察快照 · ${capturedAt > 0 ? new Date(capturedAt).toLocaleTimeString() : '时间未知'}`;
    } catch (error) {
      if (enabled) {
        status.textContent = error?.message || '桌面服务连接失败';
        if (error?.status === 404 || error?.status === 410) {
          frame.hidden = true; frame.removeAttribute('src'); placeholder.hidden = false;
          placeholder.textContent = '当前操作暂无可用画面';
          if (frameUrl) { URL.revokeObjectURL(frameUrl); frameUrl = undefined; }
        }
      }
    } finally {
      polling = false;
      if (enabled) timer = setTimeout(poll, Math.max(500, 800 - (performance.now() - started)));
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
      const response = await request('/api/desktop-live/cancel', { method: 'POST' });
      const state = await response.json();
      enabled = false; clearTimeout(timer); toggle.textContent = '继续预览';
      status.textContent = state.settled ? '操作已暂停，采集已停止' : '已请求暂停，等待当前动作结束';
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
