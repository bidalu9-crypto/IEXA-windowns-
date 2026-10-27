/* Task-plan dock above the composer.
 *
 * Mirrors DeepSeek Harness's TodoPanel: collapsed by default, a single header
 * line with the per-status counts joined by a wide middle dot, and a capped
 * scrolling list. The panel renders nothing when the session has no plan, and
 * a dismissal only lasts until a new plan arrives.
 */
(function () {
  'use strict';

  const WIDE_DOT = '\u2002·\u2002';
  let sessionId = '';
  let todos = [];
  let dismissedSignature = '';
  let collapsed = true;
  let ui = null;

  function t(key, fallback, params) {
    try {
      const value = window.IexaI18n ? window.IexaI18n.t(key, params) : key;
      return value === key ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function icon(name) {
    return typeof window.uiIcon === 'function' ? window.uiIcon(name) : '';
  }

  function signature() {
    return sessionId + '|' + todos.map((item) => item.status + ':' + item.content).join('|');
  }

  function counts() {
    let done = 0;
    let active = 0;
    for (const item of todos) {
      if (item.status === 'completed') done += 1;
      else if (item.status === 'in_progress') active += 1;
    }
    return { done, active, pending: todos.length - done - active };
  }

  function progressLabel() {
    const { done, active, pending } = counts();
    const parts = [];
    if (done) parts.push(t('dock.done', done + ' done', { count: done }));
    if (active) parts.push(t('dock.active', active + ' in progress', { count: active }));
    if (pending) parts.push(t('dock.pending', pending + ' pending', { count: pending }));
    return parts.join(WIDE_DOT);
  }

  function statusClass(status) {
    if (status === 'completed') return 'is-done';
    if (status === 'in_progress') return 'is-active';
    return 'is-pending';
  }

  function statusLabel(status) {
    if (status === 'completed') return t('dock.status.done', 'Completed');
    if (status === 'in_progress') return t('dock.status.active', 'In progress');
    return t('dock.status.pending', 'Pending');
  }

  function build() {
    const host = window.IexaComposerDock && window.IexaComposerDock.root
      ? window.IexaComposerDock.root()
      : document.getElementById('composerDock');
    if (!host) return null;

    const section = document.createElement('section');
    section.className = 'dock-panel dock-plan';
    section.id = 'planDock';
    section.hidden = true;
    section.setAttribute('aria-label', t('dock.plan', 'Tasks'));
    section.innerHTML =
      '<div class="dock-head">' +
        '<button type="button" class="dock-toggle" aria-expanded="false">' +
          '<span class="dock-lead" aria-hidden="true">' + icon('check') + '</span>' +
          '<span class="dock-title">' + t('dock.plan', 'Tasks') + '</span>' +
          '<span class="dock-progress"></span>' +
          '<span class="dock-chevron" aria-hidden="true">' + icon('chevron-down') + '</span>' +
        '</button>' +
        '<button type="button" class="dock-dismiss" aria-label="' + t('dock.hide', 'Hide') + '">' + icon('close') + '</button>' +
      '</div>' +
      '<ul class="dock-list" role="list"></ul>';

    const toggle = section.querySelector('.dock-toggle');
    const list = section.querySelector('.dock-list');
    const progress = section.querySelector('.dock-progress');
    const dismiss = section.querySelector('.dock-dismiss');

    toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      render();
      try { sessionStorage.setItem('iexa.dock.plan.collapsed', collapsed ? '1' : '0'); } catch { /* storage is optional */ }
    });
    dismiss.addEventListener('click', () => {
      dismissedSignature = signature();
      render();
    });

    if (window.IexaComposerDock && window.IexaComposerDock.register) {
      window.IexaComposerDock.register('plan', 0, section);
    } else {
      host.appendChild(section);
    }
    ui = { section, toggle, list, progress };
    return ui;
  }

  function ensure() {
    if (ui && ui.section.isConnected) return ui;
    return build();
  }

  function render() {
    const el = ensure();
    if (!el) return;
    const visible = todos.length > 0 && signature() !== dismissedSignature;
    el.section.hidden = !visible;
    if (!visible) {
      if (window.IexaComposerDock) window.IexaComposerDock.refresh();
      return;
    }
    el.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    el.section.dataset.collapsed = collapsed ? 'true' : 'false';
    el.progress.textContent = progressLabel();
    el.list.hidden = collapsed;
    el.list.replaceChildren();
    if (!collapsed) {
      for (const item of todos) {
        const li = document.createElement('li');
        li.className = 'dock-list-item ' + statusClass(item.status);
        const dot = document.createElement('span');
        dot.className = 'dock-dot';
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', statusLabel(item.status));
        const text = document.createElement('span');
        text.className = 'dock-item-text';
        text.textContent = item.content;
        li.append(dot, text);
        el.list.appendChild(li);
      }
    }
    if (window.IexaComposerDock) window.IexaComposerDock.refresh();
  }

  function setTodos(nextSessionId, items) {
    if (nextSessionId !== sessionId) {
      sessionId = nextSessionId;
      dismissedSignature = '';
      try {
        const saved = sessionStorage.getItem('iexa.dock.plan.collapsed');
        if (saved === '1' || saved === '0') collapsed = saved === '1';
      } catch { /* storage is optional */ }
    }
    const seen = new Set();
    todos = (Array.isArray(items) ? items : []).filter((item) => {
      if (!item || typeof item.content !== 'string') return false;
      if (seen.has(item.content)) return false;
      seen.add(item.content);
      return ['completed', 'in_progress', 'pending'].includes(item.status);
    });
    // A new plan must survive an earlier dismissal; only the same plan stays hidden.
    if (dismissedSignature && dismissedSignature !== signature()) dismissedSignature = '';
    render();
  }

  function extractTodos(messages) {
    if (!Array.isArray(messages)) return [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const calls = messages[i] && messages[i].toolCalls;
      if (!Array.isArray(calls)) continue;
      for (let j = calls.length - 1; j >= 0; j -= 1) {
        const call = calls[j];
        if (!call || call.name !== 'todo_write' || !call.result) continue;
        const list = call.result.todos;
        if (Array.isArray(list) && list.length) return list;
        if (Array.isArray(call.args && call.args.todos) && call.args.todos.length) return call.args.todos;
      }
    }
    return [];
  }

  function reset() {
    sessionId = '';
    todos = [];
    dismissedSignature = '';
    if (ui) ui.section.hidden = true;
    if (window.IexaComposerDock) window.IexaComposerDock.refresh();
  }

  window.IexaPlanDock = { setTodos, extractTodos, reset, getTodos: () => todos };
})();
