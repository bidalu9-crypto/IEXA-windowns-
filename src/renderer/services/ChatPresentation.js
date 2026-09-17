/* Small rendering primitives. Text source lives on the message, never in a clipped preview. */
(() => {
  'use strict';
  function reducedMotion() {
    const mode = document.documentElement.getAttribute('data-motion');
    return mode === 'reduced' || (mode !== 'full' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }
  function foldUser(content, source) {
    const text = String(source || '');
    // Count Unicode code points, not UTF-16 halves. Never truncate the saved source.
    const chars = Array.from(text);
    if (chars.length <= 500) { content.textContent = text; return; }
    const preview = chars.slice(0, 500).join('') + '…';
    const body = document.createElement('span'); body.className = 'user-message-text';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'message-fold-toggle';
    let expanded = false;
    const update = () => {
      body.textContent = expanded ? text : preview;
      toggle.textContent = expanded ? '收起' : `展开全文（${chars.length} 字）`;
      toggle.setAttribute('aria-expanded', String(expanded));
    };
    toggle.addEventListener('click', () => { expanded = !expanded; update(); });
    content.replaceChildren(body, toggle); update();
  }
  function animateSend(message, origin) {
    if (!message?.isConnected || !origin || reducedMotion() || typeof message.animate !== 'function') return;
    // Measure after the composer has collapsed and scroll has settled. Transform
    // the actual bubble, not a duplicate carrying different/cropped message text.
    requestAnimationFrame(() => {
      if (!message.isConnected || reducedMotion()) return;
      const target = message.getBoundingClientRect();
      if (!target.width || !target.height) return;
      const dx = origin.right - target.right, dy = origin.top - target.top;
      const sx = Math.max(.65, Math.min(1.15, origin.width / target.width));
      message.animate([
        { transformOrigin: 'top right', transform: `translate(${dx}px, ${dy}px) scale(${sx}, .94)`, opacity: .65 },
        { transformOrigin: 'top right', transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
  }
  function textGroup(text, animate) {
    const group = document.createElement('span'); group.dataset.streamText = '';
    appendText(group, text, animate); return group;
  }
  function appendText(group, text, animate) {
    if (!text) return;
    if (!animate || reducedMotion()) { group.append(document.createTextNode(text)); return; }
    const span = document.createElement('span'); span.className = 'stream-reveal'; span.textContent = text; group.append(span);
    // CSS animates only the new run. Existing text never flashes or fades again.
    span.addEventListener('animationend', () => { if (span.parentNode === group) { span.replaceWith(document.createTextNode(span.textContent)); group.normalize(); } }, { once: true });
  }
  function compatible(node, next) {
    return next.nodeType === 3 ? node?.nodeType === 1 && node.hasAttribute('data-stream-text')
      : node?.nodeType === next.nodeType && node?.nodeName === next.nodeName && !node?.hasAttribute?.('data-stream-text');
  }
  function patch(parent, fresh, animate) {
    let current = parent.firstChild;
    for (const next of [...fresh.childNodes]) {
      let target = current;
      if (!compatible(target, next)) {
        target = next.nodeType === 3 ? textGroup(next.data, animate) : next.cloneNode(false);
        parent.insertBefore(target, current);
      }
      if (next.nodeType === 3) {
        const previous = target.textContent;
        if (next.data !== previous) {
          if (next.data.startsWith(previous)) appendText(target, next.data.slice(previous.length), animate);
          else { target.replaceChildren(); appendText(target, next.data, animate); }
        }
      } else if (next.nodeType === 1) {
        for (const attr of [...target.attributes]) if (!next.hasAttribute(attr.name)) target.removeAttribute(attr.name);
        for (const attr of [...next.attributes]) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
        patch(target, next, animate);
      }
      current = target.nextSibling;
    }
    while (current) { const following = current.nextSibling; current.remove(); current = following; }
  }
  function renderStream(content, safeHTML) {
    const template = document.createElement('template'); template.innerHTML = safeHTML;
    patch(content, template.content, content.isConnected && document.visibilityState !== 'hidden');
  }
  window.IexaChatPresentation = Object.freeze({ foldUser, animateSend, renderStream, reducedMotion });
})();
