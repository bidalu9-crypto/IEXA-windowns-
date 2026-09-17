/* Independent panel visibility; the existing focus control remains available. */
(() => {
  'use strict';
  function init() {
    const root = document.body;
    const buttons = { left: document.getElementById('leftPanelToggle'), right: document.getElementById('rightPanelToggle') };
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('iexa-panel-visibility') || '{}') || {}; } catch {}
    for (const side of ['left', 'right']) root.classList.toggle(`${side}-panel-hidden`, saved[side] === false);
    const update = () => {
      for (const side of ['left', 'right']) {
        const shown = !root.classList.contains(`${side}-panel-hidden`) && !root.classList.contains('chat-focus-mode');
        const label = `${shown ? '隐藏' : '展开'}${side === 'left' ? '左' : '右'}侧栏`;
        buttons[side]?.setAttribute('aria-expanded', String(shown));
        buttons[side]?.setAttribute('aria-label', label);
        if (buttons[side]) buttons[side].title = label;
      }
    };
    for (const side of ['left', 'right']) buttons[side]?.addEventListener('click', () => {
      if (root.classList.contains('chat-focus-mode')) {
        document.getElementById('chatFocusToggle')?.click();
        root.classList.add('left-panel-hidden', 'right-panel-hidden');
      }
      root.classList.toggle(`${side}-panel-hidden`);
      try { localStorage.setItem('iexa-panel-visibility', JSON.stringify({
        left: !root.classList.contains('left-panel-hidden'), right: !root.classList.contains('right-panel-hidden'),
      })); } catch {}
      update();
    });
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    update();
  }
  window.IexaPanelVisibility = Object.freeze({ init });
})();
