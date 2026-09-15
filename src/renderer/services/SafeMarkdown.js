// All untrusted Markdown must pass this boundary AFTER parsing/highlighting.
// Loaded after the pinned local marked, highlight.js and DOMPurify browser assets.
(function (root) {
  'use strict';
  const { marked, hljs, DOMPurify } = root;
  if (!marked || !hljs || !DOMPurify || !DOMPurify.isSupported) {
    throw new Error('SafeMarkdown requires the local marked, highlight.js and DOMPurify assets');
  }
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  // A private parser prevents unrelated marked.use() calls from changing this boundary.
  const parser = new marked.Marked({ gfm: true, breaks: false, async: false });
  parser.use({ renderer: {
    code({ text, lang }) {
      text = String(text || '');
      const language = String(lang || '').trim().split(/\s+/)[0];
      let html = escape(text);
      if (text.length <= 16000 && language && hljs.getLanguage(language)) {
        try { html = hljs.highlight(text, { language, ignoreIllegals: true }).value; }
        catch { /* Unknown or malformed code remains escaped text. */ }
      }
      return `<pre><code${language ? ` class="language-${escape(language)}"` : ''}>${html}</code></pre>`;
    },
  } });
  const policy = {
    USE_PROFILES: { html: true }, // SVG/MathML are not application UI here.
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option',
      'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'target', 'autofocus', 'tabindex'],
    ALLOW_DATA_ATTR: false, // Do not activate delegated application actions.
    ALLOW_ARIA_ATTR: true,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    RETURN_TRUSTED_TYPE: false,
  };
  function renderSafeMarkdown(source) {
    // Never fall back to unsanitized HTML if either parser or sanitizer fails.
    return DOMPurify.sanitize(parser.parse(String(source ?? '')), policy);
  }
  root.SafeMarkdown = Object.freeze({ renderSafeMarkdown });
})(window);
