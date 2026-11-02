/* The island is a tiny viewer: it renders whatever state the main window last
   pushed and never computes tool semantics itself. Expanding only resizes the
   window and swaps one section, so the pill never re-mounts mid-animation. */
(() => {
  'use strict';

  const COMPACT_HEIGHT = 46;
  const EXPANDED_MIN_WIDTH = 272;
  const ISLAND_FALLBACK_WIDTH = 176;
  const MAX_WIDTH = 460;
  const MAX_STEPS = 6;

  const root = document.getElementById('island');
  const badge = document.getElementById('islandBadge');
  const label = document.getElementById('islandLabel');
  const trailing = document.getElementById('islandTrailing');
  const expanded = document.getElementById('islandExpanded');
  const stepsHost = document.getElementById('islandSteps');
  const countEl = document.getElementById('islandCount');
  const titleEl = document.getElementById('islandTitle');

  /* Stroked glyphs, not filled blobs.
     A 240-unit filled path scaled to 15px collapses into a dark smudge — the
     terminal icon in particular rendered as a circle with a dent, which read as
     a play button. These are strokes at width 20 (≈1.25px at display size), the
     same optical weight as SF Symbols, so they stay legible in a 15px box. */
  const GLYPHS = {
    terminal: ['M64,80l56,48-56,48', 'M140,176h52'],
    file: ['M72,40h64l48,48v120H72z', 'M136,40v48h48'],
    search: ['M112,48a64,64,0,1,1,0,128,64,64,0,0,1,0-128Z', 'M160,160l40,40'],
    think: ['M120,44l14,34,34,14-34,14-14,34-14-34-34-14,34-14z', 'M188,140l7,17,17,7-17,7-7,17-7-17-17-7,17-7z'],
    edit: ['M96,200H56a8,8,0,0,1-8-8V56a8,8,0,0,1,8-8h88l56,56v40'],
    globe: ['M120,40a80,80,0,1,1,0,160,80,80,0,0,1,0-160Z', 'M40,120h160', 'M120,40c40,40,40,120,0,160', 'M120,40c-40,40-40,120,0,160'],
    done: ['M52,128l48,48 96-96'],
    error: ['M64,64l112,112', 'M176,64L64,176'],
    pending: ['M120,48a72,72,0,1,1,0,144,72,72,0,0,1,0-144Z'],
  };

  const glyph = (name) => {
    const paths = GLYPHS[name] || GLYPHS.terminal;
    const body = paths.map((d) => `<path d="${d}"/>`).join('');
    return '<svg viewBox="0 0 240 240" fill="none" stroke="currentColor" stroke-width="20" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  };

  const STATUS_TEXT = { running: '…', done: '完成', error: '失败', pending: '等待' };

  let expandedNow = false;
  let lastState = { state: 'idle', label: '就绪', trailing: '', steps: [] };
  let signature = '';

  function render(state) {
    lastState = state;
    const kind = ['running', 'done', 'error'].includes(state.state) ? state.state : 'idle';
    root.dataset.state = kind;
    label.textContent = state.label || '就绪';
    trailing.textContent = state.trailing || '';
    trailing.hidden = !state.trailing;

    const steps = Array.isArray(state.steps) ? state.steps.slice(0, MAX_STEPS) : [];
    countEl.textContent = String(steps.length);
    if (state.title) titleEl.textContent = state.title;

    // Re-rendering identical rows would restart every entry animation on each
    // state push, which reads as the list flickering. Only rebuild on change.
    const next = steps.map((step) => `${step.icon || ''}|${step.name || ''}|${step.status || ''}`).join('\n');
    if (next === signature) return;
    signature = next;

    if (!steps.length) {
      stepsHost.innerHTML = '<li class="island-empty">还没有工具调用</li>';
      return;
    }
    stepsHost.innerHTML = steps.map((step, index) => {
      const status = ['running', 'done', 'error', 'pending'].includes(step.status) ? step.status : 'pending';
      return `<li class="island-step" data-status="${status}" style="--i:${index}">`
        + `<span class="island-step-icon">${glyph(step.icon || 'terminal')}</span>`
        + `<span class="island-step-name"></span>`
        + `<span class="island-step-status">${STATUS_TEXT[status] || ''}</span>`
        + '</li>';
    }).join('');
    // Names are user/tool text, so they go in as text nodes, never as markup.
    [...stepsHost.querySelectorAll('.island-step-name')].forEach((node, index) => {
      node.textContent = String(steps[index].name || '');
    });
  }

  /**
   * Natural width of the compact row, in CSS pixels.
   *
   * Measuring in place does not work: the row lives inside `.island`, which is
   * absolutely positioned and already clipped to the window, so any `max-content`
   * request is answered with the window width. The result was a feedback loop —
   * the pill measured as wide as it already was, so a truncated label could never
   * grow back. The row is cloned into a fixed-position box at the root instead,
   * where nothing constrains it.
   */
  function compactWidth() {
    const row = document.querySelector('.island-compact');
    if (!row) return ISLAND_FALLBACK_WIDTH;
    const clone = row.cloneNode(true);
    clone.style.cssText = 'position:fixed;left:-9999px;top:0;width:max-content;'
      + 'max-width:none;visibility:hidden;pointer-events:none';
    document.body.appendChild(clone);
    // A cloned hidden trailing span keeps its space; hide it the same way the
    // live row does so the measurement matches what will be drawn.
    const cloneTrailing = clone.querySelector('.island-trailing');
    if (cloneTrailing && !cloneTrailing.textContent.trim()) cloneTrailing.hidden = true;
    const measured = Math.ceil(clone.getBoundingClientRect().width);
    clone.remove();
    // + 10 for the 5px inset on each side of the window.
    return Math.min(MAX_WIDTH, Math.max(ISLAND_FALLBACK_WIDTH, measured + 10));
  }

  function applySize() {
    const width = expandedNow
      ? Math.min(MAX_WIDTH, Math.max(compactWidth(), EXPANDED_MIN_WIDTH))
      : compactWidth();
    const height = expandedNow ? expandedHeight() : COMPACT_HEIGHT;
    window.iexaIsland?.resize({ width, height });
  }

  function expandedHeight() {
    // Measured on a detached clone at natural size.
    //
    // Everything in-place is unreliable: the window is still compact height, so
    // `.island-expanded` is a 0-height flex child with overflow hidden, and both
    // `scrollHeight` and `height:auto` come back compressed by the flex parent.
    // A clone outside that flex context reports the truth.
    //
    // Two details decide whether that number is usable:
    //   * animations are off on the clone — `island-card-in` starts at
    //     `scale(.985)`, and a transform does change getBoundingClientRect();
    //   * 4px of slack, because sub-pixel line heights round differently between
    //     the clone and the live card, which is enough to clip the last row.
    if (!expanded) return COMPACT_HEIGHT;
    const width = Math.min(MAX_WIDTH, Math.max(compactWidth(), EXPANDED_MIN_WIDTH)) - 10;
    const clone = expanded.cloneNode(true);
    clone.removeAttribute('hidden');
    clone.style.cssText = 'position:fixed;left:-9999px;top:0;height:auto;animation:none;'
      + `width:${width}px;visibility:hidden;pointer-events:none`;
    document.body.appendChild(clone);
    const measured = Math.ceil(clone.getBoundingClientRect().height);
    clone.remove();
    return COMPACT_HEIGHT + measured + 4;
  }

  function setExpanded(next) {
    expandedNow = Boolean(next);
    root.setAttribute('aria-expanded', String(expandedNow));
    expanded.hidden = !expandedNow;
    applySize();
  }

  root.addEventListener('click', (event) => {
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
  // Fonts can change the measured width; re-measure once they are in.
  if (document.fonts?.ready) document.fonts.ready.then(applySize);
})();
