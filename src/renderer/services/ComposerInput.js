(function (root) {
  'use strict';
  root.IexaComposerInput = Object.freeze({
    bind(input) {
      let composing = false;
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; });
      input.addEventListener('blur', () => { composing = false; });
      return Object.freeze({ isComposing: event => composing || event.isComposing || event.keyCode === 229 });
    }
  });
})(window);
