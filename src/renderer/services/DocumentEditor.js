/* Long Markdown document workspace.

   Why a textarea instead of CodeMirror: the renderer has no bundler (every
   module is a classic <script>), and CodeMirror 6 ships ESM-only, so adopting it
   would mean adding a build step for the renderer — an architecture change this
   task forbids. A native textarea is a real editable control with the best
   Chinese IME behaviour available, so undo/redo, search and autosave are
   implemented here on top of it.

   The document is copied out of a message; the transcript is never mutated. */
(() => {
  'use strict';

  const AUTOSAVE_DELAY = 1200;
  const SNAPSHOT_DELAY = 500;
  const MAX_HISTORY = 200;

  const state = {
    path: '',
    name: '',
    mtimeMs: 0,
    dirty: false,
    saving: false,
    savedText: '',
    lastSavedAt: 0,
    history: [],
    historyIndex: -1,
    lastSnapshotAt: 0,
    composing: false,
    searchHits: [],
    searchIndex: -1,
    status: { tone: 'idle', text: IexaI18n.t('doc.ready') },
  };

  let ui = null;
  let autosaveTimer = null;
  let snapshotTimer = null;
  let ready = false;

  const base = () => {
    try { return typeof API_BASE === 'string' ? API_BASE : ''; } catch { return ''; }
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const span = el('span', 'doc-icon');
    span.innerHTML = window.uiIcon ? window.uiIcon(name) : '';
    return span;
  }

  // ---- markup --------------------------------------------------------------

  function build() {
    const host = document.getElementById('view-doc');
    if (!host || host.dataset.built === '1') return host && host.dataset.built === '1';
    host.dataset.built = '1';
    host.replaceChildren();

    const page = el('div', 'doc-page');

    // Header: name, path, primary actions.
    const head = el('div', 'doc-head');
    const headMain = el('div', 'doc-head-main');
    const title = el('h2', 'doc-title', IexaI18n.t('doc.untitled'));
    title.id = 'docTitle';
    const pathEl = el('p', 'doc-path', IexaI18n.t('doc.unsaved'));
    pathEl.id = 'docPath';
    headMain.append(title, pathEl);
    const headActions = el('div', 'doc-head-actions');
    const mk = (label, iconName, className) => {
      const button = el('button', 'doc-btn' + (className ? ' ' + className : ''));
      button.type = 'button';
      if (iconName) button.appendChild(icon(iconName));
      button.appendChild(el('span', null, label));
      return button;
    };
    const btnNew = mk(IexaI18n.t('doc.new'), 'plus');
    const btnOpen = mk(IexaI18n.t('doc.open'), 'folder');
    const btnSave = mk(IexaI18n.t('doc.save'), 'check', 'is-primary');
    const btnSaveAs = mk(IexaI18n.t('doc.saveAs'), 'copy');
    btnNew.id = 'docNewBtn';
    btnOpen.id = 'docOpenBtn';
    btnSave.id = 'docSaveBtn';
    btnSaveAs.id = 'docSaveAsBtn';
    headActions.append(btnNew, btnOpen, btnSave, btnSaveAs);
    head.append(headMain, headActions);
    page.appendChild(head);

    // Toolbar: history, search, layout.
    const toolbar = el('div', 'doc-toolbar');
    const history = el('div', 'doc-toolbar-group');
    const btnUndo = mk(IexaI18n.t('doc.undo'), 'arrow-left');
    const btnRedo = mk(IexaI18n.t('doc.redo'), 'arrow-right');
    btnUndo.id = 'docUndoBtn';
    btnRedo.id = 'docRedoBtn';
    btnUndo.title = IexaI18n.t('doc.undoTitle');
    btnRedo.title = IexaI18n.t('doc.redoTitle');
    history.append(btnUndo, btnRedo);

    const search = el('div', 'doc-toolbar-group doc-search');
    const searchInput = el('input', 'doc-search-input');
    searchInput.type = 'search';
    searchInput.id = 'docSearchInput';
    searchInput.placeholder = IexaI18n.t('doc.searchPlaceholder');
    searchInput.setAttribute('aria-label', IexaI18n.t('doc.searchPlaceholder'));
    const searchCount = el('span', 'doc-search-count', '');
    searchCount.id = 'docSearchCount';
    const btnPrev = el('button', 'doc-icon-btn');
    btnPrev.type = 'button';
    btnPrev.title = IexaI18n.t('doc.prev');
    btnPrev.setAttribute('aria-label', IexaI18n.t('doc.prevMatch'));
    btnPrev.appendChild(icon('arrow-up'));
    const btnNext = el('button', 'doc-icon-btn');
    btnNext.type = 'button';
    btnNext.title = IexaI18n.t('doc.next');
    btnNext.setAttribute('aria-label', IexaI18n.t('doc.nextMatch'));
    btnNext.appendChild(icon('arrow-down'));
    search.append(searchInput, searchCount, btnPrev, btnNext);

    const layout = el('div', 'doc-toolbar-group');
    const btnPreview = mk(IexaI18n.t('doc.preview'), 'eye');
    btnPreview.id = 'docPreviewBtn';
    btnPreview.setAttribute('aria-pressed', 'true');
    layout.append(btnPreview);

    toolbar.append(history, search, layout);
    page.appendChild(toolbar);

    // Body: editor + preview.
    const body = el('div', 'doc-body');
    const editorWrap = el('div', 'doc-editor-wrap');
    const editor = el('textarea', 'doc-editor');
    editor.id = 'docEditor';
    editor.spellcheck = false;
    editor.setAttribute('autocorrect', 'off');
    editor.setAttribute('autocapitalize', 'off');
    editor.setAttribute('aria-label', IexaI18n.t('doc.body'));
    editorWrap.appendChild(editor);

    const previewWrap = el('div', 'doc-preview-wrap');
    const preview = el('div', 'doc-preview message-content');
    preview.id = 'docPreview';
    preview.setAttribute('aria-label', IexaI18n.t('doc.previewLabel'));
    previewWrap.appendChild(preview);

    body.append(editorWrap, previewWrap);
    page.appendChild(body);

    // Footer: counts + save status.
    const footer = el('div', 'doc-footer');
    const counts = el('span', 'doc-counts', IexaI18n.t('doc.zeroCounts'));
    const status = el('span', 'doc-status', IexaI18n.t('doc.ready'));
    status.id = 'docStatus';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    footer.append(counts, status);
    page.appendChild(footer);

    host.appendChild(page);

    ui = {
      host, title, pathEl, editor, preview, previewWrap, editorWrap,
      counts, status, searchInput, searchCount,
      btnSave, btnSaveAs, btnUndo, btnRedo, btnPreview, btnPrev, btnNext,
    };
    return true;
  }

  // ---- status / dirty ------------------------------------------------------

  function setStatus(tone, text) {
    state.status = { tone, text };
    if (!ui) return;
    ui.status.dataset.tone = tone;
    ui.status.textContent = text;
  }

  function refreshDirty() {
    if (!ui) return;
    const value = ui.editor.value;
    state.dirty = value !== state.savedText;
    ui.host.dataset.dirty = state.dirty ? 'true' : 'false';
    const name = state.name || IexaI18n.t('doc.untitled');
    ui.title.textContent = (state.dirty ? '• ' : '') + name;
    // A copy with no path is still savable even though it is not "modified":
    // otherwise the Save button would be dead on a brand-new document.
    ui.btnSave.disabled = (!state.dirty && Boolean(state.path)) || state.saving;
    ui.btnSaveAs.disabled = state.saving;
    ui.pathEl.textContent = state.path ? state.path : IexaI18n.t('doc.unsaved');
  }

  function refreshCounts() {
    if (!ui) return;
    const value = ui.editor.value;
    // Characters excluding whitespace, plus line count: what a writer expects.
    const chars = value.replace(/\s/g, '').length;
    const lines = value ? value.split('\n').length : 0;
    ui.counts.textContent = IexaI18n.t('doc.counts', { chars, lines });
  }

  function refreshHistoryButtons() {
    if (!ui) return;
    ui.btnUndo.disabled = state.historyIndex <= 0;
    ui.btnRedo.disabled = state.historyIndex >= state.history.length - 1;
  }

  // ---- history -------------------------------------------------------------

  function pushSnapshot(force) {
    if (!ui) return;
    const value = ui.editor.value;
    const top = state.history[state.historyIndex];
    if (top === value) return;
    const now = Date.now();
    // Coalesce rapid keystrokes into one undo step, like a native editor.
    if (!force && top !== undefined && now - state.lastSnapshotAt < SNAPSHOT_DELAY) {
      state.history[state.historyIndex] = value;
      state.lastSnapshotAt = now;
      return;
    }
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(value);
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.historyIndex = state.history.length - 1;
    state.lastSnapshotAt = now;
    refreshHistoryButtons();
  }

  function applyHistory(index) {
    if (!ui || index < 0 || index >= state.history.length) return;
    state.historyIndex = index;
    ui.editor.value = state.history[index];
    refreshDirty();
    refreshCounts();
    refreshHistoryButtons();
    renderPreview();
    scheduleAutosave();
  }

  function undo() { applyHistory(state.historyIndex - 1); }
  function redo() { applyHistory(state.historyIndex + 1); }

  // ---- preview -------------------------------------------------------------

  function renderPreview() {
    if (!ui) return;
    if (ui.previewWrap.hidden) return;
    const source = ui.editor.value;
    const html = window.SafeMarkdown
      ? window.SafeMarkdown.renderSafeMarkdown(source)
      : '';
    ui.preview.innerHTML = html;
    // Charts inside a document go through the same enhancer as the transcript.
    window.IexaChart?.enhance(ui.preview);
  }

  // ---- loading -------------------------------------------------------------

  function loadDocument({ text, path, name, mtimeMs }) {
    if (!ui) return;
    ui.editor.value = text;
    state.path = path || '';
    state.name = name || IexaI18n.t('doc.untitled');
    state.mtimeMs = mtimeMs || 0;
    state.savedText = text;
    state.history = [text];
    state.historyIndex = 0;
    state.lastSnapshotAt = 0;
    state.searchHits = [];
    state.searchIndex = -1;
    if (ui.searchInput) ui.searchInput.value = '';
    if (ui.searchCount) ui.searchCount.textContent = '';
    refreshDirty();
    refreshCounts();
    refreshHistoryButtons();
    renderPreview();
    setStatus('idle', path ? IexaI18n.t('doc.opened') : IexaI18n.t('doc.newUnsaved'));
  }

  function newDocument() {
    loadDocument({ text: '', path: '', name: IexaI18n.t('doc.untitled') });
    setStatus('idle', IexaI18n.t('doc.newDoc'));
    ui?.editor.focus();
  }

  /** Open a message's own markdown as a *copy*: the transcript is untouched. */
  async function openFromMessage(messageEl) {
    if (!messageEl) return;
    // The view has to exist before loadDocument can write into it; init() is
    // idempotent, so calling it here is safe even if the nav already ran.
    navigateToDoc();
    init();
    const index = Number(messageEl.dataset.messageIndex);
    let text = '';
    let title = IexaI18n.t('doc.untitled');
    const contentEl = messageEl.querySelector('.message-content');
    // The live element keeps the exact source; a restored one has to be re-read.
    if (contentEl && typeof contentEl._markdownSource === 'string') text = contentEl._markdownSource;
    if (!text) {
      try {
        const sessionId = typeof currentSessionId === 'string' ? currentSessionId : '';
        const response = await fetch(`${base()}/api/sessions/${encodeURIComponent(sessionId)}`);
        if (!response.ok) throw new Error(IexaI18n.t('doc.sessionLoadFailed'));
        const data = await response.json();
        const message = Number.isInteger(index) ? (data.messages || [])[index] : null;
        if (message && typeof message.content === 'string') text = message.content;
      } catch (error) {
        setStatus('error', IexaI18n.t('doc.readFailed', { error: error.message || error }));
        return;
      }
    }
    if (!text) { setStatus('error', IexaI18n.t('doc.noEditableBody')); return; }
    const sessionTitle = document.querySelector('.session-item.active .session-item-title')?.textContent?.trim();
    if (sessionTitle) title = sessionTitle.slice(0, 40);
    loadDocument({ text, path: '', name: `${title}.md` });
    setStatus('idle', IexaI18n.t('doc.copyCreated'));
    navigateToDoc();
  }

  async function openFile(relPath) {
    const path = String(relPath || '').replace(/\\/g, '/');
    if (!path) return;
    setStatus('idle', IexaI18n.t('doc.opening'));
    try {
      const response = await fetch(`${base()}/api/fs/read?path=${encodeURIComponent(path)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || IexaI18n.t('doc.openFailed'));
      loadDocument({ text: data.content || '', path: data.path || path, name: data.name || path.split('/').pop(), mtimeMs: data.mtimeMs });
      setStatus('ok', '' + IexaI18n.t('doc.opened') + ' ' + (data.path || path));
    } catch (error) {
      setStatus('error', '' + IexaI18n.t('doc.openFailed') + '：' + (error.message || error));
    }
  }

  function navigateToDoc() {
    const nav = document.querySelector('.nav-btn[data-view="doc"]');
    if (nav) nav.click();
  }

  // ---- saving --------------------------------------------------------------

  async function save({ saveAs = false } = {}) {
    if (!ui || state.saving) return;
    let target = state.path;
    if (saveAs || !target) {
      const initial = state.path || state.name || 'document.md';
      const answer = await window.IexaDialogs?.prompt(IexaI18n.t('doc.savePathPrompt'), initial);
      if (!answer) return;
      target = String(answer).trim().replace(/\\/g, '/');
      if (!target) return;
      if (!/\.(md|markdown|txt)$/i.test(target)) target += '.md';
    }
    state.saving = true;
    refreshDirty();
    setStatus('idle', IexaI18n.t('doc.saving'));
    try {
      const response = await fetch(`${base()}/api/fs/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: target,
          content: ui.editor.value,
          expectedMtimeMs: target === state.path ? state.mtimeMs : 0,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || IexaI18n.t('doc.saveFailed', { status: response.status }));
      state.path = data.path || target;
      state.name = data.name || state.path.split('/').pop();
      state.mtimeMs = data.mtimeMs || 0;
      state.savedText = ui.editor.value;
      state.lastSavedAt = Date.now();
      setStatus('ok', IexaI18n.t('doc.savedAt', { time: new Date().toLocaleTimeString(IexaI18n.getLocale(), { hour: '2-digit', minute: '2-digit' }) }));
    } catch (error) {
      // The buffer is never discarded: the user can retry or copy the text out.
      setStatus('error', (error.message || String(error)) + IexaI18n.t('doc.contentKept'));
    } finally {
      state.saving = false;
      refreshDirty();
    }
  }

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (!state.path || !state.dirty) return;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (state.dirty && state.path) void save();
    }, AUTOSAVE_DELAY);
  }

  // ---- search --------------------------------------------------------------

  function runSearch(reset) {
    if (!ui) return;
    const query = ui.searchInput.value;
    if (!query) {
      state.searchHits = [];
      state.searchIndex = -1;
      ui.searchCount.textContent = '';
      return;
    }
    const haystack = ui.editor.value.toLowerCase();
    const needle = query.toLowerCase();
    if (reset || !state.searchHits.length) {
      const hits = [];
      let at = haystack.indexOf(needle);
      while (at !== -1 && hits.length < 2000) { hits.push(at); at = haystack.indexOf(needle, at + needle.length); }
      state.searchHits = hits;
      state.searchIndex = hits.length ? 0 : -1;
    }
    if (!state.searchHits.length) {
      ui.searchCount.textContent = IexaI18n.t('doc.noMatch');
      return;
    }
    if (state.searchIndex < 0) state.searchIndex = 0;
    if (state.searchIndex >= state.searchHits.length) state.searchIndex = 0;
    const start = state.searchHits[state.searchIndex];
    ui.searchCount.textContent = `${state.searchIndex + 1}/${state.searchHits.length}`;
    ui.editor.focus();
    ui.editor.setSelectionRange(start, start + query.length);
    // Bring the match into view without moving the caret's scroll anchor blindly.
    const ratio = start / Math.max(1, ui.editor.value.length);
    ui.editor.scrollTop = Math.max(0, ratio * ui.editor.scrollHeight - ui.editor.clientHeight / 2);
  }

  function stepSearch(direction) {
    if (!state.searchHits.length) { runSearch(true); return; }
    const total = state.searchHits.length;
    state.searchIndex = ((state.searchIndex + direction) % total + total) % total;
    runSearch(false);
  }

  // ---- file picker ---------------------------------------------------------

  function closePicker() {
    document.getElementById('docPicker')?.remove();
  }

  async function listDirectory(rel) {
    const response = await fetch(`${base()}/api/fs/list?path=${encodeURIComponent(rel || '.')}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || IexaI18n.t('doc.listFailed', { status: response.status }));
    return data;
  }

  /** Minimal in-place picker: only directories and Markdown-ish files are listed. */
  function openPicker(startPath) {
    closePicker();
    const overlay = el('div', 'doc-picker-overlay');
    overlay.id = 'docPicker';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', IexaI18n.t('doc.openMarkdown'));

    const panel = el('div', 'doc-picker');
    const head = el('div', 'doc-picker-head');
    const crumb = el('span', 'doc-picker-crumb', IexaI18n.t('doc.projectRoot'));
    const close = el('button', 'doc-icon-btn');
    close.type = 'button';
    close.title = IexaI18n.t('doc.close');
    close.setAttribute('aria-label', IexaI18n.t('doc.close'));
    close.appendChild(icon('close'));
    head.append(crumb, close);
    const list = el('div', 'doc-picker-list');
    list.setAttribute('role', 'listbox');
    panel.append(head, list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    close.focus();

    close.addEventListener('click', closePicker);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closePicker(); });
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      closePicker();
      document.removeEventListener('keydown', onKey, true);
    };
    document.addEventListener('keydown', onKey, true);

    const render = async (rel) => {
      crumb.textContent = rel === '.' ? IexaI18n.t('doc.projectRoot') : rel;
      list.replaceChildren(el('div', 'doc-picker-empty', IexaI18n.t('doc.reading')));
      try {
        const data = await listDirectory(rel);
        const entries = (data.entries || []).filter((entry) =>
          entry.type === 'dir' ? true : /\.(md|markdown|txt)$/i.test(entry.name));
        if (!entries.length) {
          list.replaceChildren(el('div', 'doc-picker-empty', IexaI18n.t('doc.noMarkdown')));
          return;
        }
        const fragment = document.createDocumentFragment();
        if (rel !== '.') {
          const up = el('button', 'doc-picker-row');
          up.type = 'button';
          up.appendChild(el('span', 'doc-picker-name', IexaI18n.t('doc.parent')));
          up.addEventListener('click', () => void render(rel.split('/').slice(0, -1).join('/') || '.'));
          fragment.appendChild(up);
        }
        for (const entry of entries) {
          const row = el('button', 'doc-picker-row');
          row.type = 'button';
          row.dataset.type = entry.type;
          row.appendChild(el('span', 'doc-picker-name', entry.name));
          row.appendChild(el('span', 'doc-picker-meta', entry.type === 'dir'
            ? IexaI18n.t('doc.folder')
            : Math.max(1, Math.round(entry.size / 1024)) + ' KB'));
          row.addEventListener('click', () => {
            if (entry.type === 'dir') void render(entry.path);
            else { closePicker(); void openFile(entry.path); }
          });
          fragment.appendChild(row);
        }
        list.replaceChildren(fragment);
      } catch (error) {
        list.replaceChildren(el('div', 'doc-picker-empty', error.message || String(error)));
      }
    };
    void render(startPath || '.');
  }

  // ---- wiring --------------------------------------------------------------

  function init() {
    if (ready) return;
    if (!build()) return;
    ready = true;

    ui.editor.addEventListener('input', () => {
      if (state.composing) return;
      refreshDirty();
      refreshCounts();
      if (ui.searchInput.value) runSearch(true);
      renderPreview();
      pushSnapshot(false);
      scheduleAutosave();
    });
    // IME: never snapshot or re-render in the middle of a composition.
    ui.editor.addEventListener('compositionstart', () => { state.composing = true; });
    ui.editor.addEventListener('compositionend', () => {
      state.composing = false;
      refreshDirty();
      refreshCounts();
      renderPreview();
      pushSnapshot(true);
      scheduleAutosave();
    });
    ui.editor.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); void save({ saveAs: event.shiftKey }); return; }
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); return; }
      if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); redo(); return; }
      if (key === 'f') { event.preventDefault(); ui.searchInput.focus(); ui.searchInput.select(); }
    });
    // Let the browser's own undo stack stay authoritative for Ctrl+Z inside the
    // textarea; the buttons drive ours, which is why we only intercept above.

    document.getElementById('docNewBtn').addEventListener('click', async () => {
      // A blocking window.confirm is what this project replaced app-wide.
      if (state.dirty && !(await window.IexaDialogs?.confirm(IexaI18n.t('doc.discardConfirm')))) return;
      newDocument();
    });
    document.getElementById('docOpenBtn').addEventListener('click', () => {
      const project = typeof projectRoot !== 'undefined' ? projectRoot : null;
      if (!project) { setStatus('error', IexaI18n.t('doc.noProject')); return; }
      openPicker('.');
    });
    document.getElementById('docSaveBtn').addEventListener('click', () => void save());
    document.getElementById('docSaveAsBtn').addEventListener('click', () => void save({ saveAs: true }));
    ui.btnUndo.addEventListener('click', undo);
    ui.btnRedo.addEventListener('click', redo);
    ui.btnPrev.addEventListener('click', () => stepSearch(-1));
    ui.btnNext.addEventListener('click', () => stepSearch(1));
    ui.searchInput.addEventListener('input', () => runSearch(true));
    ui.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); stepSearch(event.shiftKey ? -1 : 1); }
    });
    ui.btnPreview.addEventListener('click', () => {
      const showing = ui.previewWrap.hidden;
      ui.previewWrap.hidden = !showing;
      ui.editorWrap.hidden = showing;
      ui.btnPreview.setAttribute('aria-pressed', String(showing));
      ui.btnPreview.querySelector('span:last-child').textContent = showing ? IexaI18n.t('doc.edit') : IexaI18n.t('doc.preview');
      if (showing) renderPreview();
      else ui.editor.focus();
    });

    // A first empty document so the view is never blank.
    if (!state.history.length) newDocument();
  }

  window.IexaDoc = Object.freeze({
    init,
    openFromMessage,
    openFile,
    newDocument,
    save,
    openPicker,
    getState: () => ({ ...state, history: undefined }),
  });
})();
