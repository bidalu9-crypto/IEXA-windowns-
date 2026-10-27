// Permission mode control that sits in the composer.
//
// Extracted from the retired task-center panel so the composer keeps its
// permission switch without carrying the jobs list.
//
// Classic script: declarations join app.js global scope. No DOM work on load.

const PERMISSION_MODE_LABELS = {
  plan: IexaI18n.t('permMode.plan'),
  ask: IexaI18n.t('permMode.ask'),
  risk: IexaI18n.t('permMode.auto'),
  full: IexaI18n.t('permMode.full'),
};
let permissionMode = 'risk';

function syncPermissionModeUI() {
  const list = document.getElementById('permissionModeList');
  if (list) list.querySelectorAll('[data-permission-mode]').forEach((button) => {
    const active = button.dataset.permissionMode === permissionMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const label = document.getElementById('permissionModeLabel');
  if (label) label.textContent = IexaI18n.t('permission.' + permissionMode);
  const trigger = document.getElementById('permissionModeBtn');
  if (trigger) trigger.dataset.permissionMode = permissionMode;
  const wrap = document.getElementById('permissionModeWrap');
  if (wrap) wrap.dataset.permissionMode = permissionMode;
  const menu = document.getElementById('permissionModeMenu');
  if (menu) menu.querySelectorAll('[data-permission-menu-mode]').forEach((button) => {
    const active = button.dataset.permissionMenuMode === permissionMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

function setPermissionMenuOpen(open) {
  const button = document.getElementById('permissionModeBtn');
  const menu = document.getElementById('permissionModeMenu');
  if (!button || !menu) return;
  menu.style.display = open ? 'flex' : 'none';
  button.classList.toggle('is-open', open);
  button.setAttribute('aria-expanded', String(open));
}

async function setPermissionMode(mode) {
  if (!Object.prototype.hasOwnProperty.call(PERMISSION_MODE_LABELS, mode)) return;
  const previous = permissionMode;
  permissionMode = mode;
  syncPermissionModeUI();
  try {
    const response = await fetch(API_BASE + '/api/permissions/mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || IexaI18n.t('permMode.saveFailed'));
    setPermissionMenuOpen(false);
  } catch (error) {
    permissionMode = previous;
    syncPermissionModeUI();
    addError(error.message || String(error));
  }
}

async function loadPermissionMode() {
  try {
    const response = await fetch(API_BASE + '/api/permissions/mode', { cache: 'no-store' });
    const data = await response.json();
    if (data && PERMISSION_MODE_LABELS[data.mode]) permissionMode = data.mode;
  } catch { /* The default risk mode remains usable while the server starts. */ }
  syncPermissionModeUI();
}

function initPermissionModeUI() {
  const list = document.getElementById('permissionModeList');
  if (list) list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-permission-mode]');
    if (button) setPermissionMode(button.dataset.permissionMode);
  });
  const button = document.getElementById('permissionModeBtn');
  const wrap = document.getElementById('permissionModeWrap');
  const menu = document.getElementById('permissionModeMenu');
  if (button && wrap && menu) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPermissionMenuOpen(menu.style.display !== 'flex');
    });
    menu.querySelectorAll('[data-permission-menu-mode]').forEach((option) => {
      option.addEventListener('click', () => setPermissionMode(option.dataset.permissionMenuMode));
    });
    document.addEventListener('click', (event) => {
      if (!wrap.contains(event.target)) setPermissionMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setPermissionMenuOpen(false);
    });
  }
  syncPermissionModeUI();
}
