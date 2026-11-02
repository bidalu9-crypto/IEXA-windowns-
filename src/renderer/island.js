/* The island is a tiny viewer: it renders whatever state the main window last
   pushed and never computes tool semantics itself. Expanding only resizes the
   window and swaps one section, so the pill never re-mounts mid-animation. */
(() => {
  'use strict';

  const COMPACT_HEIGHT = 40;
const EXPANDED_MIN_WIDTH = 268;
const ISLAND_FALLBACK_WIDTH = 168;
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
    done: 'M232,56a8,8,0,0,0-13.66-5.66L95,174.37,29.66,109a8,8,0,0,0-11.32,11.32l71,71a8,8,0,0,0,11.32,0l129-129A8,8,0,0,0,232,56Z',
    error: 'M200.49,183.51a8,8,0,0,1-11.32,11.32L120,125.66,50.83,194.83a8,8,0,0,1-11.32-11.32L108.69,114.34,39.51,45.17a8,8,0,0,1,11.32-11.32L120,102.69l69.17-68.84a8,8,0,0,1,11.32,11.32L131.31,114.34Z',
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
    applySize();
  }

  /**
   * The width the compact row actually needs, in CSS pixels.
   *
   * The window is the only thing that can resize, and it cannot see its own
   * content, so the row is measured at `max-content` for one frame. This is what
   * makes the pill hug its words instead of sitting inside a fixed 208px band
   * with empty glass either side.
   */
  function compactWidth() {
    const row = document.querySelector('.island-compact');
    if (!row) return ISLAND_FALLBACK_WIDTH;
    const previous = row.style.width;
    row.style.width = 'max-content';
    const measured = Math.ceil(row.getBoundingClientRect().width);
    row.style.width = previous;
    // + 10 for the 5px inset on each side of the window.
    return measured + 10;
  }

  function applySize() {
    const width = expandedNow
      ? Math.max(compactWidth(), EXPANDED_MIN_WIDTH)
      : compactWidth();
    const height = expandedNow ? expandedHeight() : COMPACT_HEIGHT;
    window.iexaIsland?.resize({ width, height });
  }

  function expandedHeight() {
    // Measured on a detached clone at natural size.
    //
    // Everything in-place is unreliable here: the window is still 40px tall, so
    // `.island-expanded` is a 0-height flex child with overflow hidden, and both
    // `scrollHeight` and `height:auto` come back compressed by the flex parent
    // (87px and 57px for a card that needs ~148px). A clone outside that flex
    // context reports the truth — which is what removes the scrollbar.
    if (!expanded) return COMPACT_HEIGHT;
    const clone = expanded.cloneNode(true);
    clone.removeAttribute('hidden');
    clone.style.cssText = 'position:fixed;left:-9999px;top:0;height:auto;width:252px;visibility:hidden';
    document.body.appendChild(clone);
    const measured = Math.ceil(clone.getBoundingClientRect().height);
    clone.remove();
    return COMPACT_HEIGHT + measured + 10;
  }

  root.addEventListener('click', (event) => {
    // Clicking anywhere on the pill toggles; the step list is the only region
    // that swallows the click so its scrollbar stays usable.
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
    applySize();
  });

  const initial = window.iexaIsland?.initial?.();
  render(initial && typeof initial === 'object' ? initial : lastState);
})();
