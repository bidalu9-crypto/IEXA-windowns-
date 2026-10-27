/* File action card: open, reveal, run, copy path.
 *
 * DeepSeek Harness's file card exposes native open/reveal actions; running an
 * artifact is our extension, so it goes through an explicit confirmation and
 * the main process allowlist.
 */
(function () {
  'use strict';

  const RUNNABLE = /\.(bat|cmd|ps1|py|sh|exe|js|vbs)$/i;

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

  async function confirmRun(name) {
    const message = t('fileActions.runConfirm', 'Run {name}? It will start outside IEXA.', { name });
    if (window.IexaDialogs && typeof window.IexaDialogs.confirm === 'function') {
      return await window.IexaDialogs.confirm(message);
    }
    return false;
  }

  async function openFile(absolutePath) {
    if (window.iexaDesktop?.openFile) return window.iexaDesktop.openFile(absolutePath);
    if (window.iexaDesktop?.openPath) return window.iexaDesktop.openPath(absolutePath);
    return { ok: false, error: 'desktop bridge unavailable' };
  }

  async function revealFile(absolutePath) {
    if (!window.iexaDesktop?.revealPath) return { ok: false, error: 'desktop bridge unavailable' };
    return window.iexaDesktop.revealPath(absolutePath);
  }

  async function runFile(absolutePath, name) {
    if (!window.iexaDesktop?.runFile) return { ok: false, error: 'desktop bridge unavailable' };
    if (!(await confirmRun(name))) return { ok: false, cancelled: true };
    return window.iexaDesktop.runFile(absolutePath);
  }

  async function copyPath(absolutePath) {
    try {
      await navigator.clipboard.writeText(absolutePath);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  function create(options) {
    const { name, absolutePath, href } = options || {};
    const card = document.createElement('div');
    card.className = 'file-action-card';

    const glyph = document.createElement('span');
    glyph.className = 'file-action-icon';
    glyph.innerHTML = icon('file');

    const body = document.createElement('div');
    body.className = 'file-action-body';
    const title = document.createElement('span');
    title.className = 'file-action-name';
    title.textContent = name || absolutePath || '';
    title.title = absolutePath || name || '';
    body.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'file-action-buttons';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'file-action-main';
    main.innerHTML = '<span>' + t('fileActions.open', 'Open') + '</span><span class="file-action-caret">▾</span>';
    main.setAttribute('aria-haspopup', 'menu');
    main.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'file-action-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const item = (label, handler, extraClass) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-action-item' + (extraClass ? ' ' + extraClass : '');
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        close();
        await handler();
      });
      return button;
    };

    const canRun = RUNNABLE.test(String(name || absolutePath || ''));
    menu.append(
      item(t('fileActions.open', 'Open'), () => openFile(absolutePath)),
      item(t('fileActions.reveal', 'Open containing folder'), () => revealFile(absolutePath)),
    );
    if (canRun) menu.appendChild(item(t('fileActions.run', 'Run in terminal'), () => runFile(absolutePath, name), 'is-danger'));
    menu.appendChild(item(t('fileActions.copyPath', 'Copy path'), () => copyPath(absolutePath)));

    function close() {
      menu.hidden = true;
      main.setAttribute('aria-expanded', 'false');
    }

    main.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = menu.hidden;
      menu.hidden = !opening;
      main.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) {
        const rect = main.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = Math.round(rect.bottom + 4) + 'px';
        menu.style.left = Math.round(Math.min(rect.left, window.innerWidth - 220)) + 'px';
      }
    });
    menu.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', close);

    actions.append(main, menu);
    card.append(glyph, body, actions);

    // A single click on the name opens the file; the menu stays explicit.
    body.addEventListener('click', () => openFile(absolutePath));
    card.dataset.path = absolutePath || '';
    if (href) card.dataset.href = href;
    return card;
  }

  window.IexaFileActions = { create, openFile, revealFile, runFile, copyPath };
})();
