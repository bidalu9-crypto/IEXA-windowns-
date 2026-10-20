// =============================================================================
// Model profiles
//
// Multi-model profile list, editor, placeholders, thinking-level persistence
// and the model selector.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
const MODEL_PLACEHOLDERS = {
  anthropic: 'claude-sonnet-4-20250514', openai: 'gpt-4o', gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat', openrouter: 'openai/gpt-4o', xai: 'grok-3', custom: 'your-model-id',
};

const BASE_URL_HINTS = {
  anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', gemini: '',
  deepseek: 'https://api.deepseek.com', openrouter: 'https://openrouter.ai/api',
  xai: 'https://api.x.ai', custom: 'https://your-api-endpoint.com/v1',
};

let profilesCache = [];
let activeProfileId = '';

async function fetchProfiles() {
  const resp = await fetch(`${API_BASE}/api/profiles`);
  const data = await resp.json();
  profilesCache = data.profiles || [];
  const uaInput = document.getElementById('profileEditorUserAgent');
  if (uaInput && data.defaultUserAgent) uaInput.placeholder = data.defaultUserAgent;
  activeProfileId = data.activeProfileId || '';
  if (data.thinkingLevel) {
    currentThinkingLevel = normalizeThinkingLevel(data.thinkingLevel);
    try { localStorage.setItem('iexa-thinking-level', currentThinkingLevel); } catch (e) {}
    applyThinkingLevelUI(currentThinkingLevel);
  }
  if (data.contextCompactionLimit !== undefined && data.contextCompactionLimit !== null) {
    currentContextCompactionLimit = normalizeContextCompactionLimit(data.contextCompactionLimit);
    applyContextCompactionUI(currentContextCompactionLimit);
  }
  return data;
}

// ---- Thinking Level (iOS-style capsule) ----
let modelSelectorProfiles = [];

function normalizeThinkingLevel(v) {
  const id = String(v || '').toLowerCase();
  return THINKING_LEVELS[id] ? id : 'medium';
}

const THINKING_LEVEL_ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
let thinkingLevelSaveQueue = Promise.resolve();
let thinkingLevelSaveRevision = 0;

function thinkingMaxLevelForModel(profile) {
  if (!profile || !profile.model) return 'xhigh';
  const model = String(profile.model).toLowerCase().replace(/[._]/g, '-');
  // Resolve GPT family locally before trusting cached/server capability metadata;
  // older running backends may still report "off" for newly supported GPT-6 ids.
  if (/(?:^|[/:-])gpt-(?:6|[7-9]|[1-9][0-9]+)(?:-[a-z0-9]+)*(?:$|[/:-])/.test(model) && !/(?:^|[/:-])gpt-6-(?:chat|mini|nano|codex)(?:$|[/:-])/.test(model)) return 'max';
  if (/(?:^|[/:-])gpt-5(?:-[0-9]+)?(?:$|[/:-])/.test(model) && !/(?:^|[/:-])gpt-5-(?:chat|mini|nano|codex|1|2)(?:$|[/:-])/.test(model)) return 'xhigh';
  if (profile && THINKING_LEVEL_ORDER.includes(profile.maxThinkingLevel)) return profile.maxThinkingLevel;
  const provider = String(profile.provider || '').toLowerCase();
  if (/mimo|agnes|seed-|bytedance-seed|doubao/.test(model)) return 'high';
  if (/claude-opus-4/.test(model)) return 'max';
  if (/(?:^|[/:-])gpt-(?:6|[7-9]|[1-9][0-9]+)(?:-[a-z0-9]+)*(?:$|[/:-])/.test(model) && !/(?:^|[/:-])gpt-(?:6)-(?:chat|mini|nano|codex)(?:$|[/:-])/.test(model)) return 'max';
  if (/(?:^|[/:-])gpt-5(?:-[0-9]+)?(?:$|[/:-])/.test(model) && !/(?:^|[/:-])gpt-5-(?:chat|mini|nano|codex|1|2)(?:$|[/:-])/.test(model)) return 'xhigh';
  if (/(?:^|[/:-])glm-5-3-(?:flash|falsh)(?:$|[/:-])/.test(model)) return 'high';
  if (/(?:^|[/:-])gpt-(?:5|6|[7-9]|[1-9][0-9]+)(?:-[a-z0-9]+)*(?:$|[/:-])/.test(model) && !/(?:^|[/:-])gpt-(?:5|6)-(?:chat|mini|nano|codex)(?:$|[/:-])/.test(model)) return /(?:^|[/:-])gpt-6(?:-|$)/.test(model) ? 'max' : 'xhigh';
  if (/o[1-9]|deepseek|reason|thinking|\br1\b|qwq|grok/.test(model) || provider === 'deepseek' || provider === 'xai') return 'xhigh';
  return 'off';
}

function applyThinkingLevelUI(level) {
  currentThinkingLevel = normalizeThinkingLevel(level);
  const boundProfileId = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding?.profileId;
  const activeProfile = modelSelectorProfiles.find((profile) => profile.id === boundProfileId)
    || modelSelectorProfiles.find((profile) => profile.id === activeProfileId);
  const maxLevel = thinkingMaxLevelForModel(activeProfile);
  const maxIndex = THINKING_LEVEL_ORDER.indexOf(maxLevel);
  const currentIndex = THINKING_LEVEL_ORDER.indexOf(currentThinkingLevel);
  if (currentIndex > maxIndex) currentThinkingLevel = maxLevel;
  const btn = document.getElementById('thinkingLevelBtn');
  const label = document.getElementById('thinkingLevelLabel');
  const menu = document.getElementById('thinkingLevelMenu');
  if (label) label.textContent = THINKING_LEVELS[currentThinkingLevel].label;
  if (btn) {
    btn.dataset.level = currentThinkingLevel;
    btn.title = '思考档位：' + THINKING_LEVELS[currentThinkingLevel].label;
    btn.disabled = maxLevel === 'off';
  }
  if (menu) {
    const slider = document.getElementById('thinkingLevelSlider');
    const value = document.getElementById('thinkingSliderValue');
    const ticks = document.getElementById('thinkingSliderTicks');
    const track = document.getElementById('thinkingSliderTrack');
    const selected = THINKING_LEVEL_ORDER.indexOf(currentThinkingLevel);
    if (slider) {
      slider.max = String(maxIndex); slider.value = String(selected); slider.disabled = maxIndex === 0;
      slider.setAttribute('aria-valuetext', THINKING_LEVELS[currentThinkingLevel].label);
    }
    if (track) {
      track.style.setProperty('--thinking-fill', `${maxIndex ? selected / maxIndex * 100 : 0}%`);
    }
    if (value) {
      value.textContent = THINKING_LEVELS[currentThinkingLevel].label;
      const chevron = document.createElement('span'); chevron.setAttribute('aria-hidden', 'true'); chevron.textContent = ' ›'; value.appendChild(chevron);
    }
    if (ticks) {
      ticks.replaceChildren();
      for (let i = 0; i <= maxIndex; i++) { const dot = document.createElement('span'); dot.className = i <= selected ? 'is-filled' : ''; ticks.appendChild(dot); }
    }
    // The top step is a different material: a violet shimmer with travelling
    // sparks. Everything below it stays in the theme accent.
    const atMax = maxIndex > 0 && selected === maxIndex;
    if (track) track.dataset.atMax = String(atMax);
    menu.dataset.atMax = String(atMax);
    if (btn) btn.dataset.atMax = String(atMax);
    if (maxIndex === 0) setThinkingMenuOpen(false);
  }
}

function setThinkingMenuOpen(open) {
  const btn = document.getElementById('thinkingLevelBtn'), menu = document.getElementById('thinkingLevelMenu');
  if (!btn || !menu) return;
  menu.style.display = open ? 'flex' : 'none';
  btn.classList.toggle('is-open', !!open); btn.setAttribute('aria-expanded', String(!!open));
  if (open) {
    menu.style.left = '0px'; const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 12) menu.style.left = `${Math.min(0, window.innerWidth - 12 - rect.right)}px`;
  }
}

async function setThinkingLevel(level, opts) {
  opts = opts || {};
  applyThinkingLevelUI(normalizeThinkingLevel(level));
  const next = currentThinkingLevel;
  try { localStorage.setItem('iexa-thinking-level', next); } catch { /* keep current UI usable */ }
  if (!opts.keepOpen) setThinkingMenuOpen(false);
  if (opts.skipSave) return;
  const revision = ++thinkingLevelSaveRevision;
  const feedback = document.getElementById('thinkingSliderFeedback');
  if (feedback) { feedback.hidden = true; feedback.textContent = ''; }
  // Serialize rapid commits; the saved value is the model-clamped selection.
  thinkingLevelSaveQueue = thinkingLevelSaveQueue.catch(() => {}).then(async () => {
    const response = await fetch(API_BASE + '/api/thinking-level', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thinkingLevel: next }),
    });
    if (!response.ok) throw new Error(`保存失败 (${response.status})`);
  });
  try { await thinkingLevelSaveQueue; }
  catch (error) {
    if (revision === thinkingLevelSaveRevision && feedback) { feedback.textContent = '档位尚未保存，请重试'; feedback.hidden = false; }
    console.warn('save thinking level failed', error);
  }
}

function initThinkingLevelControl() {
  const btn = document.getElementById('thinkingLevelBtn'), menu = document.getElementById('thinkingLevelMenu'), wrap = document.getElementById('thinkingLevelWrap');
  if (!btn || !menu || !wrap) return;
  applyThinkingLevelUI(currentThinkingLevel);
  btn.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    const open = menu.style.display === 'none' || !menu.style.display;
    setThinkingMenuOpen(open);
    if (open) document.getElementById('thinkingLevelSlider')?.focus({ preventScroll: true });
  });
  const slider = document.getElementById('thinkingLevelSlider');
  slider?.addEventListener('input', () => {
    const index = Math.max(0, Math.min(Number(slider.max), Number(slider.value)));
    applyThinkingLevelUI(THINKING_LEVEL_ORDER[index]);
  });
  slider?.addEventListener('change', () => setThinkingLevel(THINKING_LEVEL_ORDER[Number(slider.value)], { keepOpen: true }));
  document.getElementById('thinkingSliderReset')?.addEventListener('click', () => setThinkingLevel('medium', { keepOpen: true }));
  document.addEventListener('click', event => { if (!wrap.contains(event.target)) setThinkingMenuOpen(false); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.style.display !== 'none') { setThinkingMenuOpen(false); btn.focus({ preventScroll: true }); }
  });
}

// ---- Model Selector (chat bar, same popover pattern as thinking level) ----

function activeSessionProfile() {
  const boundId = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding?.profileId;
  return modelSelectorProfiles.find((profile) => profile.id === boundId)
    || modelSelectorProfiles.find((profile) => profile.id === activeProfileId)
    || null;
}
function syncFastModeUI() {
  const button = document.getElementById('fastModeBtn');
  if (!button) return;
  const session = sessionsCache.find((item) => item.id === currentSessionId);
  const profile = activeSessionProfile();
  const supported = !!profile?.supportsFastMode;
  const enabled = supported && session?.fastModeEnabled === true;
  button.style.display = supported ? 'inline-flex' : 'none';
  button.classList.toggle('is-enabled', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.title = enabled
    ? 'Fast 已开启：请求使用 service_tier: priority'
    : '开启 Codex Fast：请求使用 service_tier: priority';
}
async function toggleFastMode() {
  const session = sessionsCache.find((item) => item.id === currentSessionId);
  const profile = activeSessionProfile();
  if (!session || !profile?.supportsFastMode) return;
  if (isProcessing) { addError('当前会话正在执行任务，请结束或停止后再切换 Fast 模式。'); return; }
  const enabled = session.fastModeEnabled !== true;
  const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/fast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { addError(data.error || '切换 Fast 模式失败。'); return; }
  const index = sessionsCache.findIndex((item) => item.id === currentSessionId);
  if (index >= 0 && data.session) sessionsCache[index] = { ...sessionsCache[index], ...data.session };
  syncFastModeUI();
}

function setModelMenuOpen(open) {
  const btn = document.getElementById('modelSelector');
  const menu = document.getElementById('modelSelectorMenu');
  if (!btn || !menu) return;
  menu.style.display = open ? 'flex' : 'none';
  btn.classList.toggle('is-open', open);
  btn.setAttribute('aria-expanded', String(open));
}

async function selectModelProfile(id) {
  const boundId = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding?.profileId;
  if (!id || id === boundId || !currentSessionId) {
    setModelMenuOpen(false);
    return;
  }
  if (isProcessing) {
    addError('当前会话正在执行任务，请结束或停止后再切换模型。');
    setModelMenuOpen(false);
    return;
  }
  const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/model`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: id }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    addError(data.error || '切换本会话模型失败。');
    return;
  }
  const index = sessionsCache.findIndex((session) => session.id === currentSessionId);
  if (index >= 0 && data.session) sessionsCache[index] = { ...sessionsCache[index], ...data.session };
  setModelMenuOpen(false);
  await refreshModelSelector();
}

async function refreshModelSelector() {
  const btn = document.getElementById('modelSelector');
  const label = document.getElementById('modelSelectorLabel');
  const menu = document.getElementById('modelSelectorMenu');
  const list = document.getElementById('modelSelectorList') || menu;
  const hint = document.getElementById('modelBarHint');
  const data = await fetchProfiles();
  if (!btn || !label || !list) return;

  modelSelectorProfiles = data.profiles || [];
  list.innerHTML = '';
  if (!modelSelectorProfiles.length) {
    label.textContent = '— 尚未配置模型 —';
    btn.disabled = true;
    hint.textContent = '请在设置中添加模型';
    return;
  }

  btn.disabled = false;
  const binding = sessionsCache.find((session) => session.id === currentSessionId)?.modelBinding;
  const active = modelSelectorProfiles.find((profile) => profile.id === binding?.profileId)
    || modelSelectorProfiles.find((profile) => profile.id === data.activeProfileId)
    || modelSelectorProfiles[0];
  // activeProfileId remains the global default used only for new sessions/settings.
  activeProfileId = data.activeProfileId || active.id;
  label.textContent = active.name || (active.provider + '/' + active.model);
  btn.title = `本会话模型：${active.provider} / ${active.model}`;
  const routeName = active.provider === 'anthropic' ? 'Messages' : active.apiMode === 'responses' ? 'Responses' : 'Chat';
  hint.textContent = `本会话 · ${active.provider} · ${active.model} · ${routeName}`;
  syncFastModeUI();
  applyThinkingLevelUI(currentThinkingLevel);
  document.dispatchEvent(new Event('token-calculator-profile-change'));
  document.dispatchEvent(new CustomEvent('iexa:active-profile', { detail: { id: active.id, provider: active.provider } }));

  modelSelectorProfiles.forEach((p) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'model-selector-option' + (p.id === active.id ? ' is-active' : '');
    option.dataset.id = p.id;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(p.id === active.id));
    option.innerHTML = `<span class="model-selector-option-main"><span class="model-selector-option-title">${escapeHtml(p.name || (p.provider + '/' + p.model))}</span><span class="model-selector-option-desc">${escapeHtml(p.provider + ' · ' + p.model)}</span></span><span class="model-selector-option-check" aria-hidden="true"></span>`;
    option.addEventListener('click', () => selectModelProfile(p.id));
    list.appendChild(option);
  });
}

function initModelSelectorControl() {
  const btn = document.getElementById('modelSelector');
  const wrap = document.getElementById('modelSelectorWrap');
  if (!btn || !wrap) return;
  btn.addEventListener('click', () => setModelMenuOpen(btn.getAttribute('aria-expanded') !== 'true'));
  // The refresh action lives inside the dropdown so the bar keeps one control
  // per concern. The footer sits outside the scrolling list, so a rebuild of
  // the options cannot detach the button the user just pressed.
  const refresh = document.getElementById('modelSelectorRefresh');
  refresh?.addEventListener('click', async () => {
    if (refresh.dataset.busy === 'true') return;
    refresh.dataset.busy = 'true';
    try {
      await refreshModelSelector();
    } finally {
      refresh.dataset.busy = 'false';
      if (refresh.isConnected) refresh.focus({ preventScroll: true });
    }
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) setModelMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setModelMenuOpen(false);
  });
}

// A popover paints a rounded card, so the pixels inside its bounding box but
// outside the rounded corner are not part of its hit area and would reach the
// transcript behind the panel. Swallow pointer input for that sliver so a click
// on the panel's box can never act on what is underneath it.
function installPopoverHitGuard() {
  const POPOVERS = '.model-selector-menu, .thinking-level-menu, .context-compaction-menu, .permission-mode-menu, .files-context-menu, .text-context-menu, .slash-menu, .checkpoint-popover';
  const openPopoverAt = (x, y) => {
    for (const popover of document.querySelectorAll(POPOVERS)) {
      if (!popover.getClientRects().length) continue;
      if (getComputedStyle(popover).visibility === 'hidden') continue;
      const box = popover.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return popover;
    }
    return null;
  };
  const guard = (event) => {
    const popover = openPopoverAt(event.clientX, event.clientY);
    if (!popover || popover.contains(event.target)) return;
    // Swallow the event for the sliver. preventDefault also stops the derived
    // compatibility click, and stopImmediatePropagation keeps any other
    // document-level capture listener (menu closers, palette handlers) from
    // seeing a press that visually belongs to the panel.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
    document.addEventListener(type, guard, true);
  }
}

// ---- Context compaction ceiling (auto / 128K / 256K / 384K / 768K / 1M) ----
let currentContextCompactionLimit = null;

const CONTEXT_COMPACTION_OPTIONS = [
  { limit: null, label: '自动', desc: '按模型上下文上限' },
  { limit: 128000, label: '128K', desc: '约 12.8 万 token' },
  { limit: 256000, label: '256K', desc: '约 25.6 万 token' },
  { limit: 384000, label: '384K', desc: '约 38.4 万 token' },
  { limit: 768000, label: '768K', desc: '约 76.8 万 token' },
  { limit: 1000000, label: '1M', desc: '约 100 万 token' },
];

function normalizeContextCompactionLimit(value) {
  if (value === undefined || value === null || value === '' || value === 'auto' || value === '0') return null;
  const numeric = Number(value);
  const option = CONTEXT_COMPACTION_OPTIONS.find((item) => item.limit === numeric);
  return option ? option.limit : null;
}

function formatContextCompactionLabel(limit) {
  const option = CONTEXT_COMPACTION_OPTIONS.find((item) => item.limit === normalizeContextCompactionLimit(limit));
  return option ? option.label : '自动';
}

function applyContextCompactionUI(limit) {
  currentContextCompactionLimit = normalizeContextCompactionLimit(limit);
  const btn = document.getElementById('contextCompactionBtn');
  const label = document.getElementById('contextCompactionLabel');
  const title = currentContextCompactionLimit
    ? `自动压缩档位：${formatContextCompactionLabel(currentContextCompactionLimit)}（上限 ${formatTokenCount(currentContextCompactionLimit)} token）`
    : '自动压缩档位：自动（按模型上下文上限）';
  if (btn) {
    btn.dataset.limit = currentContextCompactionLimit === null ? 'auto' : String(currentContextCompactionLimit);
    btn.title = title;
  }
  if (label) label.textContent = formatContextCompactionLabel(currentContextCompactionLimit);
  const menu = document.getElementById('contextCompactionMenu');
  if (menu) {
    menu.querySelectorAll('.context-compaction-option').forEach((el) => {
      const optionLimit = el.dataset.limit === 'auto' ? null : Number(el.dataset.limit);
      el.classList.toggle('is-active', optionLimit === currentContextCompactionLimit);
    });
  }
}

function setContextCompactionMenuOpen(open) {
  const btn = document.getElementById('contextCompactionBtn');
  const menu = document.getElementById('contextCompactionMenu');
  if (btn) {
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  }
  if (menu) menu.style.display = open ? 'block' : 'none';
}

async function setContextCompaction(limit) {
  const next = normalizeContextCompactionLimit(limit);
  currentContextCompactionLimit = next;
  applyContextCompactionUI(next);
  setContextCompactionMenuOpen(false);
  try {
    await fetch(API_BASE + '/api/context-compaction', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextCompactionLimit: next }),
    });
  } catch (e) {
    console.warn('save context compaction failed', e);
  }
}

function initContextCompactionControl() {
  const btn = document.getElementById('contextCompactionBtn');
  const menu = document.getElementById('contextCompactionMenu');
  const wrap = document.getElementById('contextCompactionWrap');
  if (!btn || !menu || !wrap) return;

  applyContextCompactionUI(currentContextCompactionLimit);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = menu.style.display === 'none' || !menu.style.display;
    setContextCompactionMenuOpen(open);
  });

  menu.querySelectorAll('.context-compaction-option').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setContextCompaction(el.dataset.limit);
    });
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) setContextCompactionMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setContextCompactionMenuOpen(false);
  });
}

// ---- Profile List (settings) ----
async function loadVisionProfileSetting() {
  const select = document.getElementById('visionProfileSelect');
  if (!select) return;
  try {
    const response = await fetch(`${API_BASE}/api/vision-profile`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取视觉配置失败');
    select.innerHTML = '<option value="">不使用视觉代理</option>' + (data.profiles || []).map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.model)}</option>`).join('');
    select.value = data.visionProfileId || '';
  } catch (error) { console.error('Failed to load vision profile:', error); }
}

async function saveVisionProfileSetting() {
  const select = document.getElementById('visionProfileSelect');
  if (!select) return;
  try {
    const response = await fetch(`${API_BASE}/api/vision-profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visionProfileId: select.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存视觉配置失败');
  } catch (error) { addError('保存视觉配置失败：' + (error.message || error)); }
}

async function loadSettings() {
  await Promise.all([renderProfileList(), loadVisionProfileSetting()]);
}

async function renderProfileList() {
  const list = document.getElementById('profileList');
  const data = await fetchProfiles();

  if (data.profiles.length === 0) {
    list.innerHTML = '<div class="profile-empty">尚未配置模型。点击"＋ 添加模型"开始。</div>';
    return;
  }

  list.innerHTML = data.profiles.map(p => `
    <div class="profile-card ${p.id === data.activeProfileId ? 'active' : ''}" data-ui-action="activateProfile" data-ui-arg="${escapeHtml(p.id)}">
      <span class="profile-avatar" aria-hidden="true">${escapeHtml(String(p.provider || '?').slice(0, 1).toUpperCase())}</span>
      <div class="profile-card-info">
        <div class="profile-card-title">
          <span class="profile-card-name">${escapeHtml(p.name)}</span>
          ${p.id === data.activeProfileId ? '<span class="profile-active-chip">当前</span>' : ''}
        </div>
        <div class="profile-card-detail"><span class="profile-provider">${escapeHtml(p.provider)}</span><span class="profile-model">${escapeHtml(p.model)}</span></div>
        ${p.baseURL ? `<div class="profile-card-url">${escapeHtml(p.baseURL)}</div>` : ''}
      </div>
      <div class="profile-card-actions" data-ui-action="stop">
        <button data-ui-action="editProfile" data-ui-arg="${escapeHtml(p.id)}" title="编辑" aria-label="编辑">${uiIcon('edit')}</button>
        <button class="danger" data-ui-action="deleteProfile" data-ui-arg="${escapeHtml(p.id)}" title="删除" aria-label="删除">${uiIcon('trash')}</button>
      </div>
    </div>
  `).join('');
}

async function activateProfile(id) {
  await fetch(`${API_BASE}/api/profiles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeProfileId: id }),
  });
  activeProfileId = id;
  renderProfileList();
  loadVisionProfileSetting();
  refreshModelSelector();
}

async function deleteProfile(id) {
  if (!(await window.IexaDialogs.confirm('确定删除这个模型配置？'))) return;
  await fetch(`${API_BASE}/api/profiles/${id}`, { method: 'DELETE' });
  renderProfileList();
  loadVisionProfileSetting();
  refreshModelSelector();
}

// ---- Profile Editor ----
function showProfileEditor(profile) {
  const overlay = document.getElementById('profileEditorOverlay');
  document.getElementById('profileEditorTitle').textContent = profile ? '编辑模型' : '添加模型';
  document.getElementById('profileEditorId').value = profile ? profile.id : '';
  document.getElementById('profileEditorName').value = profile ? profile.name : '';
  document.getElementById('profileEditorProvider').value = profile ? profile.provider : 'anthropic';
  document.getElementById('profileEditorModel').value = profile ? profile.model : '';
  document.getElementById('profileEditorVisionCapability').value = ['native', 'text'].includes(profile?.visionCapability) ? profile.visionCapability : 'auto';
  const rates = profile?.tokenPrice || {};
  document.getElementById('profileEditorPriceInput').value = rates.input ?? '';
  document.getElementById('profileEditorPriceOutput').value = rates.output ?? '';
  document.getElementById('profileEditorPriceCacheRead').value = rates.cacheRead ?? '';
  document.getElementById('profileEditorPriceCacheCreation').value = rates.cacheCreation ?? '';
  document.getElementById('profileEditorApiKey').value = '';
  document.getElementById('profileEditorApiKey').placeholder = profile ? '已保存，留空即可继续使用' : 'sk-...';
  document.getElementById('profileEditorBaseURL').value = profile ? (profile.baseURL || '') : '';
  document.getElementById('profileEditorUserAgent').value = profile?.userAgent || '';
  document.getElementById('profileEditorFastMode').checked = !!(profile && profile.fastModeSupported);
  document.getElementById('profileEditorApiMode').value = profile?.apiMode === 'responses' ? 'responses' : 'chat_completions';
  document.getElementById('profileEditorModelSelect').style.display = 'none';
  document.getElementById('profileEditorModelSelect').innerHTML = '';
  document.getElementById('fetchModelsHint').textContent = '';
  overlay.style.display = 'flex';
  updateEditorPlaceholders();
}

function hideProfileEditor() {
  document.getElementById('profileEditorOverlay').style.display = 'none';
}

function editProfile(id) {
  const p = profilesCache.find(p => p.id === id);
  if (p) showProfileEditor(p);
}

function updateEditorPlaceholders() {
  const prov = document.getElementById('profileEditorProvider').value;
  const m = document.getElementById('profileEditorModel');
  const b = document.getElementById('profileEditorBaseURL');
  if (!m.value) m.placeholder = MODEL_PLACEHOLDERS[prov] || '';
  b.placeholder = BASE_URL_HINTS[prov] || '';
  const apiMode = document.getElementById('profileEditorApiMode');
  const isAnthropic = prov === 'anthropic';
  for (const option of apiMode.options) {
    const isNative = option.value === 'anthropic_messages';
    option.hidden = isAnthropic !== isNative;
    option.disabled = isAnthropic !== isNative;
  }
  if (isAnthropic) apiMode.value = 'anthropic_messages';
  else if (apiMode.value === 'anthropic_messages') apiMode.value = 'chat_completions';
  document.getElementById('profileEditorApiModeHint').textContent = isAnthropic
    ? 'Anthropic 原生 Messages 协议；服务商选 Anthropic 时自动使用 /v1/messages。'
    : 'Responses 使用独立的消息、工具和流式事件协议；仅在端点实际支持时选择。';
}

function formatContextTokensForDisplay(tokens) {
  if (!tokens || tokens < 1000) return String(tokens);
  return (tokens / 1000).toFixed(tokens >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
}

async function fetchModels() {
  let baseURL = document.getElementById('profileEditorBaseURL').value.trim();
  const apiKey = document.getElementById('profileEditorApiKey').value.trim();
  const profileId = document.getElementById('profileEditorId').value;
  const btn = document.getElementById('fetchModelsBtn');
  const hint = document.getElementById('fetchModelsHint');
  const select = document.getElementById('profileEditorModelSelect');

  if (!baseURL) {
    const prov = document.getElementById('profileEditorProvider').value;
    baseURL = BASE_URL_HINTS[prov] || '';
  }
  if (!baseURL) {
    hint.textContent = '请先填写接口地址。';
    return;
  }
  if (!apiKey && !profileId) {
    hint.textContent = '请先填写 API 密钥。';
    return;
  }

  hint.textContent = '⏳ 正在获取模型列表...';
  btn.disabled = true;
  select.style.display = 'none';
  select.innerHTML = '';
  try {
    const resp = await fetch(`${API_BASE}/api/profiles/fetch-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, apiKey, profileId, provider: document.getElementById('profileEditorProvider').value, userAgent: document.getElementById('profileEditorUserAgent').value }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      hint.textContent = data.error || '获取失败';
      return;
    }
    // Models can be strings or objects { id, contextWindow?, maxOutputTokens? }
    const modelList = data.models.map(m => {
      if (typeof m === 'string') return { id: m };
      return { id: m.id, contextWindow: m.contextWindow };
    });
    select.innerHTML = '<option value="">— 选择模型 —</option>' +
      modelList.map(m => {
        const label = m.contextWindow ? m.id + '  (' + formatContextTokensForDisplay(m.contextWindow) + ')' : m.id;
        const contextWindow = m.contextWindow || '';
        return `<option value="${escapeHtml(m.id)}" data-context-window="${escapeHtml(String(contextWindow))}">${escapeHtml(label)}</option>`;
      }).join('');
    select.style.display = 'block';
    hint.textContent = `找到 ${modelList.length} 个模型，请选择。`;
  } catch (err) {
    hint.textContent = '获取失败：' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function saveProfile() {
  const id = document.getElementById('profileEditorId').value;
  // The ID stays in value; metadata is kept separately to avoid invalid HTML characters.
  const modelSelect = document.getElementById('profileEditorModelSelect');
  let profileModel = document.getElementById('profileEditorModel').value.trim();
  let contextWindow = undefined;
  if (modelSelect && modelSelect.value && profileModel === modelSelect.value) {
    const selectedOption = modelSelect.selectedOptions[0];
    const cw = Number(selectedOption?.dataset.contextWindow);
    if (Number.isFinite(cw) && cw > 0) contextWindow = cw;
  }
  const profile = {
    id: id || undefined,
    name: document.getElementById('profileEditorName').value.trim(),
    provider: document.getElementById('profileEditorProvider').value,
    model: profileModel,
    visionCapability: document.getElementById('profileEditorVisionCapability').value,
    tokenPrice: (() => {
      const input = document.getElementById('profileEditorPriceInput').value.trim();
      const output = document.getElementById('profileEditorPriceOutput').value.trim();
      if (!input && !output) return null;
      return {
        input,
        output,
        cacheRead: document.getElementById('profileEditorPriceCacheRead').value.trim(),
        cacheCreation: document.getElementById('profileEditorPriceCacheCreation').value.trim(),
      };
    })(),
    apiKey: document.getElementById('profileEditorApiKey').value.trim(),
    baseURL: document.getElementById('profileEditorBaseURL').value.trim(),
    userAgent: document.getElementById('profileEditorUserAgent').value,
    contextWindow: contextWindow,
    fastModeSupported: !!document.getElementById('profileEditorFastMode').checked,
    apiMode: document.getElementById('profileEditorProvider').value === 'anthropic' ? 'anthropic_messages'
      : document.getElementById('profileEditorApiMode').value === 'responses' ? 'responses' : 'chat_completions',
  };

  if (!profile.name) profile.name = profile.model || '未命名';
  if (!profile.model) { (await window.IexaDialogs.alert('请输入模型 ID。')); return; }

  const response = await fetch(`${API_BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    await window.IexaDialogs.alert(error.error || '模型配置保存失败');
    return;
  }
  hideProfileEditor();
  renderProfileList();
  loadVisionProfileSetting();
  refreshModelSelector();
}

// Every listener this module owns is installed from here, never at load time.
// The script is evaluated before app.js, so a top-level call could reach a
// binding that app.js has not initialised yet (temporal dead zone).
function initModelProfilesModule() {
  initModelSelectorControl();
  installPopoverHitGuard();
  const fastModeBtn = document.getElementById('fastModeBtn');
  if (fastModeBtn) fastModeBtn.addEventListener('click', () => toggleFastMode().catch((error) => addError(error?.message || String(error))));
  initThinkingLevelControl();
  initContextCompactionControl();
  // Provider change → update model placeholder
  document.getElementById('profileEditorProvider')?.addEventListener('change', updateEditorPlaceholders);
}
