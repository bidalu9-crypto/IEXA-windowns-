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
  if (label) label.textContent = IexaI18n.t(THINKING_LEVELS[currentThinkingLevel].labelKey);
  if (btn) {
    btn.dataset.level = currentThinkingLevel;
    btn.title = IexaI18n.t('think.levelTitle', { level: IexaI18n.t(THINKING_LEVELS[currentThinkingLevel].labelKey) });
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
      slider.setAttribute('aria-valuetext', IexaI18n.t(THINKING_LEVELS[currentThinkingLevel].labelKey));
    }
    if (track) {
      track.style.setProperty('--thinking-fill', `${maxIndex ? selected / maxIndex * 100 : 0}%`);
    }
    if (value) {
      value.textContent = IexaI18n.t(THINKING_LEVELS[currentThinkingLevel].labelKey);
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
    if (!response.ok) throw new Error(IexaI18n.t('model.saveFailed', { status: response.status }));
  });
  try { await thinkingLevelSaveQueue; }
  catch (error) {
    if (revision === thinkingLevelSaveRevision && feedback) { feedback.textContent = IexaI18n.t('model.levelSaveFailed'); feedback.hidden = false; }
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
    ? IexaI18n.t('model.fastOn')
    : IexaI18n.t('model.fastOff');
}
async function toggleFastMode() {
  const session = sessionsCache.find((item) => item.id === currentSessionId);
  const profile = activeSessionProfile();
  if (!session || !profile?.supportsFastMode) return;
  if (isProcessing) { addError(IexaI18n.t('model.fastBusy')); return; }
  const enabled = session.fastModeEnabled !== true;
  const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/fast`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { addError(data.error || IexaI18n.t('model.fastFailed')); return; }
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
    addError(IexaI18n.t('model.modelBusy'));
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
    addError(data.error || IexaI18n.t('model.modelFailed'));
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
    label.textContent = IexaI18n.t('model.none');
    btn.disabled = true;
    hint.textContent = IexaI18n.t('model.addInSettings');
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
  btn.title = IexaI18n.t('model.sessionModel', { provider: active.provider, model: active.model });
  const routeName = active.provider === 'anthropic' ? 'Messages' : active.apiMode === 'responses' ? 'Responses' : 'Chat';
  hint.textContent = IexaI18n.t('model.sessionMeta', { provider: active.provider, model: active.model, route: routeName });
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

// ---- Context compaction ceiling (auto / presets / custom) and trigger point ----
let currentContextCompactionLimit = null;
let currentContextCompactionThreshold = null;
const MIN_CONTEXT_COMPACTION_LIMIT = 128000;
const MAX_CONTEXT_COMPACTION_LIMIT = 10000000;
const DEFAULT_CONTEXT_COMPACTION_THRESHOLD = 80;

const CONTEXT_COMPACTION_OPTIONS = [
  { limit: null, label: IexaI18n.t('model.auto'), desc: IexaI18n.t('model.autoHint') },
  { limit: 128000, label: '128K', desc: IexaI18n.t('model.preset128') },
  { limit: 256000, label: '256K', desc: IexaI18n.t('model.preset256') },
  { limit: 384000, label: '384K', desc: IexaI18n.t('model.preset384') },
  { limit: 768000, label: '768K', desc: IexaI18n.t('model.preset768') },
  { limit: 1000000, label: '1M', desc: IexaI18n.t('model.preset1m') },
];

/** Any integer at or above 128K; the presets are shortcuts, not a whitelist. */
function normalizeContextCompactionLimit(value) {
  if (value === undefined || value === null || value === '' || value === 'auto' || value === '0') return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return null;
  if (numeric < MIN_CONTEXT_COMPACTION_LIMIT || numeric > MAX_CONTEXT_COMPACTION_LIMIT) return null;
  return numeric;
}

function normalizeContextCompactionThreshold(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const percent = numeric > 1 ? numeric : numeric * 100;
  if (percent < 50 || percent > 100) return null;
  return Math.round(percent);
}

function formatContextCompactionLabel(limit) {
  const normalized = normalizeContextCompactionLimit(limit);
  if (normalized === null) return IexaI18n.t('model.auto');
  const preset = CONTEXT_COMPACTION_OPTIONS.find((item) => item.limit === normalized);
  if (preset) return preset.label;
  // Custom windows read best as the same K/M shorthand the presets use.
  if (normalized >= 1000000) {
    const millions = normalized / 1000000;
    return (Number.isInteger(millions) ? String(millions) : millions.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + 'M';
  }
  const thousands = normalized / 1000;
  return (Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1)) + 'K';
}

function formatContextCompactionThreshold(percent) {
  return percent === null ? IexaI18n.t('model.default80') : `${percent}%`;
}

function applyContextCompactionThresholdUI(percent) {
  currentContextCompactionThreshold = percent;
  const input = document.getElementById('contextCompactionThresholdInput');
  const hint = document.getElementById('contextCompactionThresholdHint');
  const value = document.getElementById('ccThresholdValue');
  if (input) {
    if (document.activeElement !== input) input.value = percent === null ? '' : String(percent);
    input.removeAttribute('aria-invalid');
  }
  if (value) value.textContent = formatContextCompactionThreshold(percent);
  if (hint) {
    hint.textContent = percent === null ? IexaI18n.t('model.thresholdHint') : IexaI18n.t('model.thresholdActive', { percent });
    hint.dataset.tone = 'ok';
  }
  document.querySelectorAll('.cc-chip[data-threshold]').forEach((el) => {
    el.setAttribute('aria-selected', String(Number(el.dataset.threshold) === percent));
  });
}

function applyContextCompactionUI(limit) {
  currentContextCompactionLimit = normalizeContextCompactionLimit(limit);
  const btn = document.getElementById('contextCompactionBtn');
  const label = document.getElementById('contextCompactionLabel');
  const limitHint = document.getElementById('contextCompactionCustomHint');
  const limitValue = document.getElementById('ccLimitValue');
  const customInput = document.getElementById('contextCompactionCustomInput');
  const title = currentContextCompactionLimit
    ? IexaI18n.t('model.compactionPreset', { label: formatContextCompactionLabel(currentContextCompactionLimit), limit: formatTokenCount(currentContextCompactionLimit) })
    : IexaI18n.t('model.compactionAuto');
  if (btn) {
    btn.dataset.limit = currentContextCompactionLimit === null ? 'auto' : String(currentContextCompactionLimit);
    btn.title = title;
  }
  if (label) label.textContent = formatContextCompactionLabel(currentContextCompactionLimit);
  const isPreset = CONTEXT_COMPACTION_OPTIONS.some((item) => item.limit === currentContextCompactionLimit);
  if (customInput) {
    if (document.activeElement !== customInput && !isPreset && currentContextCompactionLimit !== null) {
      customInput.value = String(currentContextCompactionLimit);
    }
    customInput.removeAttribute('aria-invalid');
  }
  if (limitValue) {
    limitValue.textContent = currentContextCompactionLimit === null
      ? IexaI18n.t('model.byModelLimit')
      : `${formatContextCompactionLabel(currentContextCompactionLimit)} · ${formatTokenCount(currentContextCompactionLimit)}`;
  }
  if (limitHint) {
    limitHint.textContent = !isPreset && currentContextCompactionLimit !== null
      ? IexaI18n.t('model.customCapacity', { limit: formatTokenCount(currentContextCompactionLimit) })
      : IexaI18n.t('model.minCustom');
    limitHint.dataset.tone = 'ok';
  }
  const menu = document.getElementById('contextCompactionMenu');
  if (menu) {
    menu.querySelectorAll('.cc-chip[data-limit]').forEach((el) => {
      const custom = el.dataset.limit === 'custom';
      const selected = custom
        ? !isPreset && currentContextCompactionLimit !== null
        : (el.dataset.limit === 'auto' ? null : Number(el.dataset.limit)) === currentContextCompactionLimit;
      el.setAttribute('aria-selected', String(selected));
    });
  }
}

function setContextCompactionMenuOpen(open) {
  const btn = document.getElementById('contextCompactionBtn');
  const menu = document.getElementById('contextCompactionMenu');
  const wrap = document.getElementById('contextCompactionWrap');
  if (btn) {
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  }
  // The sibling permission control shares z-index 50 and comes later in the DOM,
  // so it would paint over the open panel. Raise this wrapper only while open.
  if (wrap) wrap.classList.toggle('is-open', open);
  if (menu) menu.style.display = open ? 'block' : 'none';
  // Each open starts from the presets: the custom field is a disclosure, and
  // leaving it expanded with no chip marker reads as a broken panel.
  if (!open) {
    const custom = document.getElementById('contextCompactionCustom');
    if (custom) custom.hidden = true;
    const chip = document.querySelector('.cc-chip[data-limit="custom"]');
    if (chip) {
      chip.classList.remove('is-open');
      chip.setAttribute('aria-expanded', 'false');
    }
  }
}

/**
 * Persist one setting. The server rejects out-of-range values with a message, so
 * this surfaces the failure instead of pretending the change stuck.
 */
async function putContextCompaction(payload) {
  const response = await fetch(API_BASE + '/api/context-compaction', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || IexaI18n.t('model.contextSaveFailed'));
  return data;
}

async function setContextCompaction(limit) {
  const next = normalizeContextCompactionLimit(limit);
  try {
    await putContextCompaction({ contextCompactionLimit: next });
    applyContextCompactionUI(next);
    setContextCompactionMenuOpen(false);
    flashSaved(document.getElementById('contextCompactionCustomConfirm'));
  } catch (e) {
    const hint = document.getElementById('contextCompactionCustomHint');
    if (hint) { hint.textContent = e.message || String(e); hint.dataset.tone = 'error'; }
    console.warn('save context compaction failed', e);
  }
}

async function setContextCompactionThreshold(percent) {
  const next = percent === null ? null : normalizeContextCompactionThreshold(percent);
  const hint = document.getElementById('contextCompactionThresholdHint');
  if (percent !== null && next === null) {
    if (hint) { hint.textContent = IexaI18n.t('model.percentRange'); hint.dataset.tone = 'error'; }
    return;
  }
  try {
    await putContextCompaction({ contextCompactionThreshold: next === null ? null : next / 100 });
    applyContextCompactionThresholdUI(next);
    applyLocalCompactionThreshold(next);
    flashSaved(document.getElementById('contextCompactionThresholdConfirm'));
  } catch (e) {
    if (hint) { hint.textContent = e.message || String(e); hint.dataset.tone = 'error'; }
    console.warn('save compaction threshold failed', e);
  }
}

/**
 * The ring prints the server's `compactThreshold`. Mirror the new ratio at once
 * so the tooltip and the mist react to the save instead of waiting for the next
 * context event.
 */
function applyLocalCompactionThreshold(percent) {
  const status = typeof latestContextStatus !== 'undefined' ? latestContextStatus : null;
  if (!status) return;
  const windowTokens = Number(status.contextWindow);
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return;
  const ratio = percent === null ? DEFAULT_CONTEXT_COMPACTION_THRESHOLD / 100 : percent / 100;
  status.compactThreshold = Math.round(windowTokens * ratio);
  handleContextStatus(status);
}

/** Brief confirmation on the button that was pressed; nothing else to show. */
function flashSaved(button) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = IexaI18n.t('model.saved');
  button.dataset.saved = 'true';
  clearTimeout(button._savedTimer);
  button._savedTimer = setTimeout(() => {
    button.textContent = button.dataset.label || IexaI18n.t('model.apply');
    delete button.dataset.saved;
  }, 1200);
}

/** Hydrate both settings from the server (authoritative over any cached value). */
async function loadContextCompactionSettings() {
  try {
    const response = await fetch(API_BASE + '/api/context-compaction');
    if (!response.ok) return;
    const data = await response.json();
    applyContextCompactionUI(normalizeContextCompactionLimit(data.contextCompactionLimit));
    applyContextCompactionThresholdUI(normalizeContextCompactionThreshold(data.contextCompactionThreshold));
  } catch (error) {
    console.warn('load context compaction failed', error);
  }
}

function initContextCompactionControl() {
  const btn = document.getElementById('contextCompactionBtn');
  const menu = document.getElementById('contextCompactionMenu');
  const wrap = document.getElementById('contextCompactionWrap');
  if (!btn || !menu || !wrap) return;

  applyContextCompactionUI(currentContextCompactionLimit);
  applyContextCompactionThresholdUI(currentContextCompactionThreshold);
  void loadContextCompactionSettings();

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = menu.style.display === 'none' || !menu.style.display;
    setContextCompactionMenuOpen(open);
  });

  menu.querySelectorAll('.cc-chip[data-limit]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The custom chip is a disclosure, not a value: it reveals the input and
      // leaves the current ceiling untouched until the user applies a number.
      if (el.dataset.limit === 'custom') {
        const custom = document.getElementById('contextCompactionCustom');
        if (custom) {
          // Second click collapses the disclosure instead of leaving an orphan
          // field under a chip that looks pressed.
          const opening = custom.hidden;
          custom.hidden = !opening;
          menu.querySelectorAll('.cc-chip[data-limit="custom"]').forEach((chip) => {
            chip.classList.toggle('is-open', opening);
            chip.setAttribute('aria-expanded', String(opening));
          });
          if (opening) {
            const input = document.getElementById('contextCompactionCustomInput');
            input?.focus();
            input?.select();
          }
        }
        return;
      }
      void setContextCompaction(el.dataset.limit);
    });
  });

  const customInput = document.getElementById('contextCompactionCustomInput');
  const customConfirm = document.getElementById('contextCompactionCustomConfirm');
  const commitCustom = () => {
    const raw = Number(customInput?.value);
    const hint = document.getElementById('contextCompactionCustomHint');
    if (!Number.isSafeInteger(raw) || raw < MIN_CONTEXT_COMPACTION_LIMIT || raw > MAX_CONTEXT_COMPACTION_LIMIT) {
      if (hint) { hint.textContent = IexaI18n.t('model.limitRange'); hint.dataset.tone = 'error'; }
      customInput?.focus();
      return;
    }
    void setContextCompaction(raw);
  };
  customConfirm?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); commitCustom(); });
  customInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitCustom(); }
  });

  menu.querySelectorAll('.cc-chip[data-threshold]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void setContextCompactionThreshold(Number(el.dataset.threshold));
    });
  });

  menu.querySelectorAll('.cc-step').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const input = document.getElementById(el.dataset.step || '');
      if (!input) return;
      const delta = Number(el.dataset.delta) || 1;
      const direction = Number(el.dataset.dir) || 1;
      const min = Number(input.min);
      const max = Number(input.max);
      const typed = Number(input.value);
      // An empty field steps from the placeholder, so the first click lands on a
      // sensible number instead of jumping to the minimum.
      const base = input.value !== '' && Number.isFinite(typed)
        ? typed
        : (Number(input.placeholder) || (Number.isFinite(min) ? min : 0));
      const next = Math.min(Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER,
        Math.max(Number.isFinite(min) ? min : 0, base + delta * direction));
      input.value = String(next);
      input.removeAttribute('aria-invalid');
      input.focus({ preventScroll: true });
    });
  });

  const thresholdInput = document.getElementById('contextCompactionThresholdInput');
  const thresholdConfirm = document.getElementById('contextCompactionThresholdConfirm');
  const commitThreshold = () => {
    const raw = Number(thresholdInput?.value);
    const hint = document.getElementById('contextCompactionThresholdHint');
    if (!Number.isFinite(raw) || raw < 50 || raw > 100) {
      if (hint) { hint.textContent = IexaI18n.t('model.percentRange'); hint.dataset.tone = 'error'; }
      thresholdInput?.focus();
      return;
    }
    void setContextCompactionThreshold(raw);
  };
  thresholdConfirm?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); commitThreshold(); });
  thresholdInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitThreshold(); }
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
    if (!response.ok) throw new Error(data.error || IexaI18n.t('model.visionLoadFailed'));
    select.innerHTML = IexaI18n.t('model.visionNone') + (data.profiles || []).map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.model)}</option>`).join('');
    select.value = data.visionProfileId || '';
  } catch (error) { console.error('Failed to load vision profile:', error); }
}

async function saveVisionProfileSetting() {
  const select = document.getElementById('visionProfileSelect');
  if (!select) return;
  try {
    const response = await fetch(`${API_BASE}/api/vision-profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visionProfileId: select.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || IexaI18n.t('model.visionSaveFailed'));
  } catch (error) { addError(IexaI18n.t('model.visionSaveFailedDetail') + (error.message || error)); }
}

async function loadSettings() {
  await Promise.all([renderProfileList(), loadVisionProfileSetting()]);
}

async function renderProfileList() {
  const list = document.getElementById('profileList');
  const data = await fetchProfiles();

  if (data.profiles.length === 0) {
    list.innerHTML = IexaI18n.t('model.empty');
    return;
  }

  list.innerHTML = data.profiles.map(p => `
    <div class="profile-card ${p.id === data.activeProfileId ? 'active' : ''}" data-ui-action="activateProfile" data-ui-arg="${escapeHtml(p.id)}">
      <span class="profile-avatar" aria-hidden="true">${escapeHtml(String(p.provider || '?').slice(0, 1).toUpperCase())}</span>
      <div class="profile-card-info">
        <div class="profile-card-title">
          <span class="profile-card-name">${escapeHtml(p.name)}</span>
          ${p.id === data.activeProfileId ? IexaI18n.t('model.current') : ''}
        </div>
        <div class="profile-card-detail"><span class="profile-model">${escapeHtml(p.model)}</span></div>
        ${p.baseURL ? `<div class="profile-card-url">${escapeHtml(p.baseURL)}</div>` : ''}
      </div>
      <span class="profile-provider-chip">${escapeHtml(p.provider)}</span>
      <div class="profile-card-actions" data-ui-action="stop">
        <button data-ui-action="editProfile" data-ui-arg="${escapeHtml(p.id)}" title="${IexaI18n.t('model.edit')}" aria-label="${IexaI18n.t('model.edit')}">${uiIcon('edit')}</button>
        <button class="danger" data-ui-action="deleteProfile" data-ui-arg="${escapeHtml(p.id)}" title="${IexaI18n.t('model.delete')}" aria-label="${IexaI18n.t('model.delete')}">${uiIcon('trash')}</button>
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
  if (!(await window.IexaDialogs.confirm(IexaI18n.t('model.deleteConfirm')))) return;
  await fetch(`${API_BASE}/api/profiles/${id}`, { method: 'DELETE' });
  renderProfileList();
  loadVisionProfileSetting();
  refreshModelSelector();
}

// ---- Profile Editor ----
function showProfileEditor(profile) {
  const overlay = document.getElementById('profileEditorOverlay');
  document.getElementById('profileEditorTitle').textContent = profile ? IexaI18n.t('model.editTitle') : IexaI18n.t('model.addTitle');
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
  document.getElementById('profileEditorApiKey').placeholder = profile ? IexaI18n.t('model.keyPlaceholder') : 'sk-...';
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
    ? IexaI18n.t('model.apiModeAnthropic')
    : IexaI18n.t('model.apiModeResponses');
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
    hint.textContent = IexaI18n.t('model.needBaseUrl');
    return;
  }
  if (!apiKey && !profileId) {
    hint.textContent = IexaI18n.t('model.needApiKey');
    return;
  }

  hint.textContent = IexaI18n.t('model.fetching');
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
      hint.textContent = data.error || IexaI18n.t('model.fetchFailed');
      return;
    }
    // Models can be strings or objects { id, contextWindow?, maxOutputTokens? }
    const modelList = data.models.map(m => {
      if (typeof m === 'string') return { id: m };
      return { id: m.id, contextWindow: m.contextWindow };
    });
    select.innerHTML = IexaI18n.t('model.chooseModel') +
      modelList.map(m => {
        const label = m.contextWindow ? m.id + '  (' + formatContextTokensForDisplay(m.contextWindow) + ')' : m.id;
        const contextWindow = m.contextWindow || '';
        return `<option value="${escapeHtml(m.id)}" data-context-window="${escapeHtml(String(contextWindow))}">${escapeHtml(label)}</option>`;
      }).join('');
    select.style.display = 'block';
    hint.textContent = IexaI18n.t('model.found', { count: modelList.length });
  } catch (err) {
    hint.textContent = IexaI18n.t('model.fetchFailedDetail') + err.message;
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

  if (!profile.name) profile.name = profile.model || IexaI18n.t('model.untitled');
  if (!profile.model) { (await window.IexaDialogs.alert(IexaI18n.t('model.needModelId'))); return; }

  const response = await fetch(`${API_BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    await window.IexaDialogs.alert(error.error || IexaI18n.t('model.saveProfileFailed'));
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
