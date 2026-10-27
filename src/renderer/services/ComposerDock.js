/* Composer dock: the ordered stack directly above the input card.
 *
 * DeepSeek Harness puts every transient composer surface — the task plan and
 * the queued prompts — on one `conversation.input.dock` chain, ordered by
 * number. Mirroring that here keeps the two features from inventing their own
 * placement: both register an element, the container hides itself when every
 * entry is hidden, and the CSS `order` property keeps the stack deterministic.
 */
(function () {
  'use strict';

  const entries = new Map();
  let cached = null;

  function root() {
    if (cached && cached.isConnected) return cached;
    cached = document.getElementById('composerDock');
    return cached;
  }

  function applyOrder(el) {
    for (const entry of entries.values()) {
      if (!entry.el) continue;
      if (entry.el.parentElement !== el) el.appendChild(entry.el);
      entry.el.style.order = String(entry.order);
    }
  }

  function refresh() {
    const el = root();
    if (!el) return;
    let visible = false;
    for (const entry of entries.values()) {
      if (entry.el && !entry.el.hidden) { visible = true; break; }
    }
    el.hidden = !visible;
  }

  function register(id, order, el) {
    entries.set(id, { order, el });
    const el2 = root();
    if (el2) applyOrder(el2);
    refresh();
  }

  window.IexaComposerDock = { register, refresh, root };
})();
