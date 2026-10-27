// =============================================================================
// Skills management
//
// Skill catalog grid, enable/disable, slash trigger menu and the skill
// detail view.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
let skillsCache = [];
let skillsFilter = 'all';
let skillsSort = 'name';

const SKILL_FILTERS = {
  all: () => true,
  enabled: (s) => s.enabled !== false,
  disabled: (s) => s.enabled === false,
  system: (s) => !!s.systemPrompt,
};
const SKILL_SORTS = {
  name: (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN'),
  usage: (a, b) => (Number(b.useCount) || 0) - (Number(a.useCount) || 0)
    || String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN'),
  recent: (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0),
  status: (a, b) => (Number(b.enabled !== false) - Number(a.enabled !== false))
    || (Number(!!b.systemPrompt) - Number(!!a.systemPrompt))
    || String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN'),
};

// escapeHtml() goes through textContent, so it leaves quotes intact and cannot
// be used inside title="…". This variant covers attribute context.
function skillAttr(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
function skillUpdatedLabel(value) {
  const stamp = Number(value) || 0;
  if (!stamp) return '';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}/${date.getMonth() + 1}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// Compact grid card: one head line, a two-line description and a footer that
// holds the counters plus three icon actions. The old layout stacked four
// full-width buttons per card, which is what made every row ~180px tall.
function renderSkills() {
  const list = document.getElementById('skillList');
  if (!list) return;
  const filter = SKILL_FILTERS[skillsFilter] ? skillsFilter : 'all';
  const sort = SKILL_SORTS[skillsSort] ? skillsSort : 'name';
  const count = (key) => skillsCache.filter(SKILL_FILTERS[key]).length;
  document.querySelectorAll('[data-skill-count]').forEach((node) => {
    const next = String(count(node.dataset.skillCount) || 0);
    if (node.textContent !== next) node.textContent = next;
  });
  document.getElementById('skillFilter')?.querySelectorAll('[data-skill-filter]').forEach((button) => {
    const active = button.dataset.skillFilter === filter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const sortSelect = document.getElementById('skillSort');
  if (sortSelect && sortSelect.value !== sort) sortSelect.value = sort;

  const visible = skillsCache.filter(SKILL_FILTERS[filter]).sort(SKILL_SORTS[sort]);
  if (!visible.length) {
    list.innerHTML = `<div class="skill-empty">${skillsCache.length
      ? IexaI18n.t('skill.noMatch')
      : IexaI18n.t('skill.empty')}</div>`;
    return;
  }
  list.innerHTML = visible.map((s) => {
    const enabled = s.enabled !== false;
    const name = s.name || s.id;
    const description = s.description || IexaI18n.t('skill.noDescription');
    const updated = skillUpdatedLabel(s.updatedAt);
    const meta = IexaI18n.t('skill.meta', { count: Number(s.useCount) || 0, version: s.version || '1.0.0' }) + (updated ? ` · ${updated}` : '');
    const metaTitle = IexaI18n.t('skill.meta', { count: Number(s.useCount) || 0, version: s.version || '1.0.0' })
      + (s.updatedAt ? ' · ' + IexaI18n.t('skill.updatedAt', { date: new Date(Number(s.updatedAt)).toLocaleString() }) : '');
    const switchLabel = `${enabled ? IexaI18n.t('skill.disable') : IexaI18n.t('skill.enable')} ${name}`;
    return `<article class="skill-card${enabled ? '' : ' is-disabled'}" data-id="${skillAttr(s.id)}">
      <div class="skill-card-head">
        <div class="skill-card-title">
          <strong class="skill-card-name" title="${skillAttr(name)}">${escapeHtml(name)}</strong>
          <span class="skill-badge">${escapeHtml(s.source || 'file')}</span>
          ${s.systemPrompt ? '<span class="skill-badge sys">' + IexaI18n.t('skill.system') + '</span>' : ''}
          ${enabled ? '' : '<span class="skill-badge off">' + IexaI18n.t('skill.off') + '</span>'}
        </div>
        <button type="button" class="skill-switch" role="switch" aria-checked="${enabled}" data-act="toggle" title="${skillAttr(switchLabel)}" aria-label="${skillAttr(switchLabel)}"></button>
      </div>
      <p class="skill-card-desc" title="${skillAttr(description)}">${escapeHtml(description)}</p>
      <div class="skill-card-foot">
        <span class="skill-card-meta" title="${skillAttr(metaTitle)}">${escapeHtml(meta)}</span>
        <div class="skill-card-actions">
          <button type="button" class="skill-icon-btn${s.systemPrompt ? ' is-on' : ''}" data-act="sysprompt" aria-pressed="${!!s.systemPrompt}" title="${s.systemPrompt ? IexaI18n.t('skill.unmarkSystem') : IexaI18n.t('skill.markSystem')}" aria-label="${s.systemPrompt ? IexaI18n.t('skill.unmarkSystem') : IexaI18n.t('skill.markSystem')}">${uiIcon('pin')}</button>
          <button type="button" class="skill-icon-btn" data-act="view" title="${IexaI18n.t('skill.viewEdit')}" aria-label="${IexaI18n.t('skill.viewEdit')}">${uiIcon('edit')}</button>
          <button type="button" class="skill-icon-btn skill-del" data-act="delete" title="${IexaI18n.t('skill.delete')}" aria-label="${IexaI18n.t('skill.delete')}">${uiIcon('trash')}</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

async function setSkillFlag(id, patch) {
  await fetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await loadSkillsList();
}

// One delegated listener: cards are re-rendered from a template, so per-card
// handlers would be re-attached (and leak) on every toggle.
async function onSkillListClick(event) {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const card = button.closest('.skill-card');
  const id = card?.dataset.id;
  if (!id) return;
  const skill = skillsCache.find((item) => item.id === id);
  const act = button.dataset.act;
  if (act === 'toggle') await setSkillFlag(id, { enabled: !(skill && skill.enabled !== false) });
  else if (act === 'sysprompt') await setSkillFlag(id, { systemPrompt: !(skill && skill.systemPrompt) });
  else if (act === 'view') openSkillViewer(id);
  else if (act === 'delete') {
    if (!(await window.IexaDialogs.confirm(IexaI18n.t('skill.deleteConfirm')))) return;
    await fetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadSkillsList();
  }
}

async function loadSkillsList() {
  const list = document.getElementById('skillList');
  if (!list) return;
  try {
    const resp = await fetch(`${API_BASE}/api/skills`);
    const data = await resp.json();
    skillsCache = Array.isArray(data.skills) ? data.skills : [];
    renderSkills();
  } catch (err) {
    list.innerHTML = `<div class="skill-empty">${IexaI18n.t('skill.loadFailed', { error: escapeHtml(err.message || String(err)) })}</div>`;
  }
}

async function openSkillViewer(id) {
  try {
    const resp = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || IexaI18n.t('skill.readFailed'));
    const overlay = document.getElementById('skillEditorOverlay');
    const title = document.getElementById('skillEditorTitle');
    const content = document.getElementById('skillEditorContent');
    const saveBtn = document.getElementById('skillEditorSave');
    if (!overlay || !content) return;
    title.textContent = IexaI18n.t('skill.editingPrefix') + (data.skill?.name || id);
    content.value = data.content || '';
    content.dataset.editId = id;
    saveBtn.textContent = IexaI18n.t('skill.saveChanges');
    overlay.style.display = 'flex';
  } catch (err) {
    addError(err.message || String(err));
  }
}

function openSkillImporter() {
  const overlay = document.getElementById('skillEditorOverlay');
  const title = document.getElementById('skillEditorTitle');
  const content = document.getElementById('skillEditorContent');
  const saveBtn = document.getElementById('skillEditorSave');
  if (!overlay || !content) return;
  title.textContent = IexaI18n.t('skill.pasteImport');
  content.value = '';
  delete content.dataset.editId;
  delete content.dataset.importSource;
  saveBtn.textContent = IexaI18n.t('skill.save');
  overlay.style.display = 'flex';
  content.focus();
}

function closeSkillEditor() {
  const overlay = document.getElementById('skillEditorOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function importSkillContent(text, source) {
  const resp = await fetch(`${API_BASE}/api/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, source: source || 'file' }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || IexaI18n.t('skill.importFailed'));
  return data.skill;
}

async function saveSkillEditor() {
  const contentEl = document.getElementById('skillEditorContent');
  if (!contentEl) return;
  const text = contentEl.value.trim();
  if (!text) {
    addError(IexaI18n.t('skill.needContent'));
    return;
  }
  try {
    const editId = contentEl.dataset.editId;
    if (editId) {
      const resp = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || IexaI18n.t('skill.saveFailed'));
    } else {
      await importSkillContent(text, contentEl.dataset.importSource || 'paste');
    }
    closeSkillEditor();
    loadSkillsList();
  } catch (err) {
    addError(err.message || String(err));
  }
}

async function importSkillFromPicked(picked) {
  if (!picked) return;
  if (picked.error) {
    addError(picked.error);
    return;
  }
  if (!picked.content) {
    addError(IexaI18n.t('skill.readSkillFailed'));
    return;
  }
  await importSkillContent(picked.content, 'file');
  loadSkillsList();
}

/** Pick SKILL.md file via Electron dialog or hidden file input */
async function importSkillFromFile() {
  if (window.iexaDesktop && typeof window.iexaDesktop.pickSkillFile === 'function') {
    try {
      const picked = await window.iexaDesktop.pickSkillFile();
      await importSkillFromPicked(picked);
      return;
    } catch (err) {
      console.error(err);
      addError(err.message || String(err));
      return;
    }
  }
  // Browser fallback
  const input = document.getElementById('skillFileInput');
  if (input) input.click();
}

/** Open IEXA PC's skills directory in Explorer for manual management */
async function openSkillsDirectory() {
  try {
    const resp = await fetch(`${API_BASE}/api/skills`);
    const data = await resp.json();
    const dir = data.skillsDir;
    if (!dir) throw new Error(IexaI18n.t('skill.noDir'));

    if (window.iexaDesktop && typeof window.iexaDesktop.openPath === 'function') {
      const result = await window.iexaDesktop.openPath(dir);
      if (result && result.error) throw new Error(result.error);
    } else {
      // Browser fallback: show path
      (await window.IexaDialogs.prompt(IexaI18n.t('skill.dirPath'), dir));
    }
    // Rescan after user may have edited files on disk
    setTimeout(() => loadSkillsList(), 800);
  } catch (err) {
    addError(err.message || String(err));
  }
}

function onSkillFileInputChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const text = String(reader.result || '');
      if (!text.trim()) throw new Error(IexaI18n.t('skill.fileEmpty'));
      await importSkillContent(text, 'file');
      loadSkillsList();
    } catch (err) {
      addError(err.message || String(err));
    }
  };
  reader.onerror = () => addError(IexaI18n.t('skill.fileReadFailed'));
  reader.readAsText(file);
}

function toggleSkillAddMenu(force) {
  const menu = document.getElementById('skillAddMenu');
  if (!menu) return;
  const show = force != null ? force : menu.style.display === 'none';
  menu.style.display = show ? 'flex' : 'none';
  // Keep the trigger's state in sync for screen readers and for CSS that keys
  // off aria-expanded rather than the inline display value.
  const trigger = document.getElementById('skillAddBtn');
  if (trigger) trigger.setAttribute('aria-expanded', String(show));
}

function closeSkillAddMenu() {
  toggleSkillAddMenu(false);
}

function initSkillsUI() {
  // Restore the last sort choice. Read here rather than at load time so this
  // file only declares things when it is evaluated.
  try {
    const savedSort = localStorage.getItem('iexa.skills.sort');
    if (savedSort && ['name', 'usage', 'recent', 'status'].includes(savedSort)) skillsSort = savedSort;
  } catch { /* storage unavailable */ }

  const addBtn = document.getElementById('skillAddBtn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('skillAddMenu');
      const open = menu && menu.style.display !== 'none';
      toggleSkillAddMenu(!open);
    });
  }

  const importBtn = document.getElementById('skillImportBtn');
  if (importBtn) importBtn.addEventListener('click', () => {
    closeSkillAddMenu();
    openSkillImporter();
  });
  const fileBtn = document.getElementById('skillImportFileBtn');
  if (fileBtn) fileBtn.addEventListener('click', () => {
    closeSkillAddMenu();
    importSkillFromFile();
  });
  const openDirBtn = document.getElementById('skillOpenDirBtn');
  if (openDirBtn) openDirBtn.addEventListener('click', () => {
    closeSkillAddMenu();
    openSkillsDirectory();
  });
  const fileInput = document.getElementById('skillFileInput');
  if (fileInput) fileInput.addEventListener('change', onSkillFileInputChange);

  // Filter / sort / card actions. The list is re-rendered from a template, so
  // actions are delegated once instead of bound per card.
  const skillList = document.getElementById('skillList');
  if (skillList) skillList.addEventListener('click', onSkillListClick);
  const skillFilter = document.getElementById('skillFilter');
  if (skillFilter) skillFilter.addEventListener('click', (event) => {
    const button = event.target.closest('[data-skill-filter]');
    if (!button) return;
    skillsFilter = button.dataset.skillFilter || 'all';
    renderSkills();
  });
  const sortSelect = document.getElementById('skillSort');
  if (sortSelect) {
    if (SKILL_SORTS[skillsSort]) sortSelect.value = skillsSort;
    sortSelect.addEventListener('change', () => {
      skillsSort = SKILL_SORTS[sortSelect.value] ? sortSelect.value : 'name';
      try { localStorage.setItem('iexa.skills.sort', skillsSort); } catch { /* storage unavailable */ }
      renderSkills();
    });
  }  const cancel = document.getElementById('skillEditorCancel');
  if (cancel) cancel.addEventListener('click', closeSkillEditor);
  const save = document.getElementById('skillEditorSave');
  if (save) save.addEventListener('click', saveSkillEditor);
  const overlay = document.getElementById('skillEditorOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSkillEditor();
    });
  }

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('skillAddWrap');
    if (wrap && !wrap.contains(e.target)) closeSkillAddMenu();
  });

  // Warm skills cache for slash menu
  fetch(`${API_BASE}/api/skills`).then((r) => r.json()).then((d) => {
    skillsCache = d.skills || [];
  }).catch(() => {});
}

// ---- Slash menu: system commands first, then skills (typing aid only) ----
const SLASH_COMMANDS = [
  { command: 'help', key: 'slash.help' },
  { command: 'new', key: 'slash.new' },
  { command: 'model', key: 'slash.model' },
  { command: 'plan', key: 'slash.plan' },
  { command: 'rewind', key: 'slash.rewind' },
  { command: 'diagnostics', key: 'slash.diagnostics' },
];

function hideSlashMenu() {
  const menu = document.getElementById('slashMenu');
  if (menu) menu.style.display = 'none';
}

function clearSlashTrigger() {
  if (!chatInput) return;
  chatInput.value = chatInput.value.replace(/(?:^|\n)\/[^\s\n]*$/, (match) => (match.startsWith('\n') ? '\n' : ''));
  chatInput.style.height = 'auto';
  hideSlashMenu();
  chatInput.focus();
}

async function runSlashCommand(command) {
  clearSlashTrigger();
  try {
    if (command === 'help') {
      chatInput.value = SLASH_COMMANDS.map((item) => `/${item.command} — ${IexaI18n.t(item.key)}`).join('\n');
      chatInput.dispatchEvent(new Event('input'));
      return;
    }
    if (command === 'new') { document.getElementById('newSessionBtn')?.click(); return; }
    if (command === 'model') { document.getElementById('modelSelector')?.click(); return; }
    if (command === 'plan') { await setPermissionMode('plan'); return; }
    if (command === 'rewind') { setCheckpointOpen(true); return; }
    if (command === 'diagnostics') { await exportDiagnostics(); return; }
  } catch (error) {
    addError(error.message || String(error));
  }
}

function updateSlashMenu() {
  const menu = document.getElementById('slashMenu');
  if (!menu || !chatInput) return;
  const val = chatInput.value;
  // Only at start of input or after newline: "/xxx"
  const m = val.match(/(?:^|\n)\/([^\s\n]*)$/);
  if (!m) {
    hideSlashMenu();
    return;
  }
  const q = (m[1] || '').toLowerCase();
  const enabled = (skillsCache || []).filter((s) => s.enabled !== false);
  const matchedCommands = SLASH_COMMANDS
    .filter((item) => !q || item.command.includes(q))
    .map((item) => ({ kind: 'command', key: item.command, label: '/' + item.command, description: IexaI18n.t(item.key) }));
  const matchedSkills = enabled
    .filter((s) => {
      const name = (s.name || '').toLowerCase();
      const id = (s.id || '').toLowerCase();
      return !q || name.includes(q) || id.includes(q);
    })
    .map((s) => ({ kind: 'skill', key: s.name, label: '/' + s.name, description: s.description || '' }));
  const entries = [...matchedCommands, ...matchedSkills].slice(0, 8);

  if (entries.length === 0) {
    hideSlashMenu();
    return;
  }

  menu.innerHTML = entries.map((entry, i) => `
    <button type="button" class="slash-item${i === 0 ? ' active' : ''}" data-kind="${entry.kind}" data-value="${escapeHtml(entry.key)}">
      <span class="slash-item-name">${escapeHtml(entry.label)}</span>
      <span class="slash-item-desc">${escapeHtml(String(entry.description || '').substring(0, 60))}</span>
    </button>
  `).join('');
  menu.style.display = 'flex';
  menu.querySelectorAll('.slash-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.kind === 'command') runSlashCommand(btn.dataset.value || '');
      else applySlashSkill(btn.dataset.value || '');
    });
  });
}

function applySlashSkill(name) {
  if (!name || !chatInput) return;
  const val = chatInput.value;
  const replaced = val.replace(/(?:^|\n)\/[^\s\n]*$/, (match) => {
    const prefix = match.startsWith('\n') ? '\n' : '';
    return prefix + '/' + name + ' ';
  });
  // If no match replace (edge), just set
  chatInput.value = replaced === val ? ('/' + name + ' ') : replaced;
  chatInput.focus();
  hideSlashMenu();
  chatInput.dispatchEvent(new Event('input'));
}
