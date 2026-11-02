/* The island is a tiny viewer: it renders whatever state the main window last
   pushed and never computes tool semantics itself. Expanding only resizes the
   window and swaps one section, so the pill never re-mounts mid-animation. */
(() => {
  'use strict';

  const COMPACT_HEIGHT = 70;
  const MAX_STEPS = 6;

  const root = document.getElementById('island');
  const badge = document.getElementById('islandBadge');
  const iconHost = document.getElementById('islandIcon');
  const label = document.getElementById('islandLabel');
  const trailing = document.getElementById('islandTrailing');
  const expanded = document.getElementById('islandExpanded');
  const stepsHost = document.getElementById('islandSteps');
  const countEl = document.getElementById('islandCount');
  const titleEl = document.getElementById('islandTitle');

  // Path data only: every glyph is a single filled path, matching the app sprite.
  const ICONS = {
    idle: 'M120,40A80,80,0,1,0,200,120,80,80,0,0,0,120,40Zm0,144a64,64,0,1,1,64-64A64,64,0,0,1,120,184Z',
    terminal: 'M120,40A80,80,0,1,0,200,120,80,80,0,0,0,120,40Zm24,96-32,24a8,8,0,0,1-8-12l24-18-24-18a8,8,0,0,1,8-12l32,24a8,8,0,0,1,0,12Z',
    file: 'M200,88V208a16,16,0,0,1-16,16H72a16,16,0,0,1-16-16V48A16,16,0,0,1,72,32h80Zm-40,0h32L160,56Z',
    search: 'M232,152a80,80,0,1,1-38.6-68.9A80,80,0,0,1,232,152Zm-80-64a64,64,0,1,0,64,64A64,64,0,0,0,152,88Z',
    brain: 'M120,32A56,56,0,0,0,64,88c0,10,2,19,7,27l-7,41a8,8,0,0,0,10,10l28-9a56,56,0,0,0,18,3A56,56,0,0,0,120,32Z',
    done: 'M232,120A112,112,0,1,1,120,8,112,112,0,0,1,232,120Zm-52-18a8,8,0,0,0-11-11l-57,57-21-21a8,8,0,0,0-11,11l27,27a8,8,0,0,0,11,0Z',
    error: 'M232,120A112,112,0,1,1,120,8,112,112,0,0,1,232,120Zm-45-71a8,8,0,0,0-11,0L120,105,64,49a8,8,0,0,0-11,11l56,56-56,56a8,8,0,0,0,11,11l56-56,56,56a8,8,0,0,0,11-11l-56-56,56-56A8,8,0,0,0,187,49Z',
  };

  const svg = (name) => {
    const d = ICONS[name] || ICONS.idle;
    return `<svg viewBox="0 0 240 240" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  };

  const STATUS_TEXT = { running: '进行中', done: '完成', error: '失败', pending: '等待' };

  let expandedNow = false;
  let lastState = { state: 'idle', label: '就绪', trailing: '', icon: 'idle', steps: [] };

  function render(state) {
    lastState = state;
    const kind = state.state === 'running' || state.state === 'done' || state.state === 'error' ? state.state : 'idle';
    root.dataset.state = kind;
    label.textContent = state.label || '就绪';
    trailing.textContent = state.trailing || '';
    iconHost.innerHTML = svg(state.icon || (kind === 'error' ? 'error' : kind === 'done' ? 'done' : kind === 'running' ? 'terminal' : 'idle'));

    const steps = Array.isArray(state.steps) ? state.steps.slice(0, MAX_STEPS) : [];
    countEl.textContent = String(steps.length);
    if (state.title) titleEl.textContent = state.title;

    if (!steps.length) {
      stepsHost.innerHTML = '<li class="island-empty">还没有工具调用</li>';
      return;
    }
    stepsHost.innerHTML = steps.map((step) => {
      const status = ['running', 'done', 'error', 'pending'].includes(step.status) ? step.status : 'pending';
      return `<li class="island-step" data-status="${status}">`
        + `<span class="island-step-icon">${svg(step.icon || 'terminal')}</span>`
        + `<span class="island-step-name"></span>`
        + `<span class="island-step-status">${status === 'running' ? '…' : (STATUS_TEXT[status] || '')}</span>`
        + '</li>';
    }).join('');
    // Names are user/tool text, so they go in as text nodes, never as markup.
    [...stepsHost.querySelectorAll('.island-step-name')].forEach((node, index) => {
      node.textContent = String(steps[index].name || '');
    });
  }

  function setExpanded(next) {
    expandedNow = Boolean(next);
    root.setAttribute('aria-expanded', String(expandedNow));
    expanded.hidden = !expandedNow;
    const height = expandedNow ? expandedHeight() : COMPACT_HEIGHT;
    window.iexaIsland?.resize(height);
  }

  function expandedHeight() {
    const steps = Math.min(MAX_STEPS, (lastState.steps || []).length) || 1;
    // Header + one row per step + padding; clamped so a 0-step card stays small.
    return 46 + 34 + steps * 34 + 16;
  }

  root.addEventListener('click', (event) => {
    // The chevron is decoration; clicking anywhere on the pill toggles.
    if (event.target.closest('.island-steps')) return;
    setExpanded(!expandedNow);
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setExpanded(!expandedNow);
    }
    if (event.key === 'Escape' && expandedNow) setExpanded(false);
  });

  window.iexaIsland?.onState((state) => {
    if (!state || typeof state !== 'object') return;
    render(state);
    if (expandedNow) window.iexaIsland?.resize(expandedHeight());
  });

  const initial = window.iexaIsland?.initial?.();
  render(initial && typeof initial === 'object' ? initial : lastState);
})();
