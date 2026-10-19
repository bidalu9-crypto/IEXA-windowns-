// =============================================================================
// Authenticated mobile bridge
//
// Same-Wi-Fi pairing gate, device list and the mobile drawer state that
// follows it.
//
// Classic script. Top-level declarations land in the global lexical scope, so
// app.js and the other services keep calling these by bare name. index.html
// fixes the load order; this file runs nothing when it is evaluated.
// =============================================================================
let mobileBridgeState = null;
let mobileBridgeExpiryTimer = null;

function mobileDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 手机';
  return '移动浏览器';
}

async function verifyMobileAccess() {
  const pairingURL = new URL(location.href);
  const fragment = new URLSearchParams(pairingURL.hash.slice(1));
  const token = fragment.get('pair') || pairingURL.searchParams.get('pair') || '';
  // Scrub even when the device is already paired, and before ANY network request.
  if (fragment.has('pair') || pairingURL.searchParams.has('pair')) {
    fragment.delete('pair');
    pairingURL.searchParams.delete('pair');
    pairingURL.hash = fragment.toString();
    history.replaceState({}, '', pairingURL.pathname + pairingURL.search + pairingURL.hash);
  }
  const gate = document.getElementById('mobilePairGate');
  const message = document.getElementById('mobilePairMessage');
  const retry = document.getElementById('mobilePairRetry');
  if (!gate || !message || !retry) return true;
  try {
    const status = await fetch(`${API_BASE}/api/mobile-bridge/client-status`, { cache: 'no-store' }).then((response) => response.json());
    if (status.authenticated) {
      document.body.dataset.mobileClient = status.local ? 'desktop' : 'paired';
      document.body.dataset.mobileCapability = status.capability || 'full';
      gate.hidden = true;
      return true;
    }
    gate.hidden = false;
    document.body.classList.add('is-pairing');
    if (!token) {
      message.textContent = status.bridgeEnabled ? '请在电脑端“设备与桥接”页面重新扫描配对二维码。' : '电脑端的手机桥接当前已关闭。';
      retry.hidden = true;
      return false;
    }
    message.textContent = '正在建立安全连接…';
    const response = await fetch(`${API_BASE}/api/mobile-bridge/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name: mobileDeviceName() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '配对失败。');
    document.body.dataset.mobileClient = 'paired';
    document.body.dataset.mobileCapability = data.device?.capability || 'chat';
    document.body.classList.remove('is-pairing');
    gate.hidden = true;
    return true;
  } catch (error) {
    gate.hidden = false;
    message.textContent = error.message || String(error);
    retry.hidden = false;
    retry.onclick = () => location.reload();
    return false;
  }
}

function formatMobileTime(value) {
  if (!value) return '从未连接';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function capabilityLabel(value) {
  return value === 'full' ? '完整控制' : value === 'files' ? '聊天与文件' : '仅聊天';
}

function showMobileBridgeResult(message, error = false) {
  const result = document.getElementById('mobileBridgeResult');
  if (!result) return;
  result.hidden = !message;
  result.className = `sync-result ${error ? 'sync-error' : 'sync-info'}`;
  result.textContent = message || '';
}

function renderMobileBridge(state) {
  mobileBridgeState = state;
  const enabled = document.getElementById('mobileBridgeEnabled');
  const live = document.getElementById('mobileBridgeLive');
  const offline = document.getElementById('mobileBridgeOffline');
  const address = document.getElementById('mobileBridgeAddress');
  const capability = document.getElementById('mobileBridgeCapability');
  const devices = document.getElementById('mobileBridgeDevices');
  if (!enabled || !live || !offline || !address || !capability || !devices) return;
  enabled.checked = !!state.enabled;
  live.hidden = !state.enabled;
  offline.hidden = !!state.enabled;
  capability.value = state.defaultCapability || 'chat';
  const selected = address.value;
  address.innerHTML = (state.addresses || []).map((ip) => `<option value="${escapeHtml(ip)}">${escapeHtml(ip)}:${Number(state.port) || ''}</option>`).join('');
  if (selected && (state.addresses || []).includes(selected)) address.value = selected;
  if (!(state.addresses || []).length) address.innerHTML = '<option value="">未检测到局域网</option>';
  const list = state.devices || [];
  devices.innerHTML = list.length ? list.map((device) => `<div class="mobile-device-row" data-mobile-device="${escapeHtml(device.id)}">
    <span class="mobile-device-kind">${uiIcon('smartphone')}</span>
    <span class="mobile-device-info"><strong>${escapeHtml(device.name)}</strong><small>最近连接 ${formatMobileTime(device.lastActiveAt)}</small></span>
    <select class="mobile-device-capability" title="设备权限" aria-label="设备权限"><option value="chat" ${device.capability === 'chat' ? 'selected' : ''}>仅聊天</option><option value="files" ${device.capability === 'files' ? 'selected' : ''}>聊天与文件</option><option value="full" ${device.capability === 'full' ? 'selected' : ''}>完整控制</option></select>
    <button type="button" class="plugin-icon-action mobile-device-revoke" title="移除此设备" aria-label="移除此设备">${uiIcon('trash')}</button>
  </div>`).join('') : '<div class="mobile-device-empty">还没有已配对设备</div>';
  devices.querySelectorAll('[data-mobile-device]').forEach((row) => row.querySelector('button')?.addEventListener('click', () => revokeMobileDevice(row.dataset.mobileDevice)));
  devices.querySelectorAll('[data-mobile-device]').forEach((row) => row.querySelector('select')?.addEventListener('change', (event) => updateMobileDeviceCapability(row.dataset.mobileDevice, event.currentTarget.value)));
}

async function loadMobileBridge() {
  try {
    const response = await fetch(`${API_BASE}/api/mobile-bridge/status`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取桥接状态失败。');
    renderMobileBridge(data);
  } catch (error) { showMobileBridgeResult(error.message || String(error), true); }
}

async function configureMobileBridge(changes) {
  const response = await fetch(`${API_BASE}/api/mobile-bridge/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '桥接配置保存失败。');
  renderMobileBridge(data);
  return data;
}

async function createMobilePairCode() {
  const button = document.getElementById('mobileBridgePairBtn');
  try {
    button.disabled = true;
    const address = document.getElementById('mobileBridgeAddress').value;
    const response = await fetch(`${API_BASE}/api/mobile-bridge/pair-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '二维码生成失败。');
    const image = document.getElementById('mobileBridgeQr');
    image.src = data.qrDataUrl;
    image.hidden = false;
    document.getElementById('mobileBridgeQrPlaceholder').hidden = true;
    document.getElementById('mobileBridgeUrl').textContent = data.url;
    if (mobileBridgeExpiryTimer) clearInterval(mobileBridgeExpiryTimer);
    const expiry = document.getElementById('mobileBridgeExpiry');
    const update = () => {
      const seconds = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000));
      expiry.textContent = seconds ? `二维码一次有效，${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后失效。` : '二维码已失效，请重新生成。';
      if (!seconds) clearInterval(mobileBridgeExpiryTimer);
    };
    update();
    mobileBridgeExpiryTimer = setInterval(update, 1000);
    showMobileBridgeResult('二维码已生成。手机与电脑连接同一个 Wi-Fi 后直接扫码。');
  } catch (error) { showMobileBridgeResult(error.message || String(error), true); }
  finally { button.disabled = false; }
}

async function revokeMobileDevice(id) {
  const response = await fetch(`${API_BASE}/api/mobile-bridge/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) { showMobileBridgeResult(data.error || '移除失败。', true); return; }
  await loadMobileBridge();
}

async function updateMobileDeviceCapability(id, capability) {
  const response = await fetch(`${API_BASE}/api/mobile-bridge/devices/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capability }),
  });
  const data = await response.json();
  if (!response.ok) { showMobileBridgeResult(data.error || '权限保存失败。', true); await loadMobileBridge(); return; }
  showMobileBridgeResult(`${data.device.name} 已设为“${capabilityLabel(data.device.capability)}”。`);
  await loadMobileBridge();
}

function initMobileBridge() {
  document.getElementById('mobileBridgeEnabled')?.addEventListener('change', async (event) => {
    try {
      await configureMobileBridge({ enabled: event.currentTarget.checked });
      showMobileBridgeResult(event.currentTarget.checked ? '手机桥接已开启。现在可以生成二维码。' : '手机桥接已关闭，所有手机连接已被阻止。');
    } catch (error) { event.currentTarget.checked = !event.currentTarget.checked; showMobileBridgeResult(error.message || String(error), true); }
  });
  document.getElementById('mobileBridgeCapability')?.addEventListener('change', async (event) => {
    try { await configureMobileBridge({ defaultCapability: event.currentTarget.value }); }
    catch (error) { showMobileBridgeResult(error.message || String(error), true); }
  });
  document.getElementById('mobileBridgePairBtn')?.addEventListener('click', createMobilePairCode);
  document.getElementById('mobileBridgeRevokeAll')?.addEventListener('click', async () => {
    if (!(await window.IexaDialogs.confirm('移除全部已配对设备？这些手机需要重新扫码才能连接。'))) return;
    await fetch(`${API_BASE}/api/mobile-bridge/devices`, { method: 'DELETE' });
    await loadMobileBridge();
  });
}

async function loadWebDAVConfig() {
  try {
    const resp = await fetch(`${API_BASE}/api/webdav/config`);
    const cfg = await resp.json();
    document.getElementById('webdavUrl').value = cfg.url || '';
    document.getElementById('webdavUser').value = cfg.username || '';
    document.getElementById('webdavPass').value = cfg.password || '';
    document.getElementById('webdavAutoSync').checked = cfg.autoSync || false;
    updateSyncStatus(cfg);
    loadSyncConflicts();
  } catch (err) {
    console.error('Failed to load WebDAV config:', err);
  }
}

async function saveWebDAVConfig() {
  const cfg = {
    url: document.getElementById('webdavUrl').value.trim(),
    username: document.getElementById('webdavUser').value.trim(),
    password: document.getElementById('webdavPass').value,
    autoSync: document.getElementById('webdavAutoSync').checked,
    enabled: true,
  };

  try {
    const resp = await fetch(`${API_BASE}/api/webdav/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await resp.json();
    showSyncResult(data.ok ? 'success' : 'error', data.ok ? '配置已保存。' : '保存失败。');
    loadWebDAVConfig();
  } catch (err) {
    showSyncResult('error', '保存失败：' + err.message);
  }
}

async function testWebDAV() {
  const url = document.getElementById('webdavUrl').value.trim();
  const username = document.getElementById('webdavUser').value.trim();
  const password = document.getElementById('webdavPass').value;

  if (!url) {
    showSyncResult('error', '请输入 WebDAV 服务器地址。');
    return;
  }

  showSyncResult('info', '正在测试连接...');

  try {
    const resp = await fetch(`${API_BASE}/api/webdav/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, username, password }),
    });
    const data = await resp.json();
    if (data.ok) {
      showSyncResult('success', '连接成功！WebDAV 服务器可达。');
    } else {
      showSyncResult('error', '连接失败：' + (data.error || '未知错误'));
    }
  } catch (err) {
    showSyncResult('error', '连接失败：' + err.message);
  }
}

async function syncNow() {
  const btn = document.getElementById('syncNowBtn');
  btn.disabled = true;
  btn.classList.add('is-loading');
  const syncLabel = btn.querySelector('span');
  if (syncLabel) syncLabel.textContent = '同步中...';
  showSyncResult('info', '正在同步...');

  try {
    const resp = await fetch(`${API_BASE}/api/webdav/sync`, { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      const conflictNote = conflicts.length
        ? `检测到 ${conflicts.length} 个双端修改冲突，远端副本已保留到 .iexa-sync-conflicts。`
        : '';
      showSyncResult(conflicts.length ? 'info' : 'success', `同步完成！上传 ${data.uploaded}，下载 ${data.downloaded} 个文件。${conflictNote}`);
      loadSyncConflicts();
    } else {
      showSyncResult('error', '同步失败：' + (data.error || '未知错误'));
    }
  } catch (err) {
    showSyncResult('error', '同步失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    const syncLabel = btn.querySelector('span');
    if (syncLabel) syncLabel.textContent = '立即同步';
    loadWebDAVConfig();
  }
}

function updateSyncStatus(cfg) {
  const icon = document.getElementById('syncStatusIcon');
  const text = document.getElementById('syncStatusText');
  const lastTime = document.getElementById('syncLastTime');

  if (!cfg.url) {
    icon.className = 'sync-status-icon is-idle';
    icon.innerHTML = uiIcon('info');
    text.textContent = '未配置';
    lastTime.textContent = '';
  } else if (cfg.lastSync && cfg.lastSync > 0) {
    icon.className = 'sync-status-icon is-success';
    icon.innerHTML = uiIcon('check');
    text.textContent = '已同步';
    const d = new Date(cfg.lastSync);
    lastTime.textContent = '上次：' + d.toLocaleString();
  } else {
    icon.className = 'sync-status-icon is-pending';
    icon.innerHTML = uiIcon('alert');
    text.textContent = '已配置，尚未同步';
    lastTime.textContent = '';
  }
}

function showSyncResult(type, message) {
  const el = document.getElementById('syncResult');
  el.style.display = 'block';
  el.className = 'sync-result sync-' + type;
  el.textContent = message;
}

async function loadSyncConflicts() {
  const host = document.getElementById('syncConflicts');
  if (!host) return;
  try {
    const response = await fetch(`${API_BASE}/api/webdav/conflicts`);
    const data = await response.json();
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    host.style.display = conflicts.length ? 'block' : 'none';
    host.innerHTML = conflicts.map((conflict) => `<section class="sync-conflict" data-conflict-id="${escapeHtml(conflict.id)}">
      <div><strong>${escapeHtml(conflict.key)}</strong><small>检测于 ${new Date(conflict.createdAt).toLocaleString()}</small></div>
      <div class="sync-conflict-actions">
        <button type="button" data-sync-resolution="local" title="保留本地版本并覆盖远端">保留本地</button>
        <button type="button" data-sync-resolution="remote" title="用已保存的远端副本覆盖本地">采用远端</button>
        <button type="button" data-sync-resolution="merge" title="编辑合并后的内容">合并</button>
      </div>
      <div class="sync-conflict-editor" hidden></div>
    </section>`).join('');
    host.querySelectorAll('[data-sync-resolution]').forEach((button) => button.addEventListener('click', () => handleSyncConflictAction(button)));
  } catch (error) {
    host.style.display = 'none';
  }
}

async function handleSyncConflictAction(button) {
  const section = button.closest('.sync-conflict');
  const id = section?.dataset.conflictId;
  const resolution = button.dataset.syncResolution;
  if (!id || !resolution) return;
  if (resolution === 'merge') {
    const editor = section.querySelector('.sync-conflict-editor');
    if (!editor) return;
    if (!editor.hidden) { editor.hidden = true; return; }
    try {
      const response = await fetch(`${API_BASE}/api/webdav/conflicts/${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok || !data.mergeable) { showSyncResult('info', '此冲突包含敏感配置或内容过大，请选择保留本地或采用远端。'); return; }
      editor.hidden = false;
      editor.innerHTML = `<label>合并后的完整 JSON</label><textarea spellcheck="false">${escapeHtml(data.localContent || '')}</textarea><div><button type="button" class="btn-primary">保存合并结果</button></div>`;
      editor.querySelector('button').addEventListener('click', () => resolveSyncConflict(id, 'merge', editor.querySelector('textarea').value));
    } catch (error) { showSyncResult('error', `读取冲突失败：${error.message}`); }
    return;
  }
  resolveSyncConflict(id, resolution);
}

async function resolveSyncConflict(id, resolution, content) {
  try {
    const response = await fetch(`${API_BASE}/api/webdav/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution, content }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '处理失败');
    showSyncResult('success', resolution === 'local' ? '已保留本地版本并更新远端。' : resolution === 'remote' ? '已采用远端版本。' : '已保存合并版本。');
    loadSyncConflicts();
  } catch (error) { showSyncResult('error', `冲突处理失败：${error.message}`); }
}
