// Code preview for the project panel, modelled on the Harness document
// preview: a numbered gutter, a highlighted body, a wrap toggle and a copy
// action, with the language picked from the file name.
//
// Classic script: the only top-level work is defining window.IexaCodePreview.

const CODE_PREVIEW_LANGUAGES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', swift: 'swift', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  bat: 'dos', cmd: 'dos', sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini',
  ini: 'ini', conf: 'ini', md: 'markdown', markdown: 'markdown',
  dockerfile: 'dockerfile', makefile: 'makefile', lua: 'lua', r: 'r', dart: 'dart',
};

// Highlighting a whole file in one go is fine up to here; past it the editor
// stays plain and still scrolls, because tokenising a megabyte would freeze the
// window for seconds.
const CODE_PREVIEW_HIGHLIGHT_LIMIT = 200_000;
const CODE_PREVIEW_LINE_LIMIT = 4000;

(function (root) {
  'use strict';

  const state = {
    path: '',
    name: '',
    content: '',
    wrap: false,
    highlighted: false,
    lines: [],
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function languageFor(name) {
    const file = String(name || '').split('/').pop().toLowerCase();
    if (file === 'dockerfile') return 'dockerfile';
    if (file === 'makefile') return 'makefile';
    const ext = file.includes('.') ? file.split('.').pop() : '';
    return CODE_PREVIEW_LANGUAGES[ext] || '';
  }

  /**
   * Split highlighted HTML into one fragment per source line, reopening the
   * spans that straddle a newline. highlight.js emits multi-line spans around
   * block comments and template literals, so a naive `split('\n')` would leave
   * the rest of the file inside an unterminated tag.
   */
  function splitHighlightedLines(html) {
    const lines = [];
    const stack = [];
    let buffer = '';
    let index = 0;
    const closeAll = () => stack.map(() => '</span>').join('');
    const openAll = () => stack.join('');
    while (index < html.length) {
      const char = html[index];
      if (char === '<') {
        const end = html.indexOf('>', index);
        if (end === -1) { buffer += html.slice(index); break; }
        const tag = html.slice(index, end + 1);
        if (/^<span\b/i.test(tag)) { stack.push(tag); buffer += tag; }
        else if (/^<\/span/i.test(tag)) { stack.pop(); buffer += tag; }
        else buffer += tag;
        index = end + 1;
        continue;
      }
      if (char === '\n') {
        buffer += closeAll();
        lines.push(buffer);
        buffer = openAll();
        index += 1;
        continue;
      }
      buffer += char;
      index += 1;
    }
    buffer += closeAll();
    lines.push(buffer);
    return lines;
  }

  function highlight(text, language) {
    const hljs = root.hljs;
    if (!hljs || !language || !hljs.getLanguage(language)) return null;
    try {
      return splitHighlightedLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
    } catch {
      return null;
    }
  }

  function renderBody(host) {
    host.querySelectorAll(':scope > .code-preview-body, :scope > .code-preview-more').forEach((node) => node.remove());
    const total = state.lines.length;
    const shown = Math.min(total, lineLimit);
    const body = el('div', 'code-preview-body');
    body.dataset.wrap = state.wrap ? 'on' : 'off';

    const highlighted = state.highlighted;
    // One row per source line: the number and the text sit in the same flex
    // row, so wrapped lines keep their number beside the physical line instead
    // of drifting away from a separate gutter column.
    for (let i = 0; i < shown; i += 1) {
      const row = el('div', 'code-preview-row');
      const number = el('span', 'code-preview-line-number', String(i + 1));
      number.setAttribute('aria-hidden', 'true');
      const line = el('span', 'code-preview-line');
      if (highlighted && highlighted[i] !== undefined) line.innerHTML = highlighted[i];
      else line.textContent = state.lines[i];
      row.append(number, line);
      body.appendChild(row);
    }
    host.appendChild(body);

    if (total > shown) {
      const more = el('button', 'code-preview-more', IexaI18n.t('codePreview.showAll', { total }));
      more.type = 'button';
      more.addEventListener('click', () => {
        setLineLimit(Number.MAX_SAFE_INTEGER);
        renderBody(host);
      });
      host.appendChild(more);
    }
  }

  let lineLimit = CODE_PREVIEW_LINE_LIMIT;
  function setLineLimit(value) { lineLimit = value; }

  function buildFrame() {
    const host = document.getElementById('filesPreview');
    if (!host) return null;
    host.dataset.open = 'true';
    host.style.display = 'flex';
    host.replaceChildren();

    const header = el('div', 'code-preview-header');
    const lead = el('div', 'code-preview-lead');
    const nameEl = el('span', 'code-preview-name');
    nameEl.id = 'codePreviewName';
    const metaEl = el('span', 'code-preview-meta');
    metaEl.id = 'codePreviewMeta';
    lead.append(nameEl, metaEl);

    const actions = el('div', 'code-preview-actions');
    const wrap = el('button', 'code-preview-action');
    wrap.type = 'button';
    wrap.id = 'codePreviewWrap';
    wrap.title = IexaI18n.t('codePreview.wrap');
    wrap.setAttribute('aria-label', IexaI18n.t('codePreview.wrap'));
    wrap.setAttribute('aria-pressed', 'false');
    wrap.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#ui-wrap"/></svg>';
    wrap.addEventListener('click', () => {
      state.wrap = !state.wrap;
      wrap.setAttribute('aria-pressed', state.wrap ? 'true' : 'false');
      const body = host.querySelector('.code-preview-body');
      if (body) body.dataset.wrap = state.wrap ? 'on' : 'off';
    });

    const copy = el('button', 'code-preview-action');
    copy.type = 'button';
    copy.id = 'codePreviewCopy';
    copy.title = IexaI18n.t('codePreview.copy');
    copy.setAttribute('aria-label', IexaI18n.t('codePreview.copy'));
    copy.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#ui-copy"/></svg>';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.content);
        copy.classList.add('is-copied');
        setTimeout(() => copy.classList.remove('is-copied'), 1200);
      } catch { /* clipboard can be denied; the text stays selectable */ }
    });

    const open = el('button', 'code-preview-action');
    open.type = 'button';
    open.id = 'codePreviewOpen';
    open.title = IexaI18n.t('codePreview.openExternal');
    open.setAttribute('aria-label', IexaI18n.t('codePreview.openExternal'));
    open.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#ui-external"/></svg>';
    open.addEventListener('click', () => {
      if (state.path && window.iexaDesktop?.openFile) window.iexaDesktop.openFile(state.absolute || state.path);
    });

    const close = el('button', 'code-preview-action');
    close.type = 'button';
    close.id = 'codePreviewClose';
    close.title = IexaI18n.t('codePreview.close');
    close.setAttribute('aria-label', IexaI18n.t('codePreview.close'));
    close.innerHTML = '<svg class="ui-icon" aria-hidden="true"><use href="#ui-close"/></svg>';
    close.addEventListener('click', () => closePreview());

    actions.append(wrap, copy, open, close);
    header.append(lead, actions);
    host.appendChild(header);
    host.tabIndex = -1;
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closePreview();
    });
    return { host, nameEl, metaEl, wrap };
  }

  function open(options) {
    const { path = '', name = '', content = '', absolute = '' } = options || {};
    const frame = buildFrame();
    if (!frame) return;
    state.path = path;
    state.absolute = absolute;
    state.name = name || String(path).split('/').pop() || path;
    state.content = String(content);
    // One trailing newline is an end-of-file marker, not an extra blank line.
    const normalized = state.content.replace(/\r\n/g, '\n').replace(/\n$/, '');
    state.lines = normalized.split('\n');
    setLineLimit(CODE_PREVIEW_LINE_LIMIT);

    const language = languageFor(state.name);
    state.highlighted = state.content.length <= CODE_PREVIEW_HIGHLIGHT_LIMIT
      ? highlight(normalized, language)
      : null;

    frame.nameEl.textContent = state.name;
    frame.nameEl.title = path || state.name;
    const languageLabel = language || IexaI18n.t('codePreview.plainText');
    frame.metaEl.textContent = IexaI18n.t('codePreview.meta', {
      language: languageLabel,
      lines: state.lines.length,
    });
    renderBody(frame.host);
    frame.host.focus({ preventScroll: true });
  }

  function closePreview() {
    const host = document.getElementById('filesPreview');
    if (!host) return;
    host.dataset.open = 'false';
    host.style.display = 'none';
    host.replaceChildren();
  }

  function openPath(relPath, name) {
    return window.openFilePreview ? window.openFilePreview(relPath, name) : undefined;
  }

  root.IexaCodePreview = { open, close: closePreview, openPath, languageFor, _splitHighlightedLines: splitHighlightedLines };
})(typeof window !== 'undefined' ? window : globalThis);
