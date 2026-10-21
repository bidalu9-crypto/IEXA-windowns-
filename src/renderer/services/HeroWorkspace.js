// =============================================================================
// Landing project chip
//
// DeepSeek Harness keeps the workspace above the composer on the new-session
// page — folder, name, chevron — so a session can be pointed at a folder before
// the first message is typed. IEXA already owns that data in FilesPanel
// (projectRoot / projectName / projectRecent), so this is a second entrance to
// the existing picker, not a second implementation.
//
// Classic script: declarations only. initHeroWorkspace() wires the listeners.
// =============================================================================
const heroWorkspaceState = { open: false, side: 'top' };

function heroWorkspaceNode(id) {
  return document.getElementById(id);
}

/** Last path segment, used when the picker only gives us a path. */
function heroWorkspaceBaseName(value) {
  const text = String(value || '');
  const parts = text.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

function heroWorkspaceSnapshot() {
  return {
    root: typeof projectRoot === 'string' ? projectRoot : '',
    name: typeof projectName === 'string' ? projectName : '',
    recent: Array.isArray(projectRecent) ? projectRecent : [],
  };
}

function heroWorkspaceSamePath(left, right) {
  if (!left || !right) return false;
  const normalise = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalise(left) === normalise(right);
}

function heroWorkspaceIcon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ui-${name}`);
  svg.append(use);
  return svg;
}

/** The chip mirrors the open project; without one it is the "open folder" call. */
function syncHeroWorkspace() {
  const chip = heroWorkspaceNode('heroWorkspaceChip');
  const label = heroWorkspaceNode('heroWorkspaceLabel');
  if (!chip || !label) return;
  const snapshot = heroWorkspaceSnapshot();
  const text = snapshot.name || heroWorkspaceBaseName(snapshot.root) || '打开项目文件夹';
  if (label.textContent !== text) label.textContent = text;
  chip.dataset.state = snapshot.root ? 'open' : 'empty';
  chip.title = snapshot.root ? `${snapshot.root} · 点击切换项目` : '打开项目文件夹';
  chip.setAttribute('aria-label', chip.title);
  if (heroWorkspaceState.open) heroWorkspaceRenderMenu();
}

/** Recent projects first, then the actions that change the binding. */
function heroWorkspaceEntries() {
  const snapshot = heroWorkspaceSnapshot();
  const entries = [];
  const seen = new Set();
  for (const item of snapshot.recent.slice(0, 6)) {
    const path = typeof item === 'string' ? item : (item && item.path);
    if (!path) continue;
    const key = String(path).replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (item && typeof item === 'object' && item.name) || heroWorkspaceBaseName(path);
    entries.push({ action: 'project', path, label: String(name), current: heroWorkspaceSamePath(path, snapshot.root) });
  }
  entries.push({ action: 'open', label: '打开项目文件夹…', icon: 'folder-plus' });
  if (snapshot.root) entries.push({ action: 'close', label: '关闭项目', icon: 'close' });
  return entries;
}

function heroWorkspaceRenderMenu() {
  const menu = heroWorkspaceNode('heroWorkspaceMenu');
  if (!menu) return;
  const entries = heroWorkspaceEntries();
  const fragment = document.createDocumentFragment();

  if (entries.some((entry) => entry.action === 'project')) {
    const group = document.createElement('div');
    group.className = 'hero-workspace-group';
    group.textContent = '最近项目';
    fragment.append(group);
  }

  let separated = false;
  for (const entry of entries) {
    if (entry.action !== 'project' && !separated && entries.some((item) => item.action === 'project')) {
      const rule = document.createElement('div');
      rule.className = 'hero-workspace-sep';
      rule.setAttribute('role', 'separator');
      fragment.append(rule);
      separated = true;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hero-workspace-item';
    button.setAttribute('role', 'menuitem');
    button.dataset.heroAction = entry.action;
    if (entry.path) button.dataset.path = entry.path;
    if (entry.current) button.dataset.current = 'true';
    button.append(heroWorkspaceIcon(entry.action === 'project' ? 'folder' : entry.icon, 'ui-icon hero-workspace-item-icon'));

    const text = document.createElement('span');
    text.className = 'hero-workspace-item-text';
    const name = document.createElement('span');
    name.className = 'hero-workspace-item-name';
    name.textContent = entry.label;
    text.append(name);
    if (entry.path) {
      const path = document.createElement('span');
      path.className = 'hero-workspace-item-path';
      path.textContent = entry.path;
      text.append(path);
    }
    button.append(text);
    if (entry.current) button.append(heroWorkspaceIcon('check', 'ui-icon hero-workspace-item-check'));
    fragment.append(button);
  }
  menu.replaceChildren(fragment);
}

/** The chip sits mid-page, so the menu opens upward unless there is no room. */
function heroWorkspacePlace(menu, chip) {
  const anchor = chip.getBoundingClientRect();
  const height = menu.offsetHeight;
  const side = anchor.top - height - 10 < 8 ? 'bottom' : 'top';
  menu.dataset.side = side;
  heroWorkspaceState.side = side;
}

function heroWorkspaceSetOpen(open) {
  const chip = heroWorkspaceNode('heroWorkspaceChip');
  const menu = heroWorkspaceNode('heroWorkspaceMenu');
  if (!chip || !menu) return;
  heroWorkspaceState.open = Boolean(open);
  chip.setAttribute('aria-expanded', String(heroWorkspaceState.open));
  if (!heroWorkspaceState.open) {
    menu.hidden = true;
    return;
  }
  heroWorkspaceRenderMenu();
  menu.hidden = false;
  heroWorkspacePlace(menu, chip);
  menu.querySelector('.hero-workspace-item')?.focus({ preventScroll: true });
}

function heroWorkspaceMoveFocus(menu, step) {
  const items = Array.from(menu.querySelectorAll('.hero-workspace-item'));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const next = current < 0 ? 0 : (current + step + items.length) % items.length;
  items[next].focus({ preventScroll: true });
}

async function heroWorkspaceRun(action, path) {
  heroWorkspaceSetOpen(false);
  try {
    if (action === 'open') await openProjectPicker();
    else if (action === 'project') await openProjectPath(path);
    else if (action === 'close') await closeProject();
  } finally {
    syncHeroWorkspace();
  }
}

function initHeroWorkspace() {
  const chip = heroWorkspaceNode('heroWorkspaceChip');
  const menu = heroWorkspaceNode('heroWorkspaceMenu');
  if (!chip || !menu) return;

  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    heroWorkspaceSetOpen(!heroWorkspaceState.open);
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest?.('.hero-workspace-item');
    if (!item) return;
    void heroWorkspaceRun(item.dataset.heroAction, item.dataset.path);
  });

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); heroWorkspaceMoveFocus(menu, 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); heroWorkspaceMoveFocus(menu, -1); }
    else if (event.key === 'Home') { event.preventDefault(); heroWorkspaceMoveFocus(menu, -99); }
    else if (event.key === 'End') { event.preventDefault(); heroWorkspaceMoveFocus(menu, 99); }
  });

  document.addEventListener('click', (event) => {
    if (!heroWorkspaceState.open) return;
    const wrap = heroWorkspaceNode('heroWorkspace');
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.some((node) => node && node.id === 'heroWorkspace')) return;
    if (wrap && event.target instanceof Node && wrap.contains(event.target)) return;
    heroWorkspaceSetOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !heroWorkspaceState.open) return;
    heroWorkspaceSetOpen(false);
    chip.focus({ preventScroll: true });
  });

  window.addEventListener('resize', () => { if (heroWorkspaceState.open) heroWorkspaceSetOpen(false); });
  document.querySelector('.sessions-list')?.addEventListener('scroll', () => {
    if (heroWorkspaceState.open) heroWorkspaceSetOpen(false);
  }, { passive: true });

  syncHeroWorkspace();
  window.syncHeroWorkspace = syncHeroWorkspace;
}
