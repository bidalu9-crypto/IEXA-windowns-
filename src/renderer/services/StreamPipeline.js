// Streaming turn pipeline — split out of app.js.
// SSE dispatch, text/thinking deltas, permission and question prompts.
// All state lives in app.js or in this file at call time; nothing runs on load.
//
// Classic script: top-level declarations join the same global scope as
// app.js, so callers keep working unchanged. Keep this file free of load-time
// side effects — it evaluates before app.js and before the DOM is ready.

// =============================================================================
// SSE Event Handling
// =============================================================================

const pendingStreamUpdates = new Map();

function flushStreamUpdates(sessionId) {
  const pending = pendingStreamUpdates.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  clearTimeout(pending.fallback);
  if (pending.frame) cancelAnimationFrame(pending.frame);
  pendingStreamUpdates.delete(sessionId);
  withSessionRuntime(sessionId, () => {
    if (pending.turnToken !== activeChatTurnToken) return;
    for (const { event, data } of pending.events) {
      if (event === 'text') handleTextDelta(data.content);
      else if (event === 'thinking') handleThinkingDelta(data.content);
      else handleToolInput(data.name, data.args, data.id);
    }
    snapshotActiveSessionRuntime();
  });
}

function queueStreamUpdate(event, data, turnToken) {
  const sessionId = currentSessionId;
  let pending = pendingStreamUpdates.get(sessionId);
  if (pending && pending.turnToken !== turnToken) {
    clearTimeout(pending.timer);
    clearTimeout(pending.fallback);
    if (pending.frame) cancelAnimationFrame(pending.frame);
    pendingStreamUpdates.delete(sessionId);
    pending = null;
  }
  if (!pending) {
    pending = { turnToken, events: [] };
    if (sessionId === visibleSessionId && document.visibilityState !== 'hidden') {
      pending.timer = setTimeout(() => {
        pending.frame = requestAnimationFrame(() => flushStreamUpdates(sessionId));
      }, 32);
      // Hidden tabs may suspend animation frames after the timer was scheduled.
      pending.fallback = setTimeout(() => flushStreamUpdates(sessionId), 400);
    } else pending.timer = setTimeout(() => flushStreamUpdates(sessionId), 400);
    pendingStreamUpdates.set(sessionId, pending);
  }
  if (event === 'text') pending.text = data.content; // cumulative baseline for text_delta transport
  const last = pending.events[pending.events.length - 1];
  const same = last?.event === event && (event !== 'tool_input' || (last.data.id || last.data.name) === (data.id || data.name));
  if (same) last.data = event === 'thinking' ? { ...data, content: String(last.data.content || '') + String(data.content || '') } : { ...data };
  else pending.events.push({ event, data: { ...data } });
  if (pending.events.length >= 128) flushStreamUpdates(sessionId);
}

/** Desktop notification only while the window is not visible. */
function notifyIfHidden(title, body) {
  try {
    if (document.visibilityState === 'visible') return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') { Notification.requestPermission().catch(() => {}); return; }
    if (Notification.permission !== 'granted') return;
    const notification = new Notification(title, { body, silent: false });
    notification.onclick = () => { try { window.focus(); } catch { /* window may be gone */ } notification.close(); };
  } catch { /* notifications are optional */ }
}

function handleSSEEvent(raw, turnToken) {
  const lines = raw.split('\n');
  let eventType = '';
  let dataStr = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.substring(7);
    } else if (line.startsWith('data: ')) {
      dataStr = line.substring(6);
    }
  }

  if (!eventType || !dataStr) return;

  try {
    const data = JSON.parse(dataStr);
    if (turnToken != null && turnToken !== activeChatTurnToken) return;
    if (eventType === 'text_delta') {
      const previous = pendingStreamUpdates.get(currentSessionId)?.text ?? currentAssistantMsg?._assistantText ?? '';
      data.content = (data.reset ? '' : previous) + (data.content || '');
      eventType = 'text';
    }
    if (['text', 'thinking', 'tool_input'].includes(eventType)) {
      queueStreamUpdate(eventType, data, activeChatTurnToken);
      return;
    }
    flushStreamUpdates(currentSessionId);

    switch (eventType) {
      case 'text':
        handleTextDelta(data.content);
        break;
      case 'turn_started': {
        const level = normalizeThinkingLevel(data.thinkingLevel || currentThinkingLevel);
        if (currentAssistantMsg) {
          currentAssistantMsg.dataset.thinkingLevel = level;
          if (typeof data.transcriptTurnId === 'string') currentAssistantMsg.dataset.transcriptTurnId = data.transcriptTurnId;
        }
        break;
      }
      case 'thinking':
        handleThinkingDelta(data.content);
        break;
      case 'tool_start':
        handleToolStart(data.id, data.name);
        break;
      case 'tool_input':
        handleToolInput(data.name, data.args, data.id);
        break;
      case 'tool_complete':
        handleToolComplete(data.id, data.name, data.args);
        break;
      case 'tool_state': {
        if (data.status !== 'awaiting_approval') window.IexaPermissionDialog.closeForTool?.(data.sessionId, data.id, data.runId);
        if (data.name === 'ask_user' && ['completed', 'failed', 'denied', 'cancelled', 'timed_out'].includes(data.status)) {
          window.IexaQuestionCard?.applyToolState?.(data.id, data.status);
        }
        const info = currentToolBlocks[data.id];
        if (info) window.IexaToolLifecycleView.apply(info.block, data, setToolStepStatus);
        break;
      }
      case 'tool_result':
        handleToolResult(data.id, data.output, data.success, data.todos, data.fileChange, data.imageData, data.imageMimeType, data.artifacts, data.executionStatus, data.durationMs, data.pluginUI, data.metadata);
        break;
      case 'context':
        handleContextStatus(data);
        break;
      case 'usage':
        handleUsage(data);
        break;
      case 'job':
        applyJobUpdate(data);
        break;
      case 'retry':
        handleRetry(data);
        break;
      case 'permission_required':
        showPermissionDialog(data);
        notifyIfHidden('IEXA 需要你的批准', '有工具调用正在等待审批');
        break;
      case 'question_required':
        showQuestionCard(data);
        break;
      case 'error':
        handleError(data.message, turnToken);
        break;
      case 'session_title':
        handleSessionTitle(data.sessionId, data.title, data.category);
        break;
      case 'done':
        handleDone(data.stopReason, turnToken);
        notifyIfHidden('IEXA 任务完成', data.stopReason === 'cancelled' ? '本轮任务已取消' : '本轮处理已完成');
        break;
      case 'cancelled':
        handleCancelled(turnToken);
        break;
    }
  } catch (e) {
    // Skip parse errors for partial chunks
  }
}

function showPermissionDialog(data) {
  subAgentView?.dismiss();
  window.IexaPermissionDialog.show(data, { apiBase: API_BASE, onError: addError });
}

/** Mount an ask_user card inside the live transcript, right after its tool step. */
function mountQuestionCard(el, data) {
  const info = data && data.toolCallId ? currentToolBlocks[data.toolCallId] : null;
  const host = info?.block?.closest('.tool-steps');
  if (host) {
    host.appendChild(el);
    return;
  }
  try {
    ensureToolStepsHost().appendChild(el);
  } catch {
    const msg = ensureAssistantMessage();
    window.IexaTranscriptView.append(msg, el);
  }
}

function questionCardOptions() {
  return {
    apiBase: API_BASE,
    onError: addError,
    scrollToBottom: () => scrollToBottom(),
    mount: mountQuestionCard,
  };
}

function showQuestionCard(data) {
  if (!window.IexaQuestionCard) return;
  hideWaitingIndicator();
  window.IexaQuestionCard.show(data, questionCardOptions());
  const info = data && data.toolCallId ? currentToolBlocks[data.toolCallId] : null;
  if (info) setToolStepStatus(info.block, 'streaming', '等待用户作答');
}

function handleRetry(data) {
  if (!currentAssistantMsg) return;
  const attempt = Number(data && data.attempt) || 1;
  const delayMs = Number(data && data.delayMs) || 0;
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  beginTaskSummary(`网关暂时不可用，${seconds} 秒后重试（第 ${attempt} 次）`);
  currentAssistantMsg.querySelectorAll('.tool-block').forEach((block) => {
    if (!block.classList.contains('is-done') && !block.classList.contains('is-error')) {
      setToolStepStatus(block, 'streaming', '等待重试');
    }
  });
  scrollToBottom();
}

/** Content block that should receive the latest model text (under tools when present). */
function ensureAnswerContentEl() {
  const msg = ensureAssistantMessage();
  const last = window.IexaTranscriptView.lastNode(msg);
  if (last?.classList.contains('message-content')) {
    if (!Number.isInteger(last._textStart)) last._textStart = 0;
    return last;
  }
  const content = document.createElement('div');
  content.className = 'message-content message-answer';
  content._textStart = String(msg._assistantText || '').length;
  window.IexaTranscriptView.append(msg, content);
  return content;
}

function renderMarkdownContent(contentEl, markdown, finalRender = false) {
  if (!contentEl) return;
  const source = String(markdown || '');
  contentEl._markdownSource = source;

  // SSE events are already batched. Only rebuild when the source changed so
  // terminal events can enhance the existing DOM without a visible reflow.
  if (contentEl._renderedMarkdownSource !== source || (finalRender && !contentEl._renderedMarkdownFinal)) {
    // Avoid rerunning syntax highlighting over all growing code blocks per SSE delta.
    // Finalization adds highlighting exactly once, even when the text is unchanged.
    if (!finalRender && window.IexaChatPresentation) {
      window.IexaChatPresentation.renderStream(contentEl, renderSafeMarkdown(source, { highlight: false }));
    } else contentEl.innerHTML = renderSafeMarkdown(source, { highlight: finalRender });
    contentEl._renderedMarkdownFinal = finalRender;
    contentEl._renderedMarkdownSource = source;
    normalizeRenderedAssets(contentEl);
  }

  if (finalRender) {
    enhanceCodeBlocks(contentEl);
    enhanceTables(contentEl);
    return;
  }

  // Images can increase the rendered height after the current SSE frame.
  // Keep following only when the user has not deliberately scrolled away.
  contentEl.querySelectorAll('img').forEach((img) => {
    if (img.complete || img._iexaFollowBound) return;
    img._iexaFollowBound = true;
    img.addEventListener('load', () => scrollToBottom(false, isNearChatBottom), { once: true });
  });
}

function handleTextDelta(fullText) {
  const followLatest = shouldFollowLatestMessage();
  hideWaitingIndicator();
  finishActiveThinkingBlock();
  if (!currentAssistantMsg) return;
  const previous = String(currentAssistantMsg._assistantText || '');
  const value = String(fullText || '');
  const contentEl = ensureAnswerContentEl();
  if (!value.startsWith(previous)) {
    // A gateway replaced its cumulative text. Keep the new text intact and
    // explicitly fall back rather than duplicating outdated fragments.
    currentAssistantMsg.querySelectorAll('.message-content').forEach(node => { if (node !== contentEl) node.remove(); });
    contentEl._textStart = 0; currentAssistantMsg.dataset.transcriptState = 'text-reset';
  }
  currentAssistantMsg._assistantText = value;
  contentEl.classList.add('streaming-markdown');
  renderMarkdownContent(contentEl, value.slice(contentEl._textStart || 0));
  // Hide empty preamble bubbles
  currentAssistantMsg.querySelectorAll('.message-content').forEach((node) => {
    if (node === contentEl) {
      node.style.display = '';
      return;
    }
    if (!(node.textContent || '').trim()) node.style.display = 'none';
  });
  scrollToBottom(false, followLatest);
}

function thinkingEffortLabelFor(level) {
  const normalized = normalizeThinkingLevel(level || 'medium');
  return THINKING_LEVELS[normalized]?.label || '标准';
}

function estimateThinkingTokens(text) {
  const chars = String(text || '').length;
  if (!chars) return 0;
  // Keep this consistent with the backend's ContextCompactor estimate.
  return Math.max(1, Math.ceil(chars / 3.5));
}

function updateThinkingTokenCount(thinkBlock, text) {
  if (!thinkBlock) return;
  const tokens = estimateThinkingTokens(text);
  const countEl = thinkBlock.querySelector('.thinking-token-count');
  if (countEl) {
    countEl.textContent = formatTokenCount(tokens);
    countEl.title = `思考 token：${tokens.toLocaleString()}（按思考内容估算）`;
  }
}

function restoreTranscriptOrder(element, message) {
  return window.IexaTranscriptView.restore(element, message, {
    text(text, item) {
      const content = document.createElement('div'); content.className = 'message-content'; content._textStart = item.start;
      renderMarkdownContent(content, text, true); return content;
    },
    thinking(text, item) {
      const block = document.createElement('details'); block.className = 'thinking-block is-complete';
      const level = normalizeThinkingLevel(message.thinkingLevel || currentThinkingLevel); block.dataset.thinkingLevel = level; block._reasoning = text;
      block.innerHTML = `<summary>${uiIcon('brain')}<span class="thinking-title">思考</span><span class="thinking-effort">${escapeHtml(thinkingEffortLabelFor(level))}</span><span class="thinking-token-count"></span><span class="thinking-chevron" aria-hidden="true"></span></summary><pre class="thinking-content"></pre>`;
      window.IexaChatActivity.prepareThinking(block); updateThinkingTokenCount(block, text); setPagedText(block.querySelector('.thinking-content'), text);
      if (Number.isSafeInteger(item.durationMs)) {
        block.dataset.startedAt = String(Math.max(1, item.timestamp));
        window.IexaChatActivity.finishThinking(block, Math.max(1, item.timestamp) + item.durationMs);
      }
      return block;
    },
  });
}

function stabilizeThinkingBlockWidth(thinkBlock) {
  if (!thinkBlock || thinkBlock.dataset.widthBound === 'true') return;
  const summary = thinkBlock.querySelector(':scope > summary');
  if (!summary) return;
  requestAnimationFrame(() => {
    if (!summary.isConnected) return;
    // Let the stylesheet's fit-content sizing resolve the complete label.
    // Never lock a pre-flex measurement into pixels: it can clip the arrow.
    thinkBlock.dataset.widthBound = 'true';
  });
}

function finishThinkingBlock(thinkBlock) {
  if (!thinkBlock || thinkBlock.classList.contains('is-complete')) return;
  // Compatibility cleanup for blocks created before the simplified design.
  const timerId = Number(thinkBlock.dataset.timerId);
  if (timerId) window.clearInterval(timerId);
  delete thinkBlock.dataset.timerId;
  window.IexaChatActivity.finishThinking(thinkBlock);
  thinkBlock.open = false;
  thinkBlock.classList.add('is-complete');
  const title = thinkBlock.querySelector('.thinking-title');
  const effort = thinkBlock.querySelector('.thinking-effort');
  const spinner = thinkBlock.querySelector('.thinking-spinner');
  if (title) title.textContent = '思考';
  if (effort) effort.textContent = thinkingEffortLabelFor(thinkBlock.dataset.thinkingLevel);
  if (spinner) spinner.remove();
}

function finishActiveThinkingBlock() {
  if (!currentAssistantMsg) return;
  currentAssistantMsg.querySelectorAll('.thinking-block:not(.is-complete)').forEach(finishThinkingBlock);
}

function initializeThinkingAutoScroll(content) {
  if (!content || content.dataset.autoScrollBound === 'true') return;
  content.dataset.autoScrollBound = 'true';
  content.dataset.followLatest = 'true';
  content.addEventListener('scroll', () => {
    const distance = content.scrollHeight - content.scrollTop - content.clientHeight;
    content.dataset.followLatest = distance <= 24 ? 'true' : 'false';
  }, { passive: true });
}

function scrollThinkingToLatest(content) {
  if (!content || content.dataset.followLatest === 'false') return;
  // Text layout can finish after the current event. Repeat once on the next
  // frame so wrapped reasoning lines also remain pinned to the latest line.
  requestAnimationFrame(() => {
    if (content.dataset.followLatest !== 'false') content.scrollTop = content.scrollHeight;
  });
}

function handleThinkingDelta(text) {
  hideWaitingIndicator();
  if (!currentAssistantMsg || !text) return;
  const lastActivity = window.IexaTranscriptView.lastNode(currentAssistantMsg);
  // Reasoning joins the turn's existing rail instead of starting a new block
  // beside it. A think/tool alternation used to break the chain every time,
  // so one turn ended up with a summary bar per alternation and a growing
  // stack of cards to lay out on every append.
  const rail = lastActivity?.classList.contains('tool-steps') && !lastActivity.classList.contains('is-collapsed')
    ? lastActivity : null;
  let thinkBlock = lastActivity?.classList.contains('thinking-block') && !lastActivity.classList.contains('is-complete')
    ? lastActivity
    : rail?.lastElementChild?.classList.contains('thinking-block') && !rail.lastElementChild.classList.contains('is-complete')
      ? rail.lastElementChild : null;
  if (!thinkBlock) {
    const level = currentAssistantMsg.dataset.thinkingLevel || currentThinkingLevel;
    thinkBlock = document.createElement('details');
    thinkBlock.className = 'thinking-block';
    thinkBlock.open = false;
    thinkBlock.dataset.startedAt = String(Date.now());
    thinkBlock._reasoning = '';
    thinkBlock.dataset.thinkingLevel = level;
    thinkBlock.innerHTML = `<summary><span class="thinking-spinner" aria-hidden="true"></span>${uiIcon('brain')}<span class="thinking-title">思考</span><span class="thinking-effort">${escapeHtml(thinkingEffortLabelFor(level))}</span><span class="thinking-token-count">0</span><span class="thinking-chevron" aria-hidden="true"></span></summary><pre class="thinking-content"></pre>`;
    if (rail) rail.append(thinkBlock);
    else window.IexaTranscriptView.append(currentAssistantMsg, thinkBlock);
    window.IexaLabelGlow?.attach(thinkBlock.querySelector('.thinking-title'));
    window.IexaChatActivity.prepareThinking(thinkBlock);
    stabilizeThinkingBlockWidth(thinkBlock);
  }
  const total = (thinkBlock._reasoning || '') + String(text);
  thinkBlock._reasoning = total;
  updateThinkingTokenCount(thinkBlock, total);
  const content = thinkBlock.querySelector('.thinking-content');
  if (content) {
    initializeThinkingAutoScroll(content);
    setPagedText(content, total, { followLatest: true });
    scrollThinkingToLatest(content);
  }
  scrollToBottom();
}
