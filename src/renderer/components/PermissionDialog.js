(function () {
  var dialogs = new Map();
  function close(id) {
    var entry = dialogs.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.overlay.remove(); dialogs.delete(id);
    var remaining = Array.from(dialogs.values()).pop();
    if (remaining) remaining.overlay.querySelector('button:not(:disabled)')?.focus();
    else if (entry.previousFocus?.isConnected) entry.previousFocus.focus();
  }
  function closeForTool(sessionId, toolCallId, runId) {
    for (var [id, entry] of dialogs) if (entry.sessionId === sessionId && entry.toolCallId === toolCallId && (!entry.runId || entry.runId === runId)) close(id);
  }
  function closeSession(sessionId) {
    for (var [id, entry] of dialogs) if (entry.sessionId === sessionId) close(id);
  }
  function show(data, options) {
    options = options || {};
    if (!data || !data.id || dialogs.has(data.id) || (data.expiresAt && data.expiresAt <= Date.now())) return;
    var previousFocus = document.activeElement;
    var overlay = document.createElement('div');
    overlay.className = 'permission-dialog-overlay';
    overlay.dataset.permissionId = data.id;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    var dialog = document.createElement('div'); dialog.className = 'permission-dialog';
    var title = document.createElement('h3'); title.textContent = '需要工具权限';
    title.id = 'permission-title-' + String(data.id).replace(/[^a-z0-9_-]/gi, '');
    overlay.setAttribute('aria-labelledby', title.id);
    var description = document.createElement('p'); description.textContent = 'IEXA 请求执行 ' + (data.tool?.name || '工具') + '（' + (data.tool?.risk || 'unknown') + ' 风险）。';
    var command = document.createElement('pre');
    var args = data.args || {}; command.textContent = typeof args.command === 'string' ? args.command : JSON.stringify(args, null, 2);
    var actions = document.createElement('div'); actions.className = 'permission-dialog-actions';
    var deny = makeButton('拒绝', 'permission-action permission-action-danger');
    var once = makeButton('允许一次', 'permission-action permission-action-secondary');
    var session = makeButton('允许本会话', 'permission-action permission-action-primary');
    actions.append(deny, once, session); dialog.append(title, description, command, actions); overlay.appendChild(dialog); document.body.appendChild(overlay);
    var timer = data.expiresAt ? setTimeout(function () { close(data.id); }, Math.min(2147483647, Math.max(0, data.expiresAt - Date.now()))) : undefined;
    dialogs.set(data.id, { overlay: overlay, sessionId: data.sessionId, toolCallId: data.toolCallId, runId: data.runId, previousFocus: previousFocus, timer: timer });
    var busy = false;
    async function decide(endpoint, body) {
      if (busy || !dialogs.has(data.id)) return;
      busy = true;
      [deny, once, session].forEach(function (button) { button.disabled = true; });
      overlay.setAttribute('aria-busy', 'true');
      try {
        await window.IexaApi.json((options.apiBase || '') + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: data.id }, body)) });
        close(data.id);
      } catch (error) {
        if (!dialogs.has(data.id)) return;
        busy = false; overlay.removeAttribute('aria-busy');
        [deny, once, session].forEach(function (button) { button.disabled = false; });
        if (typeof options.onError === 'function') options.onError(error.message || String(error));
      }
    }
    deny.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); void decide('/api/permissions/deny', {}); });
    once.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); void decide('/api/permissions/approve', { scope: 'once' }); });
    session.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); void decide('/api/permissions/approve', { scope: 'session' }); });
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); deny.click(); }
      if (event.key === 'Tab') {
        var buttons = [deny, once, session].filter(function (button) { return !button.disabled; });
        event.preventDefault();
        if (buttons.length) { var index = buttons.indexOf(document.activeElement); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus(); }
      }
    });
    deny.focus();
  }
  function makeButton(label, className) { var button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; return button; }
  window.IexaPermissionDialog = { show: show, close: close, closeForTool: closeForTool, closeSession: closeSession };
}());
