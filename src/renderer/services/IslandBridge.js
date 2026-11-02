// =============================================================================
// Dynamic island bridge
//
// The chat window owns the meaning of a tool step; the island window only draws
// what it is told. This module is the one place that translates between them:
// it watches the transcript for tool rows, folds them into a six-entry snapshot
// and pushes that snapshot to the main process.
//
// Pushing is throttled and diffed. A streaming turn mutates the DOM on every
// token, and posting a snapshot per mutation would wake another process a few
// hundred times a second for a 6-row list.
// =============================================================================
(() => {
  'use strict';

  const MAX_STEPS = 6;
  const THROTTLE_MS = 320;

  const bridge = () => window.iexaDesktop || null;
  const available = () => Boolean(bridge() && typeof bridge().islandState === 'function');

  // Tool name → glyph. The island has its own tiny icon set; anything unknown
  // falls back to a terminal, which is the honest default for "a tool ran".
  function iconFor(name) {
    const n = String(name || '').toLowerCase();
    if (/shell|terminal|bash|cmd|exec/.test(n)) return 'terminal';
    if (/file|write|edit|read|patch|notebook/.test(n)) return 'file';
    if (/search|grep|glob|find|web|fetch/.test(n)) return 'search';
    if (/think|plan|todo|goal|reason/.test(n)) return 'brain';
    return 'terminal';
  }

  function statusOf(raw) {
    const s = String(raw || '').toLowerCase();
    if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') return 'error';
    if (s === 'running' || s === 'streaming' || s === 'queued' || s === 'awaiting-approval') return 'running';
    if (s === 'done' || s === 'completed' || s === 'success') return 'done';
    return 'pending';
  }

  function readSteps() {
    const host = document.getElementById('chatMessages');
    if (!host) return [];
    const rows = [...host.querySelectorAll('.tool-block[data-tool-name]')];
    return rows.slice(-MAX_STEPS).map((row) => {
      const nameEl = row.querySelector('.tool-name');
      const metaEl = row.querySelector('.tool-meta');
      const label = (nameEl ? nameEl.textContent : '').trim();
      const meta = (metaEl ? metaEl.textContent : '').trim();
      return {
        name: meta ? label + ' · ' + meta : label,
        icon: iconFor(row.dataset.toolName),
        status: statusOf(row.dataset.status),
      };
    });
  }

  function snapshot() {
    const steps = readSteps();
    const host = document.getElementById('chatMessages');
    const busy = steps.some((step) => step.status === 'running')
      || Boolean(host && host.querySelector('.message.assistant.is-streaming'));
    const failed = steps.some((step) => step.status === 'error');
    const last = steps[steps.length - 1];
    const state = busy ? 'running' : failed ? 'error' : steps.length ? 'done' : 'idle';
    const active = document.querySelector('.session-item.active .session-item-title');
    return {
      state,
      label: busy ? (last ? last.name : '正在执行') : state === 'error' ? '有步骤失败' : state === 'done' ? '本轮已完成' : '就绪',
      trailing: steps.length ? steps.length + ' 步' : '',
      icon: busy ? 'terminal' : state === 'error' ? 'error' : state === 'done' ? 'done' : 'idle',
      title: (active ? active.textContent : '').trim() || '最近步骤',
      steps,
    };
  }

  let timer = null;
  let pending = false;
  let lastSignature = '';

  function flush() {
    timer = null;
    if (!available()) return;
    const next = snapshot();
    const signature = JSON.stringify(next);
    // Skip repeats only: any real change in text or status produces a new
    // signature, so nothing the user would notice is collapsed away.
    if (signature === lastSignature) return;
    lastSignature = signature;
    try { bridge().islandState(next); } catch { /* window closing */ }
  }

  function schedule() {
    if (!available() || pending) return;
    pending = true;
    timer = setTimeout(() => { pending = false; flush(); }, THROTTLE_MS);
  }

  function observeTranscript() {
    const host = document.getElementById('chatMessages');
    if (!host) return false;
    if (host.dataset.islandObserved === '1') return true;
    host.dataset.islandObserved = '1';
    new MutationObserver(schedule).observe(host, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-status', 'class', 'data-tool-name'],
    });
    return true;
  }

  // ---- Appearance toggle ---------------------------------------------------
  // Built here rather than in index.html: the island is a desktop feature, and in
  // a browser tab `iexaDesktop` does not exist, so the row is never created.
  function buildToggle() {
    const grid = document.querySelector('#view-appearance .appearance-grid');
    if (!grid || grid.querySelector('.island-toggle-card') || !bridge()) return;
    const card = document.createElement('section');
    card.className = 'island-toggle-card';
    card.innerHTML = [
      '<div class="island-toggle-copy">',
      '  <h3 data-i18n="appearance.island">灵动岛</h3>',
      '  <p data-i18n="appearance.islandDesc">在桌面浮一个小胶囊，显示当前会话的工具进度，可拖动、点击展开最近 6 步。</p>',
      '</div>',
      '<label class="island-switch">',
      '  <input type="checkbox" id="islandEnabledToggle" role="switch">',
      '  <span class="island-switch-track" aria-hidden="true"></span>',
      '</label>',
    ].join('');
    grid.appendChild(card);

    const input = card.querySelector('#islandEnabledToggle');
    const sync = async () => {
      try {
        const status = await bridge().islandStatus();
        input.checked = Boolean(status && status.enabled);
      } catch { input.checked = false; }
    };
    input.addEventListener('change', async () => {
      const wanted = input.checked;
      input.disabled = true;
      try {
        const status = await bridge().islandSetEnabled(wanted);
        input.checked = Boolean(status && status.enabled);
        if (wanted) schedule();
      } catch { input.checked = !wanted; }
      finally { input.disabled = false; }
    });
    sync();
  }

  function init() {
    if (!available()) return;
    if (!observeTranscript()) {
      const retry = setInterval(() => {
        if (observeTranscript()) { clearInterval(retry); flush(); }
      }, 400);
      setTimeout(() => clearInterval(retry), 20000);
    }
    buildToggle();
    document.addEventListener('click', (event) => {
      if (event.target.closest('.nav-btn[data-view="appearance"]')) setTimeout(buildToggle, 60);
    });
    flush();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.IexaIslandBridge = Object.freeze({ snapshot, refresh: schedule });
})();
