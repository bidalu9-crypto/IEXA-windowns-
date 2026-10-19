// =============================================================================
// Background task center
//
// Compact expandable job rows with node reuse, a shape fingerprint to skip
// identical repaints, and retention controls.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
let jobsCache = [];
let jobsFilter = 'current';
let jobsRefreshTimer = null;
let jobsLoadError = '';
const jobsExpanded = new Set();
const jobCardNodes = new Map();
let jobCardSequence = 0;
let jobsRenderShape = 'idle';
const JOB_LIVE_STATUSES = ['queued', 'awaiting_approval', 'running', 'cancelling'];
const JOB_CHEVRON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function jobStatusText(status) {
  return ({ queued: '等待中', awaiting_approval: '等待批准', running: '运行中', cancelling: '正在停止', completed: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消', timed_out: '超时' })[status] || '未知';
}
function jobTime(value) {
  const date = Number(value) ? new Date(Number(value)) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}
function jobsViewActive() {
  return !!document.getElementById('view-jobs')?.classList.contains('active');
}
function jobCardShape(job, sessionTitles) {
  return [job.status, job.title || '', job.toolName || '', job.kind || '',
    job.startedAt || 0, job.finishedAt || 0, job.outputPreview || '',
    sessionTitles.get(job.sessionId) || job.sessionId || ''].join('\u0001');
}
function jobEl(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function setJobText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
function createJobCard(job) {
  jobCardSequence += 1;
  const root = jobEl('article', 'job-card');
  root.dataset.jobId = job.id;
  const row = jobEl('button', 'job-row');
  row.type = 'button';
  const bodyId = `job-body-${jobCardSequence}`;
  const expanded = jobsExpanded.has(job.id);
  row.setAttribute('aria-expanded', String(expanded));
  row.setAttribute('aria-controls', bodyId);
  const dot = jobEl('span', 'job-status-dot');
  dot.setAttribute('aria-hidden', 'true');
  const chevron = jobEl('span', 'job-row-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = JOB_CHEVRON_SVG;
  const entry = {
    root, row, chevron, shape: '',
    title: jobEl('span', 'job-row-title'),
    tool: jobEl('span', 'job-row-tool'),
    time: jobEl('time', 'job-row-time'),
    status: jobEl('span', 'job-status'),
  };
  row.append(dot, entry.title, entry.tool, entry.time, entry.status, chevron);
  const body = jobEl('div', 'job-body');
  body.id = bodyId;
  body.hidden = !expanded;
  const meta = jobEl('div', 'job-body-meta');
  entry.metaKind = jobEl('span');
  entry.metaSession = jobEl('span');
  meta.append(entry.metaKind, entry.metaSession);
  entry.output = jobEl('pre', 'job-output');
  entry.output.hidden = true;
  body.append(meta, entry.output);
  root.append(row, body);
  entry.body = body;
  return entry;
}
function updateJobCard(entry, job, sessionTitles) {
  const shape = jobCardShape(job, sessionTitles);
  if (entry.shape === shape) return;
  entry.shape = shape;
  const classes = `job-card is-${job.status} is-${job.kind === 'turn' ? 'turn' : 'tool'}`;
  if (entry.root.className !== classes) entry.root.className = classes;
  const title = job.title || (job.kind === 'turn' ? 'AI 回复' : job.toolName || '工具任务');
  setJobText(entry.title, title);
  if (entry.title.title !== title) entry.title.title = title;
  const kind = job.kind === 'turn' ? 'AI 回合' : (job.toolName || '工具');
  setJobText(entry.tool, kind);
  setJobText(entry.metaKind, kind);
  setJobText(entry.time, jobTime(job.startedAt || job.createdAt));
  setJobText(entry.status, jobStatusText(job.status));
  const session = (sessionTitles.get(job.sessionId) || job.sessionId || '').slice(0, 32);
  setJobText(entry.metaSession, `会话 ${session}`);
  const output = job.outputPreview || '';
  setJobText(entry.output, output);
  if (entry.output.hidden !== !output) entry.output.hidden = !output;
}
function updateJobsBadge() {
  const badge = document.getElementById('navJobBadge');
  if (!badge) return;
  const runningCount = jobsCache.filter((job) => JOB_LIVE_STATUSES.includes(job.status)).length;
  const next = String(runningCount);
  if (badge.textContent !== next) badge.textContent = next;
  if (badge.hidden !== (runningCount === 0)) badge.hidden = runningCount === 0;
}
function renderJobs() {
  updateJobsBadge();
  const list = document.getElementById('jobsList');
  if (!list) return;
  // A hidden view has no layout; touching it would cost a style pass for
  // pixels nobody can see. The cache keeps the data, activation paints it.
  if (!jobsViewActive()) return;
  const visible = jobsFilter === 'current'
    ? jobsCache.filter((job) => job.sessionId === currentSessionId)
    : jobsCache.slice();
  const shape = jobsLoadError ? 'error' : (visible.length ? 'list' : 'empty');
  if (shape !== 'list') {
    if (jobsRenderShape === shape) return;
    jobsRenderShape = shape;
    jobCardNodes.clear();
    list.textContent = '';
    if (shape === 'error') {
      list.innerHTML = `<div class="jobs-load-error"><strong>任务中心暂时无法加载</strong><span>${escapeHtml(jobsLoadError)}</span><button type="button" class="btn-secondary btn-sm" data-jobs-retry>重新连接</button></div>`;
      list.querySelector('[data-jobs-retry]')?.addEventListener('click', loadJobs);
    } else {
      list.innerHTML = '<div class="profile-empty">当前还没有任务。发送消息后会先创建一条 AI 处理任务；调用工具时会额外显示工具子任务。</div>';
    }
    return;
  }
  if (jobsRenderShape !== 'list') {
    jobsRenderShape = 'list';
    jobCardNodes.clear();
    list.textContent = '';
  }
  const sessionTitles = new Map(sessionsCache.map((item) => [item.id, item.title]));
  // Keyed reconciliation: reuse the card for a job id, mutate only the fields
  // that actually changed. Order is repaired in one pass, so a steady poll
  // touches no DOM at all.
  let cursor = list.firstElementChild;
  const live = new Set();
  for (const job of visible) {
    live.add(job.id);
    let entry = jobCardNodes.get(job.id);
    if (!entry) {
      entry = createJobCard(job);
      jobCardNodes.set(job.id, entry);
    }
    updateJobCard(entry, job, sessionTitles);
    if (entry.root === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(entry.root, cursor);
  }
  for (const node of Array.from(list.children)) {
    if (live.has(node.dataset.jobId)) continue;
    jobCardNodes.delete(node.dataset.jobId);
    // Drop the expansion flag with the card, or purged jobs keep a Set entry
    // alive for the rest of the process.
    jobsExpanded.delete(node.dataset.jobId);
    node.remove();
  }
}

function renderJobsRetentionHint(retention) {
  const hint = document.getElementById('jobsRetentionHint');
  if (!hint || !retention) return;
  const days = Number(retention.days) || 0;
  const perSession = Number(retention.perSession) || 0;
  const text = days > 0 && perSession > 0
    ? `工具执行按会话独立记录。已结束的记录自动保留 ${days} 天、每个会话最多 ${perSession} 条，更早的会自动清理。`
    : '工具执行按会话独立记录。';
  if (hint.textContent !== text) hint.textContent = text;
}

async function clearJobsHistory() {
  // The purge follows the visible filter: clearing "当前会话" must not silently
  // wipe every other conversation's audit trail.
  const allSessions = jobsFilter === 'all' || !currentSessionId;
  const scope = allSessions ? '全部会话' : '当前会话';
  if (!(await window.IexaDialogs.confirm(`清理${scope}中已结束的任务记录？正在运行的任务会保留，此操作不可撤销。`))) return;
  const button = document.getElementById('jobsClearBtn');
  if (button) button.disabled = true;
  try {
    const query = allSessions ? '' : `?sessionId=${encodeURIComponent(currentSessionId)}`;
    const response = await fetch(`${API_BASE}/api/jobs${query}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`服务返回 ${response.status}`);
    await loadJobs();
  } catch (error) {
    console.error('Failed to clear jobs:', error);
    await window.IexaDialogs.alert(`清理任务记录失败：${error?.message || error}`);
  } finally {
    if (button) button.disabled = false;
  }
}

// Persistent shells are a different kind of job: they stay alive across turns,
// so they get their own compact block instead of being mixed into the audit rows.
let shellSessionSignature = '';

async function loadShellSessions() {
  const host = document.getElementById('shellSessionList');
  if (!host) return;
  if (!currentSessionId) { host.hidden = true; host.innerHTML = ''; shellSessionSignature = ''; return; }
  try {
    const response = await fetch(`${API_BASE}/api/shell-sessions?sessionId=${encodeURIComponent(currentSessionId)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    renderShellSessions(Array.isArray(data.sessions) ? data.sessions : []);
  } catch {
    host.hidden = true;
  }
}

function renderShellSessions(sessions) {
  const host = document.getElementById('shellSessionList');
  if (!host) return;
  const signature = sessions.map((session) => `${session.id}:${session.running}`).join('|');
  // Polling every 2.5s must not rebuild rows that did not change.
  if (signature === shellSessionSignature) return;
  shellSessionSignature = signature;
  host.hidden = sessions.length === 0;
  host.innerHTML = '';
  if (!sessions.length) return;

  const title = document.createElement('div');
  title.className = 'shell-session-title';
  title.textContent = `持久终端 · ${sessions.length}`;
  host.appendChild(title);

  for (const session of sessions) {
    const row = document.createElement('div');
    row.className = `shell-session-row${session.running ? ' is-running' : ''}`;
    row.dataset.sessionId = session.id;

    const dot = document.createElement('span');
    dot.className = 'shell-session-dot';
    const id = document.createElement('code');
    id.className = 'shell-session-id';
    id.textContent = String(session.id).slice(0, 8);
    const meta = document.createElement('span');
    meta.className = 'shell-session-meta';
    meta.textContent = `${session.shell || 'shell'} · ${session.cwd || ''}`;
    const state = document.createElement('span');
    state.className = 'shell-session-state';
    state.textContent = session.running ? '运行中' : '已结束';
    row.append(dot, id, meta, state);

    if (session.running) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'shell-session-close';
      close.dataset.closeSession = session.id;
      close.title = '结束这个终端';
      close.setAttribute('aria-label', `结束终端 ${id.textContent}`);
      close.textContent = '结束';
      row.appendChild(close);
    }
    host.appendChild(row);
  }
}

async function closeShellSession(id) {
  if (!id || !currentSessionId) return;
  try {
    await fetch(`${API_BASE}/api/shell-sessions?sessionId=${encodeURIComponent(currentSessionId)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    console.error('Failed to close shell session:', error);
  } finally {
    shellSessionSignature = '';
    await loadShellSessions();
  }
}

async function loadJobs() {
  const list = document.getElementById('jobsList');
  try {
    const scope = jobsFilter === 'current' && currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : '';
    const response = await fetch(`${API_BASE}/api/jobs${scope}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('当前桌面窗口仍在使用旧后端。请结束正在运行的任务后，完全退出并重新打开 IEXA。');
      }
      throw new Error(data.error || `服务返回 ${response.status}`);
    }
    jobsCache = Array.isArray(data.jobs) ? data.jobs : [];
    jobsLoadError = '';
    renderJobsRetentionHint(data.retention);
    renderJobs();
  } catch (error) {
    jobsLoadError = error?.message || '无法连接本地 IEXA 服务。';
    console.error('Failed to load jobs:', error);
    if (list) renderJobs();
  }
}
function applyJobUpdate(job) {
  if (!job || !job.id) return;
  const index = jobsCache.findIndex((item) => item.id === job.id);
  if (index >= 0) jobsCache[index] = { ...jobsCache[index], ...job };
  else jobsCache.unshift(job);
  jobsLoadError = '';
  renderJobs();
}
function syncJobsPolling() {
  const active = jobsViewActive() && !document.hidden;
  if (active && !jobsRefreshTimer) {
    jobsRefreshTimer = window.setInterval(() => { loadJobs(); loadShellSessions(); }, 2500);
  }
  if (!active && jobsRefreshTimer) { window.clearInterval(jobsRefreshTimer); jobsRefreshTimer = null; }
}
function initJobsUI() {
  const refresh = document.getElementById('jobsRefreshBtn');
  if (refresh) refresh.addEventListener('click', loadJobs);
  const clear = document.getElementById('jobsClearBtn');
  if (clear) clear.addEventListener('click', clearJobsHistory);
  const filter = document.getElementById('jobsFilter');
  if (filter) filter.addEventListener('click', (event) => {
    const button = event.target.closest('[data-jobs-filter]');
    if (!button) return;
    jobsFilter = button.dataset.jobsFilter || 'current';
    filter.querySelectorAll('button').forEach((item) => item.classList.toggle('is-active', item === button));
    loadJobs();
  });
  // One delegated listener survives every re-render, so cards never carry
  // their own handlers and a reused card keeps its expanded state.
  document.getElementById('jobsList')?.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-session]');
    if (close) { closeShellSession(close.dataset.closeSession); return; }
    const row = event.target.closest('.job-row');
    if (!row) return;
    const card = row.closest('.job-card');
    const body = document.getElementById(row.getAttribute('aria-controls'));
    if (!card || !body) return;
    const open = row.getAttribute('aria-expanded') !== 'true';
    row.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    if (open) jobsExpanded.add(card.dataset.jobId);
    else jobsExpanded.delete(card.dataset.jobId);
  });
  document.addEventListener('visibilitychange', () => {
    syncJobsPolling();
    if (!document.hidden && jobsViewActive()) { renderJobs(); loadShellSessions(); }
  });
}

const PERMISSION_MODE_LABELS = {
  plan: '仅规划（只读）',
  ask: '请求批准',
  risk: '帮我批准',
  full: '完全访问权限',
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
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '权限模式保存失败');
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
