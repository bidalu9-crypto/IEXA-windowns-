// =============================================================================
// Text context menu
//
// Right-click menu for selections and editable fields: copy, paste,
// select-all.
//
// Classic script, extracted verbatim from app.js. Top-level declarations land
// in the global lexical environment, so app.js and the other services keep
// calling these by bare name. index.html fixes the load order; nothing here
// touches the DOM at load time.
// =============================================================================
function initTextContextMenu() {
  const menu = document.getElementById('textContextMenu');
  if (!menu) return;
  const copyItem = menu.querySelector('[data-text-action="copy"]');
  const pasteItem = menu.querySelector('[data-text-action="paste"]');
  let selectedText = '';
  let editor = null;
  let editorSelection = null;

  const isEditable = (el) => el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);

  const close = () => {
    menu.style.display = 'none';
    selectedText = '';
    editor = null;
    editorSelection = null;
  };

  const copyText = async (text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = text;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }
  };

  const insertText = (target, text) => {
    if (!target || !text) return;
    target.focus();
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const start = editorSelection?.start ?? target.selectionStart ?? target.value.length;
      const end = editorSelection?.end ?? target.selectionEnd ?? start;
      target.setRangeText(text, start, end, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (target.isContentEditable) {
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      if (editorSelection?.range) selection.addRange(editorSelection.range);
      document.execCommand('insertText', false, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const placeMenu = (x, y) => {
    menu.style.display = 'flex';
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  };

  document.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.files-context-menu') || event.target.closest('#filesList')) return;
    const target = event.target instanceof Element ? event.target.closest('textarea, input, [contenteditable="true"]') : null;
    const editable = isEditable(target);
    const nativeSelection = window.getSelection();
    const pageSelection = nativeSelection ? nativeSelection.toString().trim() : '';
    const fieldSelection = editable && 'value' in target
      ? String(target.value).slice(target.selectionStart || 0, target.selectionEnd || 0)
      : '';
    const text = fieldSelection || pageSelection;
    if (!text && !editable) return;

    event.preventDefault();
    selectedText = text;
    editor = editable ? target : null;
    editorSelection = null;
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      editorSelection = { start: editor.selectionStart, end: editor.selectionEnd };
    } else if (editor && editor.isContentEditable && nativeSelection?.rangeCount) {
      editorSelection = { range: nativeSelection.getRangeAt(0).cloneRange() };
    }
    copyItem.hidden = !selectedText;
    pasteItem.hidden = !editor;
    placeMenu(event.clientX, event.clientY);
  });

  menu.addEventListener('click', async (event) => {
    const item = event.target.closest('[data-text-action]');
    if (!item) return;
    const action = item.dataset.textAction;
    if (action === 'copy') await copyText(selectedText);
    if (action === 'paste' && editor) {
      try {
        const text = await navigator.clipboard.readText();
        insertText(editor, text);
      } catch {
        editor.focus();
        document.execCommand('paste');
      }
    }
    close();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
}
