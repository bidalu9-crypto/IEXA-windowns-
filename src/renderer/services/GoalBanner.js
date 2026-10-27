// Goal banner — the visible half of the goal record the agent keeps outside
// the transcript. The server owns the record; this module only reads it and
// offers a clear button. Classic script: nothing runs on load.

let goalBannerRequest = 0;

async function refreshGoalBanner() {
  const bar = document.getElementById('goalBar');
  if (!bar) return;
  const sessionId = currentSessionId;
  if (!sessionId) { bar.hidden = true; return; }
  const request = ++goalBannerRequest;
  try {
    const response = await fetch(`${API_BASE}/api/goal?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    // A slow reply for the session we just left must not paint over the new one.
    if (request !== goalBannerRequest || sessionId !== currentSessionId) return;
    renderGoalBanner(data.goal);
  } catch {
    if (request === goalBannerRequest) bar.hidden = true;
  }
}

function renderGoalBanner(goal) {
  const bar = document.getElementById('goalBar');
  if (!bar) return;
  if (!goal || !goal.objective) {
    bar.hidden = true;
    bar.dataset.status = '';
    bar.removeAttribute('title');
    return;
  }
  const status = goal.status === 'done' ? IexaI18n.t('goal.status.done')
    : goal.status === 'blocked' ? IexaI18n.t('goal.status.blocked')
      : IexaI18n.t('goal.status.active');
  const notes = Array.isArray(goal.notes) ? goal.notes : [];
  document.getElementById('goalBarText').textContent = goal.objective;
  const noteCount = notes.length ? ' · ' + IexaI18n.t('goal.notes', { count: notes.length }) : '';
  document.getElementById('goalBarStatus').textContent = `${status}${noteCount}`;
  bar.dataset.status = goal.status || 'active';
  bar.title = [
    goal.objective,
    goal.doneWhen ? IexaI18n.t('goal.doneWhen', { value: goal.doneWhen }) : '',
    ...notes.slice(-3),
  ].filter(Boolean).join('\n');
  bar.hidden = false;
}

async function clearGoalFromBanner() {
  const sessionId = currentSessionId;
  const bar = document.getElementById('goalBar');
  if (!sessionId || !bar) return;
  bar.classList.add('is-clearing');
  try {
    await fetch(`${API_BASE}/api/goal?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    renderGoalBanner(null);
  } catch (error) {
    console.error('Failed to clear goal:', error);
  } finally {
    bar.classList.remove('is-clearing');
  }
}

function initGoalBanner() {
  document.getElementById('goalBarClear')?.addEventListener('click', clearGoalFromBanner);
}
