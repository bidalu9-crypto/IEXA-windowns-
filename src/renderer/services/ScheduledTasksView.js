// =============================================================================
// Scheduled tasks panel.
//
// A scheduled task is a saved prompt plus a wall-clock rule. The panel owns the
// editor, the enable switch and the next-run readout; the server owns the clock,
// so what is shown here is a projection of `nextRunAt`, never a local timer.
//
// Classic script: declarations join app.js's global scope. No DOM work at load.
// =============================================================================
let scheduledTasksCache = [];
let scheduledTasksLoaded = false;
let scheduledTasksError = '';
let scheduledTimezone = '';
let scheduledEditorTask = null;
let scheduledDraftFrequency = 'daily';
let scheduledDraftTarget = 'new';
let scheduledEditorReturnFocus = null;
const scheduledRunning = new Set();
const SCHEDULED_WEEKDAYS = [IexaI18n.t('sched.weekday.0'), IexaI18n.t('sched.weekday.1'), IexaI18n.t('sched.weekday.2'), IexaI18n.t('sched.weekday.3'), IexaI18n.t('sched.weekday.4'), IexaI18n.t('sched.weekday.5'), IexaI18n.t('sched.weekday.6')];
const SCHEDULED_ICON = {
  clock: '<svg class="ui-icon" aria-hidden="true"><use href="#ui-clock"/></svg>',
  play: '<svg class="ui-icon" aria-hidden="true"><use href="#ui-play"/></svg>',
  edit: '<svg class="ui-icon" aria-hidden="true"><use href="#ui-edit"/></svg>',
  trash: '<svg class="ui-icon" aria-hidden="true"><use href="#ui-trash"/></svg>',
  repeat: '<svg class="ui-icon" aria-hidden="true"><use href="#ui-repeat"/></svg>',
};

function scheduledEl(id) {
  return document.getElementById(id);
}

/** Announce a result to assistive tech without moving focus. */
function scheduledAnnounce(message) {
  const live = scheduledEl('scheduledLive');
  if (!live) return;
  live.textContent = '';
  window.setTimeout(() => { live.textContent = message; }, 30);
}

function scheduledTimeLabel(ms) {
  const date = new Date(Number(ms) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function scheduledDayStart(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "今天 09:00" / "明天 09:00" / "周四 09:00" / "4 月 2 日 09:00". */
function formatScheduledRun(ms, now = Date.now()) {
  if (!Number.isFinite(Number(ms))) return IexaI18n.t('sched.unscheduled');
  const deltaDays = Math.round((scheduledDayStart(ms) - scheduledDayStart(now)) / 86400000);
  const clock = scheduledTimeLabel(ms);
  if (deltaDays === 0) return IexaI18n.t('sched.today') + ' ' + clock;
  if (deltaDays === 1) return IexaI18n.t('sched.tomorrow') + ' ' + clock;
  if (deltaDays > 1 && deltaDays < 7) return IexaI18n.t('sched.weekday.' + new Date(ms).getDay()) + ' ' + clock;
  const date = new Date(ms);
  return IexaI18n.t('sched.dateMd', { month: date.getMonth() + 1, day: date.getDate() }) + ' ' + clock;
}

function formatScheduledDistance(ms, now = Date.now()) {
  const diff = Number(ms) - now;
  if (!Number.isFinite(diff)) return '';
  if (diff <= 0) return IexaI18n.t('sched.dueNow');
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return IexaI18n.t('sched.underMinute');
  if (minutes < 60) return IexaI18n.t('sched.inMinutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return IexaI18n.t('sched.inHours', { count: hours });
  return IexaI18n.t('sched.inDays', { count: Math.round(hours / 24) });
}

function scheduledScheduleLabel(schedule) {
  if (!schedule) return '';
  if (schedule.frequency === 'weekly') return IexaI18n.t('sched.weekly', { weekday: IexaI18n.t('sched.weekday.' + (schedule.weekday ?? 0)), time: schedule.time });
  if (schedule.frequency === 'monthly') return IexaI18n.t('sched.monthly', { day: schedule.dayOfMonth ?? 1, time: schedule.time });
  return IexaI18n.t('sched.daily', { time: schedule.time });
}

/** Mirror of the server's wall-clock math, used only for the live preview. */
function scheduledNextRun(schedule, after) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(schedule?.time || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const base = new Date(after);
  const stamp = (year, month, day) => new Date(year, month, day, hour, minute, 0, 0).getTime();
  if (schedule.frequency === 'weekly') {
    const target = Number.isInteger(schedule.weekday) ? schedule.weekday : base.getDay();
    const delta = (target - base.getDay() + 7) % 7;
    let next = stamp(base.getFullYear(), base.getMonth(), base.getDate() + delta);
    if (next <= after) next = stamp(base.getFullYear(), base.getMonth(), base.getDate() + delta + 7);
    return next;
  }
  if (schedule.frequency === 'monthly') {
    const wanted = Math.min(31, Math.max(1, Number(schedule.dayOfMonth) || 1));
    const monthDay = (year, month) => Math.min(wanted, new Date(year, month + 1, 0).getDate());
    let next = stamp(base.getFullYear(), base.getMonth(), monthDay(base.getFullYear(), base.getMonth()));
    if (next <= after) {
      const index = base.getMonth() + 1;
      const year = base.getFullYear() + Math.floor(index / 12);
      const month = index % 12;
      next = stamp(year, month, monthDay(year, month));
    }
    return next;
  }
  let next = stamp(base.getFullYear(), base.getMonth(), base.getDate());
  if (next <= after) next = stamp(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  return next;
}

function scheduledStatusOf(task) {
  if (!task.enabled) return { tone: 'off', text: IexaI18n.t('sched.status.off') };
  if (task.lastStatus === 'error') return { tone: 'error', text: IexaI18n.t('sched.status.error') };
  if (task.lastStatus === 'missed') return { tone: 'warn', text: IexaI18n.t('sched.status.missed') };
  return { tone: 'on', text: IexaI18n.t('sched.status.on') };
}

function scheduledLastLabel(task) {
  if (!task.lastRunAt) return IexaI18n.t('sched.neverRun');
  const when = formatScheduledRun(task.lastRunAt);
  if (task.lastStatus === 'error') return IexaI18n.t('sched.lastError', { when, error: task.lastError || IexaI18n.t('sched.failed') });
  if (task.lastStatus === 'missed') return IexaI18n.t('sched.lastMissed', { when });
  return IexaI18n.t('sched.lastDone', { when });
}

function updateScheduledBadge() {
  const badge = scheduledEl('navScheduledBadge');
  if (!badge) return;
  const active = scheduledTasksCache.filter((task) => task.enabled).length;
  const next = String(active);
  if (badge.textContent !== next) badge.textContent = next;
  if (badge.hidden !== (active === 0)) badge.hidden = active === 0;
}

function refreshScheduledBadge() {
  const badge = scheduledEl('navScheduledBadge');
  if (!badge) return;
  // Cheap: the badge only needs the count, not the decorated rows.
  fetch(`${API_BASE}/api/scheduled-tasks`)
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data) return;
      scheduledTasksCache = data.tasks || [];
      updateScheduledBadge();
    })
    .catch(() => { /* a badge is not worth an error toast */ });
}

async function loadScheduledTasks() {
  try {
    const response = await fetch(`${API_BASE}/api/scheduled-tasks`);
    if (!response.ok) throw new Error(IexaI18n.t('sched.serviceStatus', { status: response.status }));
    const data = await response.json();
    scheduledTasksCache = Array.isArray(data.tasks) ? data.tasks : [];
    scheduledTimezone = String(data.timezone || '');
    scheduledTasksLoaded = true;
    scheduledTasksError = '';
  } catch (error) {
    scheduledTasksError = error?.message || IexaI18n.t('sched.noService');
  }
  renderScheduledTasks();
  updateScheduledBadge();
}

function scheduledCardMarkup(task) {
  const status = scheduledStatusOf(task);
  const prompt = String(task.prompt || '').trim();
  const titleText = String(task.title || '').trim();
  const nextRun = task.enabled && task.nextRunAt
    ? `<span class="scheduled-next"><strong>${IexaI18n.t('sched.next')}</strong> ${escapeHtml(formatScheduledRun(task.nextRunAt))}<em>${escapeHtml(formatScheduledDistance(task.nextRunAt))}</em></span>`
    : '<span class="scheduled-next is-off">' + IexaI18n.t('sched.pausedNoRun') + '</span>';
  // A named task shows its prompt; an unnamed one already uses the prompt as
  // the heading, so the body carries only the part the heading could not show.
  const remainder = task.customTitle
    ? prompt
    : (prompt.startsWith(titleText) ? prompt.slice(titleText.length).replace(/^[\s，。；、,:：]+/, '') : prompt);
  const body = task.customTitle ? remainder : (remainder ? `…${remainder}` : '');
  const showPrompt = body.length >= 8 && body !== titleText;
  const longPrompt = showPrompt && body.length > 140;
  return `
    <article class="scheduled-card${task.enabled ? '' : ' is-off'}${status.tone === 'error' ? ' has-error' : ''}" data-id="${escapeHtml(task.id)}">
      <div class="scheduled-card-top">
        <span class="scheduled-card-mark" aria-hidden="true">${SCHEDULED_ICON.clock}</span>
        <div class="scheduled-card-main">
          <div class="scheduled-card-title-row">
            <h3 class="scheduled-card-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</h3>
            <span class="scheduled-state is-${status.tone}"><i aria-hidden="true"></i>${status.text}</span>
          </div>
          ${showPrompt ? `<p class="scheduled-card-prompt${longPrompt ? ' is-clamped' : ''}">${escapeHtml(body)}</p>` : ''}
          ${longPrompt ? '<button type="button" class="scheduled-prompt-toggle" data-action="expand" aria-expanded="false">' + IexaI18n.t('sched.expandPrompt') + '</button>' : ''}
        </div>
        <button type="button" class="scheduled-switch" role="switch" aria-checked="${task.enabled ? 'true' : 'false'}"
          aria-label="${task.enabled ? IexaI18n.t('sched.pauseTask') : IexaI18n.t('sched.enableTask')}" data-action="toggle">
          <span class="scheduled-switch-knob"></span>
        </button>
      </div>
      <div class="scheduled-card-chips">
        <span class="scheduled-chip is-accent">${SCHEDULED_ICON.repeat}${escapeHtml(task.scheduleLabel || scheduledScheduleLabel(task.schedule))}</span>
        <span class="scheduled-chip${task.profileMissing ? ' is-warning' : ''}">${escapeHtml(task.profileLabel || IexaI18n.t('sched.noModel'))}</span>
        <span class="scheduled-chip">${task.sessionMode === 'existing' ? IexaI18n.t('sched.sessionPrefix') + escapeHtml(task.sessionTitle || IexaI18n.t('sched.removed')) : IexaI18n.t('sched.newSessionEach')}</span>
      </div>
      <div class="scheduled-card-foot">
        ${nextRun}
        <span class="scheduled-last" title="${escapeHtml(task.lastError || '')}">${escapeHtml(scheduledLastLabel(task))}</span>
        <div class="scheduled-card-actions">
          <button type="button" class="scheduled-action" data-action="run" title="${IexaI18n.t('sched.runNow')}" aria-label="${IexaI18n.t('sched.runNow')}">${SCHEDULED_ICON.play}</button>
          <button type="button" class="scheduled-action" data-action="edit" title="${IexaI18n.t('sched.edit')}" aria-label="${IexaI18n.t('sched.edit')}">${SCHEDULED_ICON.edit}</button>
          <button type="button" class="scheduled-action is-danger" data-action="delete" title="${IexaI18n.t('sched.delete')}" aria-label="${IexaI18n.t('sched.delete')}">${SCHEDULED_ICON.trash}</button>
        </div>
      </div>
    </article>`;
}

function renderScheduledTasks() {
  const list = scheduledEl('scheduledList');
  if (!list) return;
  // A rebuild replaces the focused control; put the keyboard back where it was
  // so toggling a switch with Space does not drop focus to the document.
  const active = document.activeElement;
  const focusedCard = active?.closest?.('.scheduled-card');
  const focusMemo = focusedCard && active.dataset?.action
    ? { id: focusedCard.dataset.id, action: active.dataset.action }
    : null;
  updateScheduledBadge();
  const summary = scheduledEl('scheduledSummary');
  const sub = document.querySelector('.scheduled-sub');
  if (sub && scheduledTimezone) {
    const text = IexaI18n.t('sched.subtitle', { timezone: scheduledTimezone });
    if (sub.textContent !== text) sub.textContent = text;
  }

  if (!scheduledTasksLoaded && !scheduledTasksCache.length) {
    list.innerHTML = '<div class="scheduled-loading">' + IexaI18n.t('sched.loading') + '</div>';
    if (summary) summary.hidden = true;
    return;
  }

  if (scheduledTasksError) {
    list.innerHTML = `<div class="scheduled-error-state"><strong>${IexaI18n.t('sched.loadFailed')}</strong><span>${escapeHtml(scheduledTasksError)}</span><button type="button" class="btn-secondary btn-sm" data-action="retry">${IexaI18n.t('sched.reconnect')}</button></div>`;
    if (summary) summary.hidden = true;
    return;
  }

  if (!scheduledTasksCache.length) {
    if (summary) summary.hidden = true;
    list.innerHTML = `
      <div class="scheduled-empty">
        <div class="scheduled-empty-mark" aria-hidden="true"><span class="scheduled-empty-ring"></span>${SCHEDULED_ICON.clock}</div>
        <h3>${IexaI18n.t('sched.emptyTitle')}</h3>
        <p>${IexaI18n.t('sched.emptyBody')}</p>
        <button type="button" class="scheduled-new-btn is-primary" data-action="create">
          <svg class="ui-icon" aria-hidden="true"><use href="#ui-plus"/></svg><span>${IexaI18n.t('sched.newTask')}</span>
        </button>
      </div>`;
    return;
  } else {
    list.innerHTML = scheduledTasksCache.map(scheduledCardMarkup).join('');
  }

  if (summary) {
    const activeTasks = scheduledTasksCache.filter((task) => task.enabled);
    const next = activeTasks
      .map((task) => Number(task.nextRunAt) || 0)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)[0];
    summary.hidden = false;
    summary.innerHTML = `<span><strong>${activeTasks.length}</strong> ${IexaI18n.t('sched.enabledCount')}</span>` +
      (next ? `<span class="scheduled-summary-next">${IexaI18n.t('sched.nextRun')} ${escapeHtml(formatScheduledRun(next))}</span>` : '');
  }

  if (focusMemo) {
    const selector = `.scheduled-card[data-id="${CSS.escape(focusMemo.id)}"] [data-action="${focusMemo.action}"]`;
    list.querySelector(selector)?.focus({ preventScroll: true });
  }
}

function scheduledById(id) {
  return scheduledTasksCache.find((task) => task.id === id);
}

async function toggleScheduledTask(task, enabled) {
  try {
    const response = await fetch(`${API_BASE}/api/scheduled-tasks/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || IexaI18n.t('sched.serviceStatus', { status: response.status }));
    const index = scheduledTasksCache.findIndex((item) => item.id === task.id);
    if (index >= 0) scheduledTasksCache[index] = data.task;
    renderScheduledTasks();
    updateScheduledBadge();
    scheduledAnnounce(IexaI18n.t(enabled ? 'sched.announceOn' : 'sched.announceOff', { title: task.title }));
  } catch (error) {
    await window.IexaDialogs.alert(IexaI18n.t('sched.updateFailed', { error: error?.message || error }));
    await loadScheduledTasks();
  }
}

async function runScheduledTaskNow(task, button) {
  if (scheduledRunning.has(task.id)) return;
  scheduledRunning.add(task.id);
  button?.classList.add('is-running');
  button?.setAttribute('disabled', '');
  try {
    const response = await fetch(`${API_BASE}/api/scheduled-tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || IexaI18n.t('sched.serviceStatus', { status: response.status }));
    const index = scheduledTasksCache.findIndex((item) => item.id === task.id);
    if (index >= 0) scheduledTasksCache[index] = data.task;
    renderScheduledTasks();
    const sessionId = data.task?.lastSessionId;
    scheduledAnnounce(IexaI18n.t('sched.runDone', { title: task.title }));
    if (sessionId && typeof showSession === 'function') {
      // The run already persisted a conversation; jump to it so the result is
      // visible instead of silently completing in the background.
      await showSession(sessionId);
      document.querySelector('.nav-btn[data-view="chat"]')?.click();
    }
  } catch (error) {
    await window.IexaDialogs.alert(IexaI18n.t('sched.runFailed', { error: error?.message || error }));
    await loadScheduledTasks();
  } finally {
    scheduledRunning.delete(task.id);
    button?.classList.remove('is-running');
    button?.removeAttribute('disabled');
  }
}

async function deleteScheduledTask(task) {
  const ok = await window.IexaDialogs.confirm(IexaI18n.t('sched.deleteConfirm', { title: task.title }));
  if (!ok) return;
  try {
    const response = await fetch(`${API_BASE}/api/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || IexaI18n.t('sched.serviceStatus', { status: response.status }));
    }
    scheduledTasksCache = scheduledTasksCache.filter((item) => item.id !== task.id);
    renderScheduledTasks();
    updateScheduledBadge();
    scheduledAnnounce(IexaI18n.t('sched.deleted', { title: task.title }));
  } catch (error) {
    await window.IexaDialogs.alert(IexaI18n.t('sched.deleteFailed', { error: error?.message || error }));
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function scheduledFillOptions() {
  const model = scheduledEl('scheduledModel');
  if (model) {
    const profiles = Array.isArray(profilesCache) ? profilesCache : [];
    model.textContent = '';
    for (const profile of profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name ? `${profile.name} · ${profile.model}` : profile.model;
      model.appendChild(option);
    }
    if (!profiles.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = IexaI18n.t('sched.noProfiles');
      model.appendChild(option);
    }
  }

  const session = scheduledEl('scheduledSession');
  if (session) {
    const selected = session.value;
    session.textContent = '';
    const sessions = (Array.isArray(sessionsCache) ? sessionsCache : [])
      .filter((item) => item && !item.archived)
      .slice()
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    for (const item of sessions) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title || IexaI18n.t('sched.untitledSession');
      session.appendChild(option);
    }
    if (!sessions.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = IexaI18n.t('sched.noSessions');
      session.appendChild(option);
    }
    if (selected && sessions.some((item) => item.id === selected)) session.value = selected;
  }

  const day = scheduledEl('scheduledDay');
  if (day && !day.options.length) {
    for (let value = 1; value <= 31; value += 1) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = IexaI18n.t('sched.dayOption', { value });
      day.appendChild(option);
    }
  }
}

function scheduledSyncEditorVisibility() {
  const weekdayRow = scheduledEl('scheduledWeekdayRow');
  const dayRow = scheduledEl('scheduledDayRow');
  const sessionField = scheduledEl('scheduledSessionField');
  if (weekdayRow) weekdayRow.hidden = scheduledDraftFrequency !== 'weekly';
  if (dayRow) dayRow.hidden = scheduledDraftFrequency !== 'monthly';
  if (sessionField) sessionField.hidden = scheduledDraftTarget !== 'existing';
  for (const button of document.querySelectorAll('#scheduledFrequency button')) {
    button.classList.toggle('is-active', button.dataset.freq === scheduledDraftFrequency);
    button.setAttribute('aria-pressed', String(button.dataset.freq === scheduledDraftFrequency));
  }
  for (const button of document.querySelectorAll('#scheduledTarget button')) {
    button.classList.toggle('is-active', button.dataset.target === scheduledDraftTarget);
    button.setAttribute('aria-pressed', String(button.dataset.target === scheduledDraftTarget));
  }
  scheduledUpdatePreview();
}

function scheduledCurrentSchedule() {
  const time = String(scheduledEl('scheduledTime')?.value || '09:00');
  if (scheduledDraftFrequency === 'weekly') {
    return { frequency: 'weekly', time, weekday: Number(scheduledEl('scheduledWeekday')?.value || 1) };
  }
  if (scheduledDraftFrequency === 'monthly') {
    return { frequency: 'monthly', time, dayOfMonth: Number(scheduledEl('scheduledDay')?.value || 1) };
  }
  return { frequency: 'daily', time };
}

function scheduledUpdatePreview() {
  const preview = scheduledEl('scheduledPreview');
  if (!preview) return;
  const schedule = scheduledCurrentSchedule();
  const next = scheduledNextRun(schedule, Date.now());
  const label = scheduledScheduleLabel(schedule);
  const when = scheduledEditorTask ? IexaI18n.t('sched.next') : IexaI18n.t('sched.first');
  preview.textContent = next
    ? `${label} · ${when} ${formatScheduledRun(next)}（${formatScheduledDistance(next)}）`
    : label;
  const counter = scheduledEl('scheduledPromptCount');
  const prompt = scheduledEl('scheduledPrompt');
  if (counter && prompt) counter.textContent = IexaI18n.t('sched.charCount', { count: prompt.value.length });
}

async function openScheduledEditor(task = null) {
  const profiles = Array.isArray(profilesCache) ? profilesCache : [];
  if (!task && !profiles.length) {
    await window.IexaDialogs.alert(IexaI18n.t('sched.needModelFirst'));
    return;
  }
  scheduledFillOptions();
  scheduledEditorReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  scheduledEditorTask = task;
  scheduledDraftFrequency = task?.schedule?.frequency || 'daily';
  scheduledDraftTarget = task?.sessionMode === 'existing' ? 'existing' : 'new';

  const title = scheduledEl('scheduledEditorTitle');
  if (title) title.textContent = task ? IexaI18n.t('sched.editorEdit') : IexaI18n.t('sched.newTask');
  const sub = scheduledEl('scheduledEditorSub');
  if (sub) sub.textContent = task ? IexaI18n.t('sched.editorEditHint') : IexaI18n.t('sched.editorNewHint');
  const save = scheduledEl('scheduledSave');
  if (save) save.textContent = task ? IexaI18n.t('sched.saveEdit') : IexaI18n.t('sched.saveNew');
  const prompt = scheduledEl('scheduledPrompt');
  if (prompt) prompt.value = task?.prompt || '';
  const name = scheduledEl('scheduledTitle');
  if (name) name.value = task?.customTitle ? task.title : '';
  const time = scheduledEl('scheduledTime');
  if (time) time.value = task?.schedule?.time || '09:00';
  const weekday = scheduledEl('scheduledWeekday');
  if (weekday) weekday.value = String(task?.schedule?.weekday ?? 1);
  const day = scheduledEl('scheduledDay');
  if (day) day.value = String(task?.schedule?.dayOfMonth ?? 1);

  const model = scheduledEl('scheduledModel');
  if (model) {
    const preferred = task?.profileId
      || (Array.isArray(profilesCache) ? (profilesCache.find((item) => item.id === activeProfileId)?.id || profilesCache[0]?.id) : '');
    if (preferred) model.value = preferred;
  }
  const session = scheduledEl('scheduledSession');
  if (session) {
    if (task?.sessionId) session.value = task.sessionId;
    else if (!session.value && session.options.length) session.selectedIndex = 0;
  }

  const error = scheduledEl('scheduledError');
  if (error) { error.hidden = true; error.textContent = ''; }

  const overlay = scheduledEl('scheduledEditor');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.classList.add('is-scheduled-editor-open');
  scheduledSyncEditorVisibility();
  requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    prompt?.focus();
  });
}

function closeScheduledEditor() {
  const overlay = scheduledEl('scheduledEditor');
  if (!overlay || overlay.hidden) return;
  overlay.classList.remove('is-open');
  document.body.classList.remove('is-scheduled-editor-open');
  window.setTimeout(() => {
    if (!overlay.classList.contains('is-open')) overlay.hidden = true;
    if (scheduledEditorReturnFocus?.isConnected) scheduledEditorReturnFocus.focus({ preventScroll: true });
    scheduledEditorReturnFocus = null;
  }, 180);
  scheduledEditorTask = null;
}

/** Tab must not walk out of a modal dialog into the page behind it. */
function scheduledFocusables() {
  return Array.from(document.querySelectorAll(
    '#scheduledEditor button, #scheduledEditor input, #scheduledEditor select, #scheduledEditor textarea',
  )).filter((element) => !element.disabled && element.offsetParent !== null && !element.closest('[hidden]'));
}

async function saveScheduledTask(event) {
  event?.preventDefault();
  const error = scheduledEl('scheduledError');
  const showError = (message) => {
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  };
  const prompt = String(scheduledEl('scheduledPrompt')?.value || '').trim();
  if (!prompt) { showError(IexaI18n.t('sched.errPrompt')); scheduledEl('scheduledPrompt')?.focus(); return; }
  const profileId = String(scheduledEl('scheduledModel')?.value || '');
  if (!profileId) { showError(IexaI18n.t('sched.errModel')); return; }
  const sessionId = scheduledDraftTarget === 'existing' ? String(scheduledEl('scheduledSession')?.value || '') : '';
  if (scheduledDraftTarget === 'existing' && !sessionId) { showError(IexaI18n.t('sched.errSession')); return; }
  const time = String(scheduledEl('scheduledTime')?.value || '');
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) { showError(IexaI18n.t('sched.errTime')); return; }

  const payload = {
    title: String(scheduledEl('scheduledTitle')?.value || '').trim() || undefined,
    prompt,
    profileId,
    sessionMode: scheduledDraftTarget,
    sessionId: sessionId || undefined,
    schedule: scheduledCurrentSchedule(),
    enabled: scheduledEditorTask ? scheduledEditorTask.enabled !== false : true,
  };
  const save = scheduledEl('scheduledSave');
  if (save) { save.disabled = true; save.classList.add('is-busy'); }
  try {
    const editing = scheduledEditorTask;
    const response = await fetch(
      editing ? `${API_BASE}/api/scheduled-tasks/${encodeURIComponent(editing.id)}` : `${API_BASE}/api/scheduled-tasks`,
      {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || IexaI18n.t('sched.serviceStatus', { status: response.status }));
    if (editing) {
      const index = scheduledTasksCache.findIndex((item) => item.id === editing.id);
      if (index >= 0) scheduledTasksCache[index] = data.task;
    } else {
      scheduledTasksCache.unshift(data.task);
    }
    scheduledTasksLoaded = true;
    closeScheduledEditor();
    renderScheduledTasks();
    updateScheduledBadge();
    scheduledAnnounce(IexaI18n.t('sched.saved', { title: data.task?.title || IexaI18n.t('sched.taskFallback') }));
  } catch (thrown) {
    showError(thrown?.message || IexaI18n.t('sched.saveFailed'));
  } finally {
    if (save) { save.disabled = false; save.classList.remove('is-busy'); }
  }
}

function initScheduledTasks() {
  const list = scheduledEl('scheduledList');
  list?.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'create') { openScheduledEditor(); return; }
    if (action === 'retry') { await loadScheduledTasks(); return; }
    const card = event.target.closest('.scheduled-card');
    const task = card && scheduledById(card.dataset.id);
    if (!task) return;
    if (action === 'toggle') { await toggleScheduledTask(task, !task.enabled); return; }
    if (action === 'run') { await runScheduledTaskNow(task, event.target.closest('[data-action="run"]')); return; }
    if (action === 'edit') { openScheduledEditor(task); return; }
    if (action === 'delete') { await deleteScheduledTask(task); return; }
    if (action === 'expand') {
      const button = event.target.closest('[data-action="expand"]');
      const prompt = card.querySelector('.scheduled-card-prompt');
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      button.textContent = expanded ? IexaI18n.t('sched.expandPrompt') : IexaI18n.t('sched.collapsePrompt');
      prompt?.classList.toggle('is-clamped', expanded);
    }
  });

  scheduledEl('scheduledNewBtn')?.addEventListener('click', () => openScheduledEditor());
  scheduledEl('scheduledEditorClose')?.addEventListener('click', closeScheduledEditor);
  scheduledEl('scheduledCancel')?.addEventListener('click', closeScheduledEditor);
  scheduledEl('scheduledForm')?.addEventListener('submit', saveScheduledTask);
  scheduledEl('scheduledEditor')?.addEventListener('click', (event) => {
    if (event.target === scheduledEl('scheduledEditor')) closeScheduledEditor();
  });
  scheduledEl('scheduledPrompt')?.addEventListener('input', scheduledUpdatePreview);
  scheduledEl('scheduledTime')?.addEventListener('input', scheduledUpdatePreview);
  scheduledEl('scheduledWeekday')?.addEventListener('change', scheduledUpdatePreview);
  scheduledEl('scheduledDay')?.addEventListener('change', scheduledUpdatePreview);
  scheduledEl('scheduledFrequency')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-freq]');
    if (!button) return;
    scheduledDraftFrequency = button.dataset.freq;
    scheduledSyncEditorVisibility();
  });
  scheduledEl('scheduledTarget')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-target]');
    if (!button) return;
    scheduledDraftTarget = button.dataset.target;
    scheduledSyncEditorVisibility();
  });
  document.addEventListener('keydown', (event) => {
    const overlay = scheduledEl('scheduledEditor');
    if (!overlay?.classList.contains('is-open')) return;
    if (event.key === 'Escape') {
      closeScheduledEditor();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = scheduledFocusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
