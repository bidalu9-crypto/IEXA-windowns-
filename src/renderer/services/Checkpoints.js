// Rewind checkpoints — split out of app.js.
// Checkpoint list, popover placement and rewind action.
//
// Classic script: top-level declarations join the same global scope as
// app.js, so callers keep working unchanged. Keep this file free of load-time
// side effects — it evaluates before app.js and before the DOM is ready.

let checkpointOpen = false;

function formatCheckpointTime(value) {
  const date = new Date(Number(value) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function renderCheckpoints() {
  const list = document.getElementById('checkpointList');
  if (!list) return;
  if (!currentSessionId) { list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.noSession'))}</div>`; return; }
  list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.loading'))}</div>`;
  try {
    const response = await fetch(`${API_BASE}/api/checkpoints?sessionId=${encodeURIComponent(currentSessionId)}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'load failed');
    const items = Array.isArray(data.checkpoints) ? data.checkpoints : [];
    if (!items.length) { list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.empty'))}</div>`; return; }
    list.innerHTML = items.map((item) => `
      <div class="checkpoint-row">
        <div class="checkpoint-meta">
          <span class="checkpoint-label" title="${escapeHtml(item.label || '')}">${escapeHtml(item.label || IexaI18n.t('checkpoint.unnamed'))}</span>
          <span class="checkpoint-sub">${formatCheckpointTime(item.createdAt)} · ${escapeHtml(IexaI18n.t('checkpoint.files', { count: Number(item.changeCount) || 0 }))}</span>
        </div>
        <button type="button" class="checkpoint-restore" data-ui-action="rewindCheckpoint" data-ui-arg="${escapeHtml(item.id)}">${escapeHtml(IexaI18n.t('checkpoint.restore'))}</button>
      </div>`).join('');
  } catch (error) {
    list.innerHTML = `<div class="checkpoint-empty">${escapeHtml(IexaI18n.t('checkpoint.loadFailed', { message: error.message || String(error) }))}</div>`;
  }
}

const CHECKPOINT_POPOVER_GAP = 10;

const CHECKPOINT_POPOVER_MARGIN = 8;

// The panel is fixed-positioned and clamped, so it can never be pushed off
// screen nor end up under the sidebar in a narrow window.
function positionCheckpointPopover() {
  const popover = document.getElementById('checkpointPopover');
  const button = document.getElementById('checkpointBtn');
  if (!popover || !button || popover.hidden) return;
  const anchor = button.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - CHECKPOINT_POPOVER_MARGIN * 2);
  popover.style.width = `${Math.round(width)}px`;
  const height = popover.offsetHeight;
  const left = Math.min(
    Math.max(CHECKPOINT_POPOVER_MARGIN, anchor.right - width),
    Math.max(CHECKPOINT_POPOVER_MARGIN, window.innerWidth - width - CHECKPOINT_POPOVER_MARGIN),
  );
  let top = anchor.top - height - CHECKPOINT_POPOVER_GAP;
  if (top < CHECKPOINT_POPOVER_MARGIN) {
    // Not enough room above the toolbar: open downwards instead, still clamped.
    top = Math.min(anchor.bottom + CHECKPOINT_POPOVER_GAP, window.innerHeight - height - CHECKPOINT_POPOVER_MARGIN);
  }
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(Math.max(CHECKPOINT_POPOVER_MARGIN, top))}px`;
}

function setCheckpointOpen(open) {
  checkpointOpen = open;
  const popover = document.getElementById('checkpointPopover');
  const button = document.getElementById('checkpointBtn');
  if (popover) {
    if (open && popover.parentElement !== document.body) {
      // Escape the composer's stacking context; see the CSS comment.
      document.body.appendChild(popover);
    }
    popover.hidden = !open;
    if (open) positionCheckpointPopover();
  }
  if (button) button.setAttribute('aria-expanded', String(open));
  // The list is fetched, so its final height is only known after it renders.
  if (open) renderCheckpoints().then(positionCheckpointPopover, () => {});
}

async function rewindCheckpoint(checkpointId) {
  if (!currentSessionId || !checkpointId) return;
  const confirmed = await IexaDialogs.confirm(IexaI18n.t('checkpoint.confirm'));
  if (!confirmed) return;
  try {
    const response = await fetch(`${API_BASE}/api/checkpoints/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, checkpointId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '回退失败');
    if (projectRoot) loadFilesList(filesCurrentPath, true);
    await renderCheckpoints();
  } catch (error) {
    addError(error.message || String(error));
  }
}
