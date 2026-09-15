/* Ordered transcript rendering. Old or malformed records keep the legacy view;
   this module never guesses an event order or executes a tool during replay. */
(() => {
  'use strict';
  const contentSelector = '.message-content, .thinking-block, .tool-steps';
  function lastNode(message) { return [...message.children].filter(node => node.matches(contentSelector)).at(-1) || null; }
  function append(message, node) {
    const footer = [...message.children].find(n => n.matches('.assistant-message-footer, .message-usage'));
    if (footer) message.insertBefore(node, footer); else message.appendChild(node);
    return node;
  }
  function validate(message) {
    const t = message.transcript;
    if (!t || t.version !== 1 || t.valid !== true || typeof t.turnId !== 'string' || !t.turnId ||
      !Number.isSafeInteger(t.revision) || t.revision < 0 || !['running','completed','failed','cancelled'].includes(t.status) ||
      !Array.isArray(t.items) || t.items.length > 8192) return null;
    const text = String(message.content || ''), thinking = String(message.thinking || '');
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const byCall = new Map(calls.map(call => [call.id, call]));
    if (byCall.size !== calls.length) return null;
    let textEnd = 0, thinkingEnd = 0; const ids = new Set(), toolIds = new Set();
    for (let i = 0; i < t.items.length; i++) {
      const item = t.items[i];
      if (!item || item.sequence !== i + 1 || typeof item.id !== 'string' || item.id !== `${t.turnId}:${item.sequence}` || ids.has(item.id) ||
          !Number.isFinite(item.timestamp) || item.timestamp < 0) return null;
      ids.add(item.id);
      if (item.type === 'tool') {
        if (!byCall.has(item.callId) || toolIds.has(item.callId) || byCall.get(item.callId).name !== item.name) return null;
        toolIds.add(item.callId);
      } else if (item.type === 'text' || item.type === 'thinking') {
        const previousEnd = item.type === 'text' ? textEnd : thinkingEnd;
        const length = item.type === 'text' ? text.length : thinking.length;
        if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start !== previousEnd || item.end <= item.start || item.end > length ||
            (item.durationMs !== undefined && (!Number.isSafeInteger(item.durationMs) || item.durationMs < 0))) return null;
        if (item.type === 'text') textEnd = item.end; else thinkingEnd = item.end;
      } else return null;
    }
    if (textEnd !== text.length || thinkingEnd !== thinking.length || toolIds.size !== calls.length) return null;
    return t.items;
  }
  function restore(element, message, factories) {
    const items = validate(message);
    if (!items) { element.dataset.transcriptState = message.transcript ? 'invalid' : 'legacy'; return false; }
    const toolRows = new Map([...element.querySelectorAll('.tool-block[data-tool-id]')].map(row => [row.dataset.toolId, row]));
    if (items.some(item => item.type === 'tool' && !toolRows.has(item.callId))) { element.dataset.transcriptState = 'incomplete'; return false; }
    // Build new text/reasoning before touching the existing DOM. A renderer error
    // leaves the readable legacy message intact rather than silently losing data.
    let prepared;
    try {
      prepared = items.map(item => ({ item, node: item.type === 'tool' ? toolRows.get(item.callId)
        : item.type === 'text' ? factories.text(String(message.content || '').slice(item.start, item.end), item)
        : factories.thinking(String(message.thinking || '').slice(item.start, item.end), item) }));
    } catch { element.dataset.transcriptState = 'render-error'; return false; }
    const old = [...element.children].filter(node => node.matches(contentSelector));
    const fragment = document.createDocumentFragment();
    for (const { item, node } of prepared) {
      node.dataset.activityId = item.id;
      if (item.type === 'tool') {
        let group = fragment.lastElementChild;
        if (!group?.classList.contains('tool-steps')) { group = document.createElement('div'); group.className = 'tool-steps activity-list'; fragment.appendChild(group); }
        group.appendChild(node);
      } else fragment.appendChild(node);
    }
    old.forEach(node => node.remove());
    append(element, fragment);
    element.dataset.transcriptState = 'ordered'; element.dataset.transcriptTurnId = message.transcript.turnId;
    return true;
  }
  window.IexaTranscriptView = Object.freeze({ lastNode, append, validate, restore });
})();
