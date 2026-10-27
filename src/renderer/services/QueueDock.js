/* Queued-prompt dock above the composer.
 *
 * DeepSeek Harness's QueueDock and Codex both keep pending prompts outside the
 * transcript. Each row carries the mode, a short preview, and per-row edit and
 * remove actions; more than three rows collapse behind a counter so the input
 * card never grows without bound.
 */
(function () {
  'use strict';

  const COLLAPSE_AT = 3;
  let sessionId = '';
  let items = [];
  let expanded = false;
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

  function preview(item) {
    const raw = String(item.displayText || item.text || '').replace(/\s+/g, ' ').trim();
    const text = raw || t('dock.attachmentsOnly', 'Attachments only');
    return text.length > 42 ? text.slice(0, 41) + '…' : text;
  }

  function modeLabel(mode) {
    return mode === 'interrupt' || mode === 'steer'
      ? t('dock.mode.steer', 'Steer')
      : t('dock.mode.queue', 'Queue');
  }

  function build() {
    const host = window.IexaComposerDock && window.IexaComposerDock.root
      ? window.IexaComposerDock.root()
      : document.getElementById('composerDock');
    if (!host) return null;

    const section = document.createElement('section');
    section.className = 'dock-panel dock-queue';
    section.id = 'queueDock';
    section.hidden = true;
    section.setAttribute('aria-label', t('dock.queue', 'Queued messages'));
    section.innerHTML =
      '<div class="dock-head">' +
        '<button type="button" class="dock-toggle" aria-expanded="false">' +
          '<span class="dock-lead" aria-hidden="true">' + icon('send') + '</span>' +
          '<span class="dock-title">' + t('dock.queue', 'Queued messages') + '</span>' +
          '<span class="dock-progress"></span>' +
          '<span class="dock-chevron" aria-hidden="true">' + icon('chevron-down') + '</span>' +
        '</button>' +
      '</div>' +
      '<ul class="dock-list dock-queue-list" role="list"></ul>' +
      '<button type="button" class="dock-more" hidden></button>';

    const toggle = section.querySelector('.dock-toggle');
    const more = section.querySelector('.dock-more');
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      render();
    });
    more.addEventListener('click', () => {
      expanded = true;
      render();
    });

    if (window.IexaComposerDock && window.IexaComposerDock.register) {
      window.IexaComposerDock.register('queue', 20, section);
    } else {
      host.appendChild(section);
    }
    ui = {
      section,
      toggle,
      more,
      list: section.querySelector('.dock-list'),
      progress: section.querySelector('.dock-progress'),
    };
    return ui;
  }

  function ensure() {
    if (ui && ui.section.isConnected) return ui;
    return build();
  }

  function chip(item, index) {
    const li = document.createElement('li');
    li.className = 'dock-queue-chip';
    li.dataset.queueId = item.id || '';

    const order = document.createElement('span');
    order.className = 'dock-queue-index';
    order.textContent = String(index + 1);

    const text = document.createElement('span');
    text.className = 'dock-queue-text';
    text.textContent = preview(item);
    text.title = String(item.displayText || item.text || '');

    const mode = document.createElement('span');
    mode.className = 'dock-queue-mode' + (item.mode === 'interrupt' ? ' is-steer' : '');
    mode.textContent = modeLabel(item.mode);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'dock-icon-btn';
    edit.title = t('dock.edit', 'Edit');
    edit.setAttribute('aria-label', t('dock.edit', 'Edit'));
    edit.innerHTML = icon('edit');
    edit.addEventListener('click', () => {
      const input = document.getElementById('chatInput');
      if (input) {
        input.value = String(item.text || item.displayText || '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
      window.withdrawQueuedMessage?.(item.id);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'dock-icon-btn';
    remove.title = t('dock.remove', 'Remove');
    remove.setAttribute('aria-label', t('dock.remove', 'Remove'));
    remove.innerHTML = icon('close');
    remove.addEventListener('click', () => window.withdrawQueuedMessage?.(item.id));

    li.append(order, text, mode, edit, remove);
    return li;
  }

  function render() {
    const el = ensure();
    if (!el) return;
    const visible = items.length > 0;
    el.section.hidden = !visible;
    if (!visible) {
      if (window.IexaComposerDock) window.IexaComposerDock.refresh();
      return;
    }

    const collapsed = items.length > COLLAPSE_AT && !expanded;
    el.section.dataset.collapsed = collapsed ? 'true' : 'false';
    el.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    el.progress.textContent = items.length + ' ' + t('dock.queueUnit', 'queued');
    el.list.replaceChildren();

    const shown = collapsed ? items.slice(0, COLLAPSE_AT) : items;
    shown.forEach((item, index) => el.list.appendChild(chip(item, index)));

    const hiddenCount = items.length - shown.length;
    el.more.hidden = hiddenCount <= 0;
    if (hiddenCount > 0) {
      el.more.textContent = t('dock.more', '+' + hiddenCount + ' more queued', { count: hiddenCount });
    }
    if (window.IexaComposerDock) window.IexaComposerDock.refresh();
  }

  function setQueue(nextSessionId, queue) {
    if (nextSessionId !== sessionId) {
      sessionId = nextSessionId;
      expanded = false;
    }
    items = Array.isArray(queue) ? queue.filter((item) => item && item.id) : [];
    if (items.length <= COLLAPSE_AT) expanded = false;
    render();
  }

  function reset() {
    sessionId = '';
    items = [];
    expanded = false;
    if (ui) ui.section.hidden = true;
    if (window.IexaComposerDock) window.IexaComposerDock.refresh();
  }

  window.IexaQueueDock = { setQueue, reset, getItems: () => items };
})();
