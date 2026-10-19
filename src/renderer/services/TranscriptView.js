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
    const fragment = document.createDocumentFragment();
    const rails = [];
    // Whether the rail will be folded when it lands, not whether this detached
    // group happens to carry the class yet. A folded rail keeps reasoning
    // outside (live does the same), so a turned-off setting is the only case
    // where replay may put reasoning back into the chain. localStorage answers
    // before the appearance fetch resolves.
    const folded = document.documentElement.getAttribute('data-collapse-tools') === 'on'
      || (document.documentElement.getAttribute('data-collapse-tools') === null
        && localStorage.getItem('iexa-collapse-tools') === 'on');
    let rail = null;
    for (const { item, node } of prepared) {
      node.dataset.activityId = item.id;
      if (item.type === 'tool') {
        if (!rail) {
          // Adopt the rail the legacy pass already built (it carries the task
          // bar); otherwise start a fresh one.
          const existing = node.closest('.tool-steps');
          if (existing) {
            existing.querySelectorAll(':scope > .tool-block').forEach(block => block.remove());
            rail = existing;
          } else {
            rail = document.createElement('div');
            rail.className = 'tool-steps activity-list';
          }
          rails.push(rail);
          fragment.appendChild(rail);
        }
        rail.appendChild(node);
      } else if (item.type === 'thinking' && rail && !folded && fragment.lastElementChild === rail) {
        // Live keeps reasoning in the rail only while the chain is open; a
        // folded rail leaves it outside. Replay has to reach the same layout,
        // otherwise the restored turn splits differently from the one the user
        // watched, and the replacement rails used to carry no task bar at all.
        rail.appendChild(node);
      } else {
        fragment.appendChild(node);
        rail = null;
      }
    }
    for (const group of rails) window.IexaToolRail?.attach(group);
    // Capture leftovers only after adopted groups moved into the fragment:
    // removing a group that was reused would drop its first tool row.
    const old = [...element.children].filter(node => node.matches(contentSelector));
    old.forEach(node => node.remove());
    append(element, fragment);
    element.dataset.transcriptState = 'ordered'; element.dataset.transcriptTurnId = message.transcript.turnId;
    return true;
  }
  window.IexaTranscriptView = Object.freeze({ lastNode, append, validate, restore });
})();
