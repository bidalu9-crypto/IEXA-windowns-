// One travelling highlight per running label, drawn the way DeepSeek Harness
// draws TextShimmer: the label keeps its own text and colour, and an aria-hidden
// copy sits inside a clipped window under a static mask. Two opposite transforms
// (the window sliding one way, the copy sliding back) move the band across
// stationary glyphs, so both animated properties are transforms and the label
// never re-rasterises. The previous implementation animated background-position
// over -webkit-text-fill-color: transparent, which repaints every glyph of the
// label on every frame and has no band at all for the last third of its cycle.
(function () {
  'use strict';

  const GLOW = 'label-glow';
  const SWEEP = GLOW + '__sweep';
  const COPY = GLOW + '__copy';

  // The label's own text lives in its first text node; the decoration is a later
  // child, so reading firstChild keeps the copy from swallowing itself.
  function ownText(el) {
    const first = el.firstChild;
    return first && first.nodeType === 3 ? first.nodeValue : '';
  }

  function attach(el) {
    if (!el) return null;
    let glow = el.querySelector(':scope > .' + GLOW);
    if (!glow) {
      glow = document.createElement('span');
      glow.className = GLOW;
      glow.setAttribute('aria-hidden', 'true');
      const sweep = document.createElement('span');
      sweep.className = SWEEP;
      const copy = document.createElement('span');
      copy.className = COPY;
      sweep.append(copy);
      glow.append(sweep);
      el.append(glow);
    }
    const copy = glow.firstChild && glow.firstChild.firstChild;
    const text = ownText(el);
    if (copy && text && copy.textContent !== text) copy.textContent = text;
    return glow;
  }

  function detach(el) {
    const glow = el && el.querySelector(':scope > .' + GLOW);
    if (glow) glow.remove();
  }

  function sync(el, active) {
    if (!el) return;
    if (active) attach(el);
    else detach(el);
  }

  // A tool row is "running" exactly when it carries is-active; the class is the
  // single source of truth, so callers never have to restate the state machine.
  function syncRow(block) {
    if (!block || !block.classList) return;
    const active = block.classList.contains('is-active');
    sync(block.querySelector('.tool-name'), active);
    sync(block.querySelector('.activity-operation'), active);
  }

  window.IexaLabelGlow = Object.freeze({ attach, detach, sync, syncRow });
})();
