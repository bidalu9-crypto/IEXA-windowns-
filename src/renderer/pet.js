// =============================================================================
// IEXA - Desktop pet surface
//
// Runs inside its own transparent BrowserWindow. It owns nothing but the
// sprite, the idle motion and the drag gesture; every state change is reported
// to the main process through the preload bridge.
// =============================================================================
(() => {
  'use strict';

  const stage = document.getElementById('stage');
  const sprite = document.getElementById('sprite');
  const shadow = document.getElementById('shadow');
  const bubble = document.getElementById('bubble');
  const menu = document.getElementById('menu');
  const bridge = window.iexaPet || null;

  const LINES = [
    '我在这儿。',
    '要休息一下吗？',
    '有活儿就叫我。',
    '今天也要顺利。',
    '点我做什么？',
    '我在看着你写代码。',
  ];

  let drag = null;
  let bubbleTimer = 0;
  let pokeTimer = 0;

  function say(text, ms = 2600) {
    if (!bubble) return;
    bubble.textContent = text;
    bubble.hidden = false;
    // Next frame so the transition runs from the hidden state.
    requestAnimationFrame(() => bubble.classList.add('is-visible'));
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.classList.remove('is-visible');
      bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 220);
    }, ms);
  }

  function loadSprite(version) {
    const url = version ? `api/pet/sprite?v=${encodeURIComponent(version)}` : 'api/pet/sprite';
    const probe = new Image();
    probe.onload = () => {
      sprite.src = url;
      stage.dataset.ready = 'true';
    };
    probe.onerror = () => {
      stage.dataset.ready = 'false';
      sprite.removeAttribute('src');
    };
    probe.src = url;
  }

  function applyConfig(config) {
    if (!config) return;
    stage.dataset.shadow = config.shadow ? 'on' : 'off';
    if (!config.reactions) {
      bubble.hidden = true;
      bubble.classList.remove('is-visible');
    }
  }

  // ---- drag -------------------------------------------------------------
  // The window moves with the pointer; the sprite only tilts, so the cursor
  // never drifts away from what it grabbed.
  sprite.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    closeMenu();
    drag = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, moved: false };
    sprite.setPointerCapture(event.pointerId);
    stage.dataset.dragging = 'true';
    bridge?.dragStart?.({ x: event.screenX, y: event.screenY });
  });

  sprite.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    // Lean into the direction of travel, capped so it never looks broken.
    const tilt = Math.max(-8, Math.min(8, dx * 0.12));
    sprite.style.transform = `rotate(${tilt.toFixed(2)}deg)`;
    bridge?.dragMove?.({ dx, dy });
  });

  const endDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const wasClick = !drag.moved;
    try { sprite.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    drag = null;
    stage.dataset.dragging = 'false';
    sprite.style.transform = '';
    bridge?.dragEnd?.();
    if (wasClick) poke();
  };

  sprite.addEventListener('pointerup', endDrag);
  sprite.addEventListener('pointercancel', endDrag);

  // ---- click reaction ---------------------------------------------------
  function poke() {
    clearTimeout(pokeTimer);
    sprite.classList.remove('is-poked');
    // Force a reflow so a rapid second click restarts the animation.
    void sprite.offsetWidth;
    sprite.classList.add('is-poked');
    pokeTimer = setTimeout(() => sprite.classList.remove('is-poked'), 520);
    stage.dataset.mood = 'happy';
    setTimeout(() => { delete stage.dataset.mood; }, 900);
    if (stage.dataset.reactions !== 'off') say(LINES[Math.floor(Math.random() * LINES.length)]);
    bridge?.poked?.();
  }

  sprite.addEventListener('dblclick', () => bridge?.openMain?.());

  // ---- context menu -----------------------------------------------------
  function openMenu(x, y) {
    menu.hidden = false;
    const width = menu.offsetWidth || 160;
    const height = menu.offsetHeight || 160;
    menu.style.left = `${Math.max(6, Math.min(x, innerWidth - width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, innerHeight - height - 6))}px`;
    menu.querySelector('button')?.focus();
  }

  function closeMenu() {
    menu.hidden = true;
  }

  sprite.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY);
  });

  menu.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    closeMenu();
    if (action === 'toggle-wander') {
      const paused = button.textContent.includes('暂停') === false;
      button.textContent = paused ? '开始走动' : '暂停走动';
      bridge?.setWander?.(!paused);
      return;
    }
    bridge?.menuAction?.(action);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { closeMenu(); event.preventDefault(); }
  });

  // ---- host messages ----------------------------------------------------
  window.addEventListener('iexa:pet-state', (event) => {
    const detail = event.detail || {};
    if (typeof detail.spriteVersion === 'string') loadSprite(detail.spriteVersion);
    applyConfig(detail.config);
    if (detail.say) say(String(detail.say));
    const wanderButton = menu.querySelector('[data-action="toggle-wander"]');
    if (wanderButton && detail.config) wanderButton.textContent = detail.config.wander ? '暂停走动' : '开始走动';
  });

  // First paint asks the host for the current sprite and settings.
  bridge?.ready?.();
  if (bridge?.initialState) {
    loadSprite(bridge.initialState.spriteVersion);
    applyConfig(bridge.initialState.config);
  } else {
    loadSprite('');
  }
})();
