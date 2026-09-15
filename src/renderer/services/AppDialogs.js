/* Nonblocking in-document dialogs: no Chromium alert/confirm/prompt focus trap. */
(function (root) {
  'use strict';
  let tail = Promise.resolve();
  function show(kind, message, initial) {
    const launch = () => new Promise((resolve) => {
      const previous = document.activeElement;
      const selection = previous && typeof previous.selectionStart === 'number'
        ? [previous.selectionStart, previous.selectionEnd, previous.selectionDirection] : null;
      const dialog = document.createElement('dialog');
      dialog.className = 'iexa-app-dialog';
      dialog.setAttribute('aria-label', kind === 'prompt' ? '输入内容' : kind === 'confirm' ? '确认操作' : '提示');
      const label = document.createElement('p'); label.textContent = String(message || '');
      const input = document.createElement('input'); input.type = 'text'; input.value = String(initial ?? '');
      input.setAttribute('aria-label', String(message || '输入内容')); input.autocomplete = 'off';
      const footer = document.createElement('div'); footer.className = 'iexa-app-dialog-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
      const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = '确定'; accept.className = 'btn-primary';
      const negative = kind === 'prompt' ? null : false;
      let settled = false;
      const finish = (value) => {
        if (settled) return; settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (previous?.isConnected && typeof previous.focus === 'function') {
          previous.focus({ preventScroll: true });
          if (selection) previous.setSelectionRange?.(...selection);
        }
        resolve(value);
      };
      const submit = () => finish(kind === 'prompt' ? input.value : true);
      accept.addEventListener('click', submit); cancel.addEventListener('click', () => finish(negative));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(negative); });
      dialog.addEventListener('close', () => finish(negative));
      dialog.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); finish(negative); }
        if (event.key === 'Enter' && event.target === input) { event.preventDefault(); submit(); }
      });
      dialog.append(label); if (kind === 'prompt') dialog.append(input);
      if (kind !== 'alert') footer.append(cancel); footer.append(accept); dialog.append(footer); document.body.append(dialog);
      try { dialog.showModal(); (kind === 'prompt' ? input : kind === 'confirm' ? cancel : accept).focus(); }
      catch { finish(negative); }
    });
    const result = tail.then(launch, launch); tail = result.then(() => {}, () => {}); return result;
  }
  root.IexaDialogs = Object.freeze({ confirm: message => show('confirm', message), alert: message => show('alert', message), prompt: (message, initial) => show('prompt', message, initial) });
})(window);
