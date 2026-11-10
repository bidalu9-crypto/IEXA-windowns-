/* Typed server lifecycle -> tool-card presentation. Never infers success from elapsed time. */
(() => {
  'use strict';
  const states = Object.freeze({
    queued: ['queued','排队中'], awaiting_approval: ['awaiting-approval','等待批准'],
    running: ['running','执行中'], cancelling: ['cancelling','正在停止'],
    completed: ['done',undefined], failed: ['error',undefined], denied: ['denied','已拒绝'],
    cancelled: ['cancelled','已取消'], timed_out: ['timed-out','超时'], unknown: ['unknown','未记录结果'],
  });
  const terminal = new Set(['completed','failed','denied','cancelled','timed_out']);
  const desktopLabels = Object.freeze({ queued: '等待桌面控制权', observe: '观察窗口', resolve: '定位目标', action_start: '执行操作', action_end: '操作已返回', verify: '核对界面', completed: '本次操作结束', failed: '操作失败', takeover: '用户已接管 · 已停止输入', cancelled: '操作已取消' });
  const desktopEvents = new WeakMap();
  function desktopMode(block, metadata) {
    if (!block?.ownerDocument) return;
    const control = metadata?.desktop?.control;
    let badge = block.querySelector('.desktop-control-mode');
    if (!control || typeof control !== 'object' || Array.isArray(control)) {
      badge?.remove(); delete block.dataset.desktopMode; delete block.dataset.desktopBackend; return;
    }
    const mode = control.mode === 'background' || control.mode === 'foreground' ? control.mode : 'unknown';
    const backend = typeof control.backend === 'string' ? control.backend : typeof metadata.backend === 'string' ? metadata.backend : '';
    const route = backend === 'native-isolated' ? '独立桌面' : backend === 'chromium-cdp' ? '浏览器' : backend === 'native' ? '应用控件' : '后端未记录';
    const label = mode === 'foreground' ? '前台 · 鼠标键盘' : `${mode === 'background' ? '后台' : '模式未记录'} · ${route}`;
    if (!badge) {
      badge = block.ownerDocument.createElement('span'); badge.className = 'desktop-control-mode';
      const header = block.querySelector('.tool-header');
      if (header) header.append(badge); else block.append(badge);
    }
    badge.textContent = label; badge.dataset.mode = mode;
    const detail = [label, `后端：${backend.slice(0, 100) || '未记录'}`, `能力：${typeof control.capability === 'string' ? control.capability.slice(0, 100) : '未记录'}`];
    if (mode === 'background') detail.push('后台路径不回退到物理鼠标键盘。');
    if (control.providerMayChangeFocus === true) detail.push(backend === 'native' ? '应用控件可能自行改变焦点；此路径不代表独立桌面隔离。' : '应用控件或页面事件可能自行改变焦点。');
    badge.title = detail.join('\n'); badge.setAttribute('aria-label', label);
    block.dataset.desktopMode = mode; block.dataset.desktopBackend = backend.slice(0, 100);
  }
  function desktopTrace(block, incoming) {
    if (!Array.isArray(incoming) || !block?.ownerDocument) return;
    const doc = block.ownerDocument;
    const saved = desktopEvents.get(block) || new Map();
    for (const event of incoming) {
      if (event?.version === 1 && Object.hasOwn(desktopLabels, event.phase) && Number.isSafeInteger(event.sequence) && event.sequence > 0 && typeof event.operationId === 'string') saved.set(`${event.operationId}:${event.sequence}`, event);
    }
    desktopEvents.set(block, saved);
    incoming = [...saved.values()].sort((a, b) => a.sequence - b.sequence);
    let panel = block.querySelector('.desktop-control-trace');
    if (panel) { panel.querySelector('ol').replaceChildren(); panel.dataset.sequence = '0'; }
    for (const event of incoming) {
      if (event?.version !== 1 || !Object.hasOwn(desktopLabels, event.phase) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.operationId !== 'string') continue;
      if (!panel) {
        panel = doc.createElement('details'); panel.className = 'desktop-control-trace';
        const summary = doc.createElement('summary'); summary.className = 'desktop-control-phase';
        const list = doc.createElement('ol'); list.className = 'desktop-control-events';
        panel.append(summary, list); block.append(panel);
      }
      if (panel.dataset.operationId && panel.dataset.operationId !== event.operationId) continue;
      if (Number(panel.dataset.sequence || 0) >= event.sequence) continue;
      panel.dataset.operationId = event.operationId; panel.dataset.sequence = String(event.sequence);
      const active = !['completed', 'failed', 'takeover', 'cancelled'].includes(event.phase);
      panel.dataset.active = String(active); panel.dataset.phase = event.phase;
      const label = event.phase === 'verify' ? (event.verified ? '指定界面文字已核对' : '已采集后置画面 · 业务结果待确认') : desktopLabels[event.phase];
      const phaseSummary = panel.querySelector('summary');
      phaseSummary.textContent = label;
      window.IexaLabelGlow?.sync(phaseSummary, active);
      const item = doc.createElement('li'); item.dataset.phase = event.phase;
      const text = doc.createElement('span'); text.textContent = event.step ? `${event.step}/${event.totalSteps} · ${label}` : label;
      item.append(text);
      if (Number.isFinite(event.timestamp)) {
        const time = doc.createElement('time'); time.textContent = new Date(event.timestamp).toLocaleTimeString(); item.append(time);
      }
      panel.querySelector('ol').append(item);
    }
  }
  function present(block, status, render) {
    const state = Object.hasOwn(states, status) ? status : 'unknown';
    block.dataset.executionStatus = state;
    render(block, ...states[state]);
    window.IexaLabelGlow?.syncRow(block);
  }
  function apply(block, event, render) {
    if (!block || !event || event.version !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      typeof event.runId !== 'string' || !Object.hasOwn(states, event.status)) return false;
    if (block.dataset.toolRun && block.dataset.toolRun !== event.runId) return false;
    if (Number(block.dataset.toolSequence || 0) >= event.sequence) return false;
    if (terminal.has(block.dataset.executionStatus)) return false;
    block.dataset.toolRun = event.runId; block.dataset.toolSequence = String(event.sequence);
    if (Number.isFinite(event.startedAt)) block.dataset.startedAt = String(event.startedAt);
    present(block, event.status, render);
    if (event.desktop?.control) desktopMode(block, { desktop: event.desktop });
    if (event.desktop) desktopTrace(block, [event.desktop]);
    const panel = block.querySelector?.('.desktop-control-trace');
    if (panel && terminal.has(event.status)) panel.dataset.active = 'false';
    return true;
  }
  function applyResult(block, result, render) {
    // Prefer a recorded server terminal over legacy boolean-only results.
    const status = terminal.has(block.dataset.executionStatus) ? block.dataset.executionStatus
      : terminal.has(result?.executionStatus) ? result.executionStatus
      : !result ? 'unknown' : result.cancelled ? 'cancelled' : result.timedOut ? 'timed_out'
      : result.success === true ? 'completed' : result.success === false ? 'failed' : 'unknown';
    present(block, status, render);
    desktopMode(block, result?.metadata);
    desktopTrace(block, result?.metadata?.desktop?.events);
    const panel = block.querySelector?.('.desktop-control-trace');
    if (panel && terminal.has(status)) panel.dataset.active = 'false';
  }
  window.IexaToolLifecycleView = Object.freeze({ apply, applyResult });
})();
