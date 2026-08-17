(function () {
  var dialogs = new Map();

  function show(data, options) {
    if (!data || !data.id || dialogs.has(data.id)) return;
    var overlay = document.createElement('div');
    overlay.className = 'permission-dialog-overlay';
    overlay.dataset.permissionId = data.id;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var dialog = document.createElement('div');
    dialog.className = 'permission-dialog';
    var title = document.createElement('h3'); title.textContent = '需要工具权限';
    var description = document.createElement('p'); description.textContent = 'IEXA 请求执行 ' + (data.tool?.name || '工具') + '（' + (data.tool?.risk || 'unknown') + ' 风险）。';
    var command = document.createElement('pre');
    var args = data.args || {}; command.textContent = typeof args.command === 'string' ? args.command : JSON.stringify(args, null, 2);
    var actions = document.createElement('div'); actions.className = 'permission-dialog-actions';
    var deny = makeButton('拒绝', 'permission-action permission-action-danger');
    var once = makeButton('允许一次', 'permission-action permission-action-secondary');
    var session = makeButton('允许本会话', 'permission-action permission-action-primary');
    actions.append(deny, once, session); dialog.append(title, description, command, actions); overlay.appendChild(dialog); document.body.appendChild(overlay); dialogs.set(data.id, overlay);

    function close() { overlay.remove(); dialogs.delete(data.id); }
    async function decide(endpoint, body) {
      [deny, once, session].forEach(function (button) { button.disabled = true; });
      try { await window.IexaApi.json((options.apiBase || '') + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: data.id }, body)) }); close(); }
      catch (error) { [deny, once, session].forEach(function (button) { button.disabled = false; }); options.onError(error.message || String(error)); }
    }
    deny.addEventListener('click', function () { decide('/api/permissions/deny', {}); });
    once.addEventListener('click', function () { decide('/api/permissions/approve', { scope: 'once' }); });
    session.addEventListener('click', function () { decide('/api/permissions/approve', { scope: 'session' }); });
  }

  function makeButton(label, className) { var button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; return button; }
  window.IexaPermissionDialog = { show: show };
}());
