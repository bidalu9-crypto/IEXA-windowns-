// =============================================================================
// Message and transcript helpers
//
// addMessage, deliverable cards, inline tool results, streaming placeholders
// and the scroll helpers they need.
//
// Classic script. Top-level declarations land in the global lexical scope, so
// app.js and the other services keep calling these by bare name. index.html
// fixes the load order; this file runs nothing when it is evaluated.
// =============================================================================
// A windowed transcript mounts only part of the history, so DOM counts no
// longer describe the conversation. historyTotal is kept by SessionList.
function transcriptNextIndex(consume) {
  const runtime = typeof sessionRuntimes !== 'undefined' && typeof currentSessionId === 'string'
    ? sessionRuntimes.get(currentSessionId) : null;
  if (runtime && Number.isInteger(runtime.historyTotal)) {
    const value = runtime.historyTotal;
    if (consume) runtime.historyTotal = value + 1;
    return value;
  }
  return chatMessages.querySelectorAll('.message:not(.is-queued):not(.is-steering)').length;
}
function addMessage(role, content, attachments, opts) {
  const queued = !!(opts && opts.queued);
  const queueId = (opts && opts.queueId) || '';
  const steering = !!(opts && opts.steering);
  const steerId = (opts && opts.steerId) || '';
  const timestamp = Number(opts && opts.timestamp) > 0 ? Number(opts.timestamp) : Date.now();
  const msg = document.createElement('div');
  msg.className = 'message ' + role + (queued ? ' is-queued' : '') + (steering ? ' is-steering' : '');
  if (queueId) msg.dataset.queueId = queueId;
  if (steerId) msg.dataset.steerId = steerId;
  if (!queued && !steering && (role === 'user' || role === 'assistant')) msg.dataset.timestamp = String(timestamp);
  if (role === 'assistant') {
    msg._assistantText = String(content || '');
    if (opts && Number.isInteger(opts.messageIndex)) msg.dataset.messageIndex = String(opts.messageIndex);
    if (opts && opts.streaming) msg.classList.add('is-streaming');
  }
  if (role === 'user' && !queued && !steering) {
    // Index in the persisted session timeline, used by “重置到此处”.
    const messageIndex = opts && Number.isInteger(opts.messageIndex)
      ? opts.messageIndex
      : transcriptNextIndex(true);
    msg.dataset.messageIndex = String(messageIndex);
  }

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? IexaI18n.t('msg.you') : soulName();

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  if (role === 'user') {
    if (window.IexaChatPresentation) window.IexaChatPresentation.foldUser(contentDiv, content);
    else contentDiv.textContent = content;
  } else {
    contentDiv.innerHTML = renderSafeMarkdown(content || '');
    normalizeRenderedAssets(contentDiv);
    enhanceCodeBlocks(contentDiv);
    enhanceTables(contentDiv);
    window.IexaChart?.enhance(contentDiv);
  }

  msg.appendChild(label);

  if (queued) {
    const badge = document.createElement('div');
    badge.className = 'queued-badge';
    badge.innerHTML = '<span class="queued-badge-icon">⤵</span><span class="queued-badge-text">' + IexaI18n.t('msg.queued') + '</span>';
    if (queueId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'queued-withdraw';
      btn.title = IexaI18n.t('msg.withdrawQueue');
      btn.setAttribute('aria-label', IexaI18n.t('msg.withdrawQueue'));
      btn.innerHTML = uiIcon('close');
      btn.setAttribute('aria-label', IexaI18n.t('msg.removeQueued'));
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        withdrawQueuedMessage(queueId);
      });
      badge.appendChild(btn);
    }
    msg.appendChild(badge);
  }

  if (steering) {
    const badge = document.createElement('div');
    badge.className = 'steer-badge';
    badge.innerHTML = '<span class="steer-badge-icon">↳</span><span class="steer-badge-text">' + IexaI18n.t('msg.steering') + '</span>';
    msg.appendChild(badge);
  }
  if (attachments && attachments.length) {
    const box = document.createElement('div');
    box.className = 'message-attachments';
    for (const a of attachments) {
      const item = document.createElement(a.kind === 'image' && (a.dataUrl || a.previewUrl) ? 'button' : 'div');
      item.className = 'message-attach-item';
      if (a.kind === 'image' && (a.dataUrl || a.previewUrl)) {
        const src = a.dataUrl || a.previewUrl;
        item.type = 'button';
        item.classList.add('message-image-attach');
        const attachName = a.name || IexaI18n.t('msg.imageAttachment');
        item.title = IexaI18n.t('msg.viewImage', { name: attachName });
        item.setAttribute('aria-label', IexaI18n.t('msg.viewImageAria', { name: attachName }));
        item.addEventListener('click', function () {
          openImagePreview(src, attachName, item.querySelector('img'));
        });
        const img = document.createElement('img');
        img.src = src;
        img.alt = a.name || IexaI18n.t('msg.imageAttachment');
        item.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.innerHTML = uiIcon(a.kind === 'text' ? 'file' : 'box');
        item.appendChild(icon);
      }
      const name = document.createElement('span');
      name.className = 'message-attach-name';
      name.textContent = a.name || IexaI18n.t('msg.attachment');
      name.title = a.name || '';
      item.appendChild(name);
      box.appendChild(item);
    }
    msg.appendChild(box);
  }

  msg.appendChild(contentDiv);

  if (role === 'user' && !queued) {
    const actions = document.createElement('div');
    actions.className = 'user-message-actions';
    const timeText = formatMessageTimestamp(timestamp);
    actions.innerHTML = `
      ${timeText ? `<time class="user-message-time" datetime="${new Date(timestamp).toISOString()}" title="${IexaI18n.t('msg.sentAtPrefix')}${new Date(timestamp).toLocaleString()}">${timeText}</time>` : ''}
      <button type="button" class="user-message-action user-message-edit" data-action="edit" title="${IexaI18n.t('msg.edit')}" aria-label="${IexaI18n.t('msg.edit')}">${uiIcon('edit')}</button>
      <button type="button" class="user-message-action user-message-resend" data-action="resend" title="${IexaI18n.t('msg.resend')}" aria-label="${IexaI18n.t('msg.resend')}">${uiIcon('send')}</button>
      <button type="button" class="user-message-action user-message-reset" data-action="reset" title="${IexaI18n.t('msg.resetHere')}" aria-label="${IexaI18n.t('msg.resetHere')}" aria-hidden="false">${uiIcon('branch')}</button>
      <button type="button" class="user-message-action" data-action="copy" title="${IexaI18n.t('msg.copyMessage')}" aria-label="${IexaI18n.t('msg.copyMessage')}">
        ${uiIcon('copy')}
      </button>`;
    actions.querySelector('[data-action="edit"]').addEventListener('click', function () {
      window.startEditingMessage?.(msg);
    });
    actions.querySelector('[data-action="copy"]').addEventListener('click', function () {
      copyUserMessage(content, this);
    });
    actions.querySelector('[data-action="reset"]').addEventListener('click', function () {
      resetConversationToMessage(msg);
    });
    actions.querySelector('[data-action="resend"]').addEventListener('click', function () {
      resendUserMessage(msg, this);
    });
    msg.appendChild(actions);
  }

  if (role === 'assistant') appendAssistantMessageActions(msg);

  if (role === 'assistant' && opts && opts.streaming) {
    // The counter has to exist before the first token arrives, otherwise a turn
    // that stalls for ten seconds shows nothing at all.
    const startedAt = Number(opts.turnStartedAt);
    msg.dataset.turnStartedAt = String(Number.isFinite(startedAt) && startedAt > 0 ? startedAt : timestamp);
    renderMessageUsage(ensureMessageUsage(msg), null, null, undefined, { pending: true });
  }

  chatMessages.appendChild(msg);
  scrollToBottom();
  return msg;
}

function assistantFooterAnchor(messageEl) {
  if (!messageEl) return null;
  return messageEl.querySelector('.assistant-message-footer');
}

function appendAssistantMessageActions(messageEl) {
  if (!messageEl || messageEl.querySelector('.assistant-message-actions')) return;
  const footer = document.createElement('div');
  footer.className = 'assistant-message-footer';
  const actions = document.createElement('div');
  actions.className = 'assistant-message-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', IexaI18n.t('msg.replyActions'));
  actions.innerHTML = `
    <button type="button" class="assistant-message-action" data-action="translate" title="${IexaI18n.t('msg.translateTitle')}" aria-label="${IexaI18n.t('msg.translate')}">${uiIcon('translate')}</button>
    <button type="button" class="assistant-message-action" data-action="copy" title="${IexaI18n.t('msg.copyReply')}" aria-label="${IexaI18n.t('msg.copyReply')}">${uiIcon('copy')}</button>
    <button type="button" class="assistant-message-action" data-action="retry" title="${IexaI18n.t('msg.regenerate')}" aria-label="${IexaI18n.t('msg.regenerate')}">${uiIcon('retry')}</button>
    <button type="button" class="assistant-message-action" data-action="share" title="${IexaI18n.t('msg.share')}" aria-label="${IexaI18n.t('msg.share')}" aria-haspopup="menu" aria-expanded="false">${uiIcon('share')}</button>
    <button type="button" class="assistant-message-action" data-action="doc" title="${IexaI18n.t('msg.openDocTitle')}" aria-label="${IexaI18n.t('msg.openDoc')}">${uiIcon('file')}</button>
    <button type="button" class="assistant-message-action" data-action="speak" title="${IexaI18n.t('msg.speak')}" aria-label="${IexaI18n.t('msg.speak')}" aria-pressed="false">
      <svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path class="speak-play" d="M8.2 5.4a.8.8 0 0 1 1.2-.7l9.1 6.6a.8.8 0 0 1 0 1.4l-9.1 6.6a.8.8 0 0 1-1.2-.7z" fill="currentColor" stroke="none"/><rect class="speak-stop" x="6.6" y="6.6" width="10.8" height="10.8" rx="2.6" fill="currentColor"/></svg>
    </button>`;
  actions.querySelector('[data-action="translate"]').addEventListener('click', function () {
    translateAssistantMessage(messageEl, this);
  });
  actions.querySelector('[data-action="copy"]').addEventListener('click', function () {
    copyAssistantMessage(messageEl, this);
  });
  actions.querySelector('[data-action="retry"]').addEventListener('click', function () {
    retryAssistantMessage(messageEl, this);
  });
  actions.querySelector('[data-action="share"]').addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    window.IexaShare?.open(messageEl, this);
  });
  actions.querySelector('[data-action="doc"]').addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    window.IexaDoc?.openFromMessage(messageEl);
  });
  actions.querySelector('[data-action="speak"]').addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    window.IexaSpeech?.toggle(messageEl, this);
  });
  footer.appendChild(actions);
  messageEl.appendChild(footer);
}

function finalizeAssistantMessage(messageEl) {
  if (!messageEl) return;
  freezeTurnDuration(messageEl);
  flushStreamUpdates(currentSessionId);
  if (messageEl === currentAssistantMsg) renderDeliverables(messageEl, collectLiveDeliverables());
  const followLatest = shouldFollowLatestMessage();
  messageEl.querySelectorAll('.streaming-markdown, .streaming-plain-text').forEach((contentEl) => {
    const source = typeof contentEl._markdownSource === 'string'
      ? contentEl._markdownSource
      : (typeof messageEl._assistantText === 'string' ? messageEl._assistantText : contentEl.textContent || '');
    contentEl.classList.remove('streaming-markdown');
    contentEl.classList.remove('streaming-plain-text');
    renderMarkdownContent(contentEl, source, true);
  });
  messageEl.classList.remove('is-streaming');
  messageEl.querySelectorAll('.assistant-message-action').forEach((button) => { button.disabled = false; });
  // The turn is over: fold its reasoning and tool rails behind one line that
  // carries the elapsed time. Expanding restores them exactly as they were.
  window.IexaTurnSummary?.settle(messageEl);
  if (!document.getElementById('trajectoryView')?.hidden) window.IexaTrajectory?.refresh?.(true);
  scrollToBottom(false, followLatest);
}

function assistantMessageText(messageEl) {
  if (!messageEl) return '';
  if (typeof messageEl._assistantText === 'string') return messageEl._assistantText;
  return Array.from(messageEl.querySelectorAll('.message-content'))
    .filter((node) => node.style.display !== 'none')
    .map((node) => node.innerText || node.textContent || '')
    .filter(Boolean)
    .join('\n\n');
}

async function writeClipboardText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

async function translateAssistantMessage(messageEl, button) {
  if (!messageEl || !button || messageEl.classList.contains('is-streaming')) return;
  const existing = messageEl._translationElement;
  if (existing?.isConnected) {
    const visible = existing.hidden;
    existing.hidden = !visible;
    button.classList.toggle('is-translated', visible);
    button.title = visible ? IexaI18n.t('msg.hideTranslation') : IexaI18n.t('msg.showTranslation');
    button.setAttribute('aria-label', visible ? IexaI18n.t('msg.hideTranslation') : IexaI18n.t('msg.showTranslation'));
    return;
  }

  const source = assistantMessageText(messageEl);
  if (!source.trim()) return;
  button.disabled = true;
  button.classList.add('is-translating');
  button.title = IexaI18n.t('msg.translating');
  button.setAttribute('aria-label', IexaI18n.t('msg.translatingAria'));
  try {
    const response = await fetch(`${API_BASE}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: source, sessionId: currentSessionId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || IexaI18n.t('msg.translateUnavailable'));
    const translated = document.createElement('section');
    translated.className = 'assistant-translation';
    const heading = document.createElement('div');
    heading.className = 'assistant-translation-heading';
    heading.textContent = `${data.direction === 'zh-CN|en' ? IexaI18n.t('msg.englishTranslation') : IexaI18n.t('msg.chineseTranslation')}${IexaI18n.t('msg.currentModelSuffix')}`;
    const content = document.createElement('div');
    content.className = 'assistant-translation-content';
    translated.append(heading, content);
    const footer = messageEl.querySelector('.assistant-message-footer');
    messageEl.insertBefore(translated, footer || null);
    renderMarkdownContent(content, String(data.text || ''), true);
    messageEl._translationElement = translated;
    button.classList.add('is-translated');
    button.title = IexaI18n.t('msg.hideTranslation');
    button.setAttribute('aria-label', IexaI18n.t('msg.hideTranslation'));
  } catch (error) {
    addError(`${IexaI18n.t('msg.translateFailedPrefix')}${error.message || error}`);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.classList.remove('is-translating');
    }
  }
}

async function copyAssistantMessage(messageEl, button) {
  const text = assistantMessageText(messageEl);
  if (!text) return;
  try {
    await writeClipboardText(text);
    button.classList.add('is-copied');
    button.innerHTML = uiIcon('check');
    button.title = IexaI18n.t('msg.copied');
    button.setAttribute('aria-label', IexaI18n.t('msg.copied'));
    setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove('is-copied');
      button.innerHTML = uiIcon('copy');
      button.title = IexaI18n.t('msg.copyReply');
      button.setAttribute('aria-label', IexaI18n.t('msg.copyReply'));
    }, 1300);
  } catch (err) {
    console.error('Failed to copy assistant message:', err);
    addError(IexaI18n.t('msg.copyReplyFailed'));
  }
}

function precedingUserMessage(messageEl) {
  let node = messageEl && messageEl.previousElementSibling;
  while (node) {
    if (node.classList.contains('message') && node.classList.contains('user') && !node.classList.contains('is-queued')) return node;
    node = node.previousElementSibling;
  }
  return null;
}

async function reloadSessionView(sessionId) {
  if (!sessionId || sessionId !== visibleSessionId) return;
  const runtime = sessionRuntimes.get(sessionId);
  if (runtime?.isProcessing) return;
  if (runtime?.currentTaskTimer) window.clearInterval(runtime.currentTaskTimer);
  sessionRuntimes.delete(sessionId);
  currentSessionId = '';
  await switchSession(sessionId, false);
}

async function refreshCurrentSessionHistory(sessionId) {
  if (!sessionId || sessionId !== currentSessionId) return;
  const runtime = sessionRuntimes.get(sessionId);
  if (runtime?.isProcessing || isProcessing) return;
  // During a cold start the first history layout is still being positioned.
  // A metadata refresh can race that work, observe scrollTop=0, and restore
  // the top of the transcript after reload. Keep the startup latest-position
  // operation authoritative instead of preserving that transient value.
  const positioningHistory = visibleChatMessages.classList.contains('is-positioning-history');
  const forceHistoryLatest = runtime?.forceHistoryLatest === true;
  const keepAtBottom = isChatNearBottom();
  const savedScrollTop = visibleChatMessages.scrollTop;
  await reloadSessionView(sessionId);
  if (sessionId !== currentSessionId) return;
  if (positioningHistory || keepAtBottom || forceHistoryLatest) scrollHistoryToLatest(sessionId);
  else {
    visibleChatMessages.scrollTop = savedScrollTop;
    isNearChatBottom = isChatNearBottom();
    updateScrollToBottomButton();
  }
}

async function retryAssistantMessage(messageEl, button) {
  if (!messageEl || !button || isProcessing || !currentSessionId) return;
  const userEl = precedingUserMessage(messageEl);
  const messageIndex = Number(userEl && userEl.dataset.messageIndex);
  if (!Number.isInteger(messageIndex) || messageIndex < 0) {
    addError(IexaI18n.t('msg.noPromptForReply'));
    return;
  }

  const sessionId = currentSessionId;
  button.disabled = true;
  button.classList.add('is-retrying');
  button.title = IexaI18n.t('msg.regenerating');
  button.setAttribute('aria-label', IexaI18n.t('msg.regenerating'));
  try {
    const sessionResponse = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
    const sessionData = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok) throw new Error(sessionData.error || IexaI18n.t('msg.loadSessionFailed'));
    const source = Array.isArray(sessionData.messages) ? sessionData.messages[messageIndex] : null;
    if (!source || source.role !== 'user') throw new Error(IexaI18n.t('msg.noPromptForReplyBare'));

    const prompt = String(source.content || '');
    const attachments = cloneAttachments(source.attachments || []);
    const displayText = prompt || (attachments.length ? IexaI18n.t('msg.attachmentsInline', { names: attachments.map((item) => item.name).join(IexaI18n.t('common.listSeparator')) }) : '');
    const resetResponse = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex, retainSelected: false }),
    });
    const resetData = await resetResponse.json().catch(() => ({}));
    if (!resetResponse.ok) throw new Error(resetData.error || IexaI18n.t('msg.resetBeforeRetryFailed'));

    await reloadSessionView(sessionId);
    window.dismissWelcome?.();
    addMessage('user', displayText, attachments, { timestamp: Date.now() });
    suppressQueueDrain = false;
    await runChatTurn(prompt || displayText, displayText, attachments, { fromRetry: true });
  } catch (err) {
    if (currentSessionId === sessionId) addError(err.message || IexaI18n.t('msg.regenerateFailed'));
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.classList.remove('is-retrying');
      button.title = IexaI18n.t('msg.regenerate');
      button.setAttribute('aria-label', IexaI18n.t('msg.regenerate'));
    }
  }
}

async function copyUserMessage(content, button) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(content || '');
    } else {
      const area = document.createElement('textarea');
      area.value = content || '';
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    button.classList.add('is-copied');
    button.title = IexaI18n.t('msg.copied');
    setTimeout(() => {
      button.classList.remove('is-copied');
      button.title = IexaI18n.t('msg.copyMessage');
    }, 1300);
  } catch (err) {
    console.error('Failed to copy message:', err);
  }
}

/**
 * Resolve a user message element to its index in the persisted session timeline.
 *
 * `dataset.messageIndex` is only a hint: it is derived from a DOM counter for
 * freshly sent messages, and that counter drifts as soon as a cancelled or
 * failed turn leaves an assistant placeholder behind. The persisted session is
 * authoritative, so match by timestamp first, then by content, and only fall
 * back to the DOM hint when it still points at a user message.
 */
async function resolvePersistedUserIndex(sessionId, userEl, content) {
  const domIndex = Number(userEl && userEl.dataset.messageIndex);
  const domHint = Number.isInteger(domIndex) && domIndex >= 0 ? domIndex : -1;
  try {
    const resp = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !Array.isArray(data.messages)) return domHint;
    const messages = data.messages;

    // Prefer the user entry whose timestamp matches the rendered bubble.
    const stamp = Number(userEl && userEl.dataset.timestamp);
    if (Number.isInteger(stamp) && stamp > 0) {
      const exact = messages.findIndex((m) => m.role === 'user' && Number(m.timestamp) === stamp);
      if (exact >= 0) return exact;
    }

    // Otherwise match on content, choosing the occurrence closest to the hint
    // so repeated prompts resolve to the bubble the user actually clicked.
    const text = String(content || '').trim();
    if (text) {
      const matches = [];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'user' && String(m.content || '').trim() === text) matches.push(i);
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        if (domHint < 0) return matches[matches.length - 1];
        return matches.reduce((best, cur) => (Math.abs(cur - domHint) < Math.abs(best - domHint) ? cur : best));
      }
    }

    if (domHint >= 0 && domHint < messages.length && messages[domHint].role === 'user') return domHint;
    return -1;
  } catch {
    return domHint;
  }
}

async function resetConversationToMessage(messageEl) {
  if (!messageEl || !currentSessionId) return;
  if (!(await window.IexaDialogs.confirm(IexaI18n.t('msg.resetConfirm')))) return;

  const content = String(messageEl.querySelector('.message-content')?.innerText || '').trim();
  const sessionId = currentSessionId;
  const messageIndex = await resolvePersistedUserIndex(sessionId, messageEl, content);
  if (!Number.isInteger(messageIndex) || messageIndex < 0) {
    addError(IexaI18n.t('msg.noMessagePosition'));
    return;
  }
  if (currentSessionId !== sessionId) return;

  // A reset is a hard branch point: stop the live request and drop queued prompts.
  suppressQueueDrain = true;
  promptQueue = [];
  if (isProcessing) await stopProcessing();

  try {
    const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || IexaI18n.t('msg.resetFailed'));
    // Trim the visible transcript in place instead of refetching the whole
    // session: a full reload flashes the "正在加载对话…" placeholder and can
    // strand it when a metadata refresh bumps the view epoch mid-flight.
    truncateTranscriptFrom(messageEl, true);
    resetTurnBookkeeping();
    // The conversation is shorter now; its measured request size is gone too.
    applySessionContextStatus(currentSessionId, null);
    scrollToBottom(true);
  } catch (err) {
    addError(err.message || IexaI18n.t('msg.resetConversationFailed'));
  } finally {
    suppressQueueDrain = false;
  }
}

/**
 * Re-send a previous user message as a fresh turn.
 *
 * Unlike the assistant-side "重新生成" (which rewrites the last answer in place),
 * this truncates the session to the selected prompt and replays it, so the user
 * can branch a conversation from any earlier question.
 */
async function resendUserMessage(messageEl, button) {
  if (!messageEl || !currentSessionId) return;
  if (isProcessing) {
    addError(IexaI18n.t('msg.busyResend'));
    return;
  }

  const content = String(messageEl.querySelector('.message-content')?.innerText || '').trim();
  const sessionId = currentSessionId;
  const messageIndex = await resolvePersistedUserIndex(sessionId, messageEl, content);
  if (!Number.isInteger(messageIndex) || messageIndex < 0) {
    addError(IexaI18n.t('msg.noMessagePosition'));
    return;
  }
  if (currentSessionId !== sessionId) return;

  if (button) {
    button.disabled = true;
    button.classList.add('is-retrying');
    button.title = IexaI18n.t('msg.resending');
    button.setAttribute('aria-label', IexaI18n.t('msg.resending'));
  }

  // Hard branch point: drop queued prompts and stop any live request first.
  suppressQueueDrain = true;
  promptQueue = [];
  if (isProcessing) await stopProcessing();

  try {
    const sessionResponse = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
    const sessionData = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok) throw new Error(sessionData.error || IexaI18n.t('msg.loadSessionFailed'));
    const source = Array.isArray(sessionData.messages) ? sessionData.messages[messageIndex] : null;
    if (!source || source.role !== 'user') throw new Error(IexaI18n.t('msg.noPromptForMessage'));

    const prompt = String(source.content || '');
    const attachments = cloneAttachments(source.attachments || []);
    const displayText = prompt || (attachments.length ? IexaI18n.t('msg.attachmentsInline', { names: attachments.map((item) => item.name).join(IexaI18n.t('common.listSeparator')) }) : '');

    const resetResponse = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex, retainSelected: false }),
    });
    const resetData = await resetResponse.json().catch(() => ({}));
    if (!resetResponse.ok) throw new Error(resetData.error || IexaI18n.t('msg.resetBeforeResendFailed'));

    // Truncate in place rather than reloadSessionView(): the heavy reload mounts
    // the "正在加载对话…" placeholder and can strand it when a concurrent
    // metadata sync bumps the view epoch while the fetch is in flight.
    truncateTranscriptFrom(messageEl, false);
    window.dismissWelcome?.();
    resetTurnBookkeeping();
    addMessage('user', displayText, attachments, { timestamp: Date.now() });
    suppressQueueDrain = false;
    await runChatTurn(prompt || displayText, displayText, attachments, { fromRetry: true });
  } catch (err) {
    suppressQueueDrain = false;
    if (currentSessionId === sessionId) addError(err.message || IexaI18n.t('msg.resendFailed'));
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.classList.remove('is-retrying');
      button.title = IexaI18n.t('msg.resend');
      button.setAttribute('aria-label', IexaI18n.t('msg.resend'));
    }
  }
}

/* Transcript notices: compact, auto-dismissing, and capped so a burst of errors
 * cannot push the conversation off screen. The lifetime is a constant so the
 * countdown bar and the timer cannot drift apart. */
const ERROR_NOTICE_LIFETIME_MS = 10_000;
const ERROR_NOTICE_LIMIT = 3;

function dismissErrorNotice(err) {
  if (!err || err.dataset.leaving === '1') return;
  err.dataset.leaving = '1';
  if (err._noticeTimer) { clearTimeout(err._noticeTimer); err._noticeTimer = null; }
  err.classList.add('is-leaving');
  const reduced = document.documentElement.dataset.motion === 'reduced'
    || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  setTimeout(() => err.remove(), reduced ? 0 : 180);
}

function armErrorNotice(err) {
  err.style.setProperty('--notice-life', ERROR_NOTICE_LIFETIME_MS + 'ms');
  let remaining = ERROR_NOTICE_LIFETIME_MS;
  let startedAt = 0;
  const pause = () => {
    if (!err._noticeTimer) return;
    clearTimeout(err._noticeTimer);
    err._noticeTimer = null;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
    err.classList.add('is-paused');
  };
  const resume = () => {
    if (err._noticeTimer || err.dataset.leaving === '1') return;
    startedAt = Date.now();
    err.classList.remove('is-paused');
    err._noticeTimer = setTimeout(() => dismissErrorNotice(err), remaining);
  };
  // Reading a message takes time: holding the pointer over it, or focusing the
  // close button, stops the clock instead of pulling the text away mid-read.
  err.addEventListener('pointerenter', pause);
  err.addEventListener('pointerleave', resume);
  err.addEventListener('focusin', pause);
  err.addEventListener('focusout', resume);
  resume();
}

function addError(message) {
  const err = document.createElement('div');
  err.className = 'error-message';
  err.setAttribute('role', 'alert');
  err.innerHTML = uiIcon('alert')
    + '<span class="error-message-text">' + escapeHtml(message) + '</span>'
    + '<button type="button" class="error-message-close" aria-label="' + IexaI18n.t('msg.closeNotice') + '" title="' + IexaI18n.t('msg.close') + '">' + uiIcon('close') + '</button>';
  const text = err.querySelector('.error-message-text');
  if (text) text.title = String(message);
  err.querySelector('.error-message-close')?.addEventListener('click', () => dismissErrorNotice(err));

  // Oldest first: the newest failure is the one worth reading.
  const existing = [...chatMessages.querySelectorAll(':scope > .error-message')];
  for (const stale of existing.slice(0, Math.max(0, existing.length - (ERROR_NOTICE_LIMIT - 1)))) {
    dismissErrorNotice(stale);
  }

  chatMessages.appendChild(err);
  armErrorNotice(err);
  scrollToBottom();
}

/* Status line: the busy ellipsis is rendered as three rippling dots, so the
 * text must never carry its own dots. Every writer goes through here. */
function setStatusText(text) {
  const el = document.getElementById('statusText');
  if (!el) return;
  const raw = String(text == null ? '' : text);
  const busy = /(处理中|Working|Pausing|正在停止|继续中|Resuming)/i.test(raw);
  // The footer shares ~240px with the version pill. A queue count written out
  // in full would truncate the label, so it collapses to a compact suffix and
  // the full sentence stays in the tooltip.
  el.textContent = raw
    .replace(/\s*(?:\.{2,}|…)\s*/g, '')
    .replace(/[（(]\s*(\d+)\s*(?:条待发送|queued[^)）]*)\s*[)）]/i, ' · $1')
    .trim();
  el.title = raw;
  el.classList.toggle('is-busy', busy);
  const dots = document.getElementById('statusDots');
  if (dots) dots.hidden = !busy;
}
function isChatNearBottom() {
  return visibleChatMessages.scrollHeight - visibleChatMessages.scrollTop - visibleChatMessages.clientHeight < 72;
}

function shouldFollowLatestMessage() {
  if (currentSessionId !== visibleSessionId) return false;
  return isNearChatBottom || (!isChatUserScrollActive() && isChatNearBottom());
}

function updateScrollToBottomButton() {
  if (!scrollToBottomBtn) return;
  if (currentSessionId !== visibleSessionId) return;
  const hasOverflow = visibleChatMessages.scrollHeight > visibleChatMessages.clientHeight + 4;
  scrollToBottomBtn.style.display = (!isNearChatBottom && hasOverflow) ? 'flex' : 'none';
}

/** Keep streaming content visible only while the user is already reading the latest messages. */
let chatScrollFrame = null;
let chatBottomFollowRequested = false;
let chatProgrammaticScroll = false;
let chatPointerScrollActive = false;
let chatTouchScrollActive = false;
let chatWheelScrollActive = false;
let chatWheelScrollTimer = null;

function beginChatWheelScroll() {
  chatWheelScrollActive = true;
  if (chatWheelScrollTimer) window.clearTimeout(chatWheelScrollTimer);
  chatWheelScrollTimer = window.setTimeout(() => {
    chatWheelScrollActive = false;
    chatWheelScrollTimer = null;
  }, 180);
}

function isChatUserScrollActive() {
  return chatPointerScrollActive || chatTouchScrollActive || chatWheelScrollActive;
}

function stopFollowingLatestMessage() {
  isNearChatBottom = false;
  chatBottomFollowRequested = false;
  if (currentSessionId) {
    const runtime = typeof runtimeForSession === 'function' ? runtimeForSession(currentSessionId) : null;
    if (runtime) {
      runtime.historyFollowLatestUntil = 0;
      runtime.forceHistoryLatest = false;
    }
    if (typeof cancelHistoryScrollPositioning === 'function') cancelHistoryScrollPositioning();
    if (typeof historyScrollGeneration !== 'undefined') historyScrollGeneration += 1;
  }
  updateScrollToBottomButton();
}

function scrollToBottom(force, followLatest) {
  if (currentSessionId !== visibleSessionId) return;
  const shouldFollow = force || followLatest === true || (followLatest === undefined && isNearChatBottom);
  if (force) isNearChatBottom = true;
  if (shouldFollow) chatBottomFollowRequested = true;
  if (chatScrollFrame !== null) return;
  chatScrollFrame = requestAnimationFrame(() => {
    chatScrollFrame = null;
    const followThisFrame = chatBottomFollowRequested;
    chatBottomFollowRequested = false;
    if (followThisFrame) {
      chatProgrammaticScroll = true;
      visibleChatMessages.scrollTop = visibleChatMessages.scrollHeight;
      isNearChatBottom = true;
      requestAnimationFrame(() => {
        chatProgrammaticScroll = false;
        if (isChatNearBottom()) isNearChatBottom = true;
        updateScrollToBottomButton();
      });
    }
    updateScrollToBottomButton();
  });
}

// All transcript scroll / follow-latest wiring. Called once from app.js init().
function initTranscriptScroll() {
  visibleChatMessages.addEventListener('scroll', function () {
    // A deactivated view is zero-sized, so the browser clamps its scrollTop to 0
    // and fires a scroll event. That is a layout artifact, not a user scroll;
    // letting it through would overwrite the remembered position.
    if (!chatViewIsActive()) return;
    const nearBottom = isChatNearBottom();
    if (isChatUserScrollActive() && !chatProgrammaticScroll) {
      isNearChatBottom = nearBottom;
      if (!nearBottom && currentSessionId) {
        const runtime = typeof runtimeForSession === 'function' ? runtimeForSession(currentSessionId) : null;
        if (runtime) runtime.forceHistoryLatest = false;
      }
      if (!nearBottom) chatBottomFollowRequested = false;
    } else if (nearBottom) {
      // Layout changes must not disable follow-latest, but any route back to the
      // bottom should re-enable it.
      isNearChatBottom = true;
    }
    updateScrollToBottomButton();
  }, { passive: true });

  visibleChatMessages.addEventListener('wheel', function (event) {
    beginChatWheelScroll();
    if (event.deltaY < 0) stopFollowingLatestMessage();
  }, { passive: true });

  visibleChatMessages.addEventListener('pointerdown', () => { chatPointerScrollActive = true; }, { passive: true });
  visibleChatMessages.addEventListener('touchstart', () => { chatTouchScrollActive = true; }, { passive: true });
  document.addEventListener('pointerup', () => { chatPointerScrollActive = false; }, { passive: true });
  document.addEventListener('pointercancel', () => { chatPointerScrollActive = false; }, { passive: true });
  document.addEventListener('touchend', () => { chatTouchScrollActive = false; }, { passive: true });
  document.addEventListener('touchcancel', () => { chatTouchScrollActive = false; }, { passive: true });

  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener('click', function () {
      scrollToBottom(true);
    });
  }
}

function setProcessing(processing) {
  isProcessing = !!processing;
  const runtime = currentSessionId ? runtimeForSession(currentSessionId) : null;
  if (runtime) runtime.isProcessing = isProcessing;
  chatMessages.querySelectorAll('.assistant-message-action[data-action="retry"]').forEach((button) => {
    button.disabled = isProcessing;
  });
  // A background task may finish while another conversation is visible. Keep
  // its state, but leave the selected composer's controls untouched.
  if (currentSessionId !== visibleSessionId) return;
  // The empty-state hint swaps its static tips for shortcuts while a turn runs.
  window.IexaComposerHint?.refresh?.();
  // iOS: input stays editable while processing so user can insert follow-ups.
  // Stop is always available during a run; send becomes "queue" mode.
  stopBtn.style.display = processing ? 'flex' : 'none';
  sendBtn.style.display = processing ? 'none' : 'flex';
  sendBtn.disabled = false;
  chatInput.disabled = false;
  if (typeof attachBtn !== 'undefined' && attachBtn) attachBtn.disabled = false;

  if (processing) {
    statusDot.className = 'status-dot processing';
    const qn = promptQueue.filter((p) => p.sessionId === currentSessionId).length;
    setStatusText(qn > 0 ? IexaI18n.t('msg.processingQueued', { count: qn }) : IexaI18n.t('msg.processing'));
  } else {
    statusDot.className = 'status-dot';
    setStatusText(IexaI18n.t('msg.ready'));
  }
  updateComposerForQueue();
  if (!processing) window.IexaTrajectory?.refreshIfVisible?.();
  if (currentSessionId) {
    renderSessionList();
  }
  if (!processing && pendingCurrentSessionSync && currentSessionId === visibleSessionId) {    pendingCurrentSessionSync = false;
    const completedSessionId = currentSessionId;
    window.setTimeout(() => { if (visibleSessionId === completedSessionId) syncConversationMetadata(true, completedSessionId); }, 0);
  }
}

function toggleToolBody(id) {
  const body = document.getElementById(id);
  if (body) {
    const open = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    body.closest('.tool-block')?.classList.toggle('is-expanded', open);
  }
}
