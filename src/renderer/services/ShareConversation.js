// =============================================================================
// Share one exchange (the prompt and its reply) as JSON or as plain text.
//
// The record on disk is the authoritative source — it carries thinking, tool
// arguments and usage that the DOM only renders partially. A live message that
// has not been persisted yet falls back to reading the rendered nodes, so the
// button works mid-conversation as well.
// =============================================================================

const SHARE_FORMAT_JSON = 'json';
const SHARE_FORMAT_TEXT = 'text';

let shareMenu = null;
let shareAnchor = null;
let shareMessageEl = null;
let shareOpenedAt = 0;

function closeShareMenu() {
  if (!shareMenu) return;
  shareMenu.remove();
  shareMenu = null;
  shareMessageEl = null;
  if (shareAnchor) {
    shareAnchor.setAttribute('aria-expanded', 'false');
    shareAnchor = null;
  }
}

function shareSessionMeta() {
  // These are top-level `let` bindings in the classic scripts, so they live in
  // the global lexical environment rather than on `window`. Read them through
  // `typeof` so an early call cannot throw a ReferenceError.
  const id = typeof currentSessionId === 'string' ? currentSessionId : '';
  const cache = typeof sessionsCache !== 'undefined' && Array.isArray(sessionsCache) ? sessionsCache : [];
  const cached = cache.find((session) => session && session.id === id) || null;
  const modelLabel = document.querySelector('.model-selector-label');
  return {
    id,
    title: (cached && cached.title) || (id ? '未命名会话' : ''),
    project: (cached && (cached.projectName || cached.projectRoot)) || '',
    model: (modelLabel && modelLabel.textContent || '').trim(),
  };
}

/** The user message that produced this reply, so the export reads on its own. */
function sharePromptOf(messageEl) {
  let node = messageEl ? messageEl.previousElementSibling : null;
  while (node) {
    if (node.classList && node.classList.contains('message') && node.classList.contains('user')) {
      const text = node.querySelector('.user-message-text') || node.querySelector('.message-content');
      return (text && (text.innerText || text.textContent) || '').trim();
    }
    node = node.previousElementSibling;
  }
  return '';
}

function shareToolCallsFromDom(messageEl) {
  if (!messageEl) return [];
  return Array.from(messageEl.querySelectorAll('.tool-block')).map((block) => {
    const name = (block.querySelector('.tool-name') || {}).textContent || block.dataset.toolName || 'tool';
    const argsNode = block.querySelector('.tool-args') || block.querySelector('.tool-input');
    const resultNode = block.querySelector('.tool-result');
    const duration = Number(block.dataset.durationMs);
    return {
      name: String(name).trim(),
      args: argsNode ? String(argsNode.textContent || '').trim() : '',
      status: block.dataset.executionStatus || block.dataset.status || '',
      durationMs: Number.isFinite(duration) ? duration : null,
      result: resultNode ? String(resultNode.textContent || '').trim() : '',
    };
  });
}

function shareThinkingFromDom(messageEl) {
  if (!messageEl) return '';
  return Array.from(messageEl.querySelectorAll('.thinking-content'))
    .map((node) => String(node.textContent || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function shareContentFromDom(messageEl) {
  if (!messageEl) return '';
  if (typeof messageEl._assistantText === 'string' && messageEl._assistantText.trim()) return messageEl._assistantText.trim();
  return Array.from(messageEl.querySelectorAll('.message-content'))
    .filter((node) => !node.closest('.tool-block') && !node.closest('.thinking-block'))
    .map((node) => String(node.innerText || node.textContent || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function shareUsageFromDom(messageEl) {
  if (!messageEl) return null;
  const usage = messageEl._usage || null;
  const generationMs = Number(messageEl.dataset.generationMs);
  return {
    inputTokens: usage && Number.isFinite(Number(usage.inputTokens)) ? Number(usage.inputTokens) : null,
    outputTokens: usage && Number.isFinite(Number(usage.outputTokens)) ? Number(usage.outputTokens) : null,
    cacheReadInputTokens: usage && Number.isFinite(Number(usage.cacheReadInputTokens)) ? Number(usage.cacheReadInputTokens) : null,
    generationMs: Number.isFinite(generationMs) && generationMs > 0 ? generationMs : null,
    durationMs: Number.isFinite(Number(messageEl.dataset.durationMs)) ? Number(messageEl.dataset.durationMs) : null,
  };
}

/**
 * Prefer the persisted record: the DOM loses tool arguments and the raw
 * thinking text once a rail folds. `messageIndex` is only trusted when the
 * fetched array still has an assistant at that position (an edit can shift it).
 */
async function sharePayloadOf(messageEl) {
  const meta = shareSessionMeta();
  const index = Number(messageEl && messageEl.dataset.messageIndex);
  let record = null;

  if (meta.id && Number.isInteger(index) && index >= 0) {
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(meta.id)}`);
      if (response.ok) {
        const data = await response.json();
        const messages = Array.isArray(data) ? data : (data && data.messages);
        const candidate = Array.isArray(messages) ? messages[index] : null;
        if (candidate && candidate.role === 'assistant') record = candidate;
      }
    } catch {
      // Offline or the session vanished: the DOM fallback below still works.
    }
  }

  const thinking = record && typeof record.thinking === 'string'
    ? record.thinking.trim()
    : shareThinkingFromDom(messageEl);
  const toolCalls = record && Array.isArray(record.toolCalls)
    ? record.toolCalls.map((call) => ({
      name: String(call.name || 'tool'),
      args: call.args ? JSON.stringify(call.args, null, 2) : '',
      status: (call.result && (call.result.executionStatus || (call.result.success ? 'completed' : 'failed'))) || '',
      durationMs: call.result && Number.isFinite(Number(call.result.durationMs)) ? Number(call.result.durationMs) : null,
      result: call.result ? String(call.result.output || '') : '',
    }))
    : shareToolCallsFromDom(messageEl);

  const content = record && typeof record.content === 'string' && record.content.trim()
    ? record.content.trim()
    : shareContentFromDom(messageEl);

  const usage = record && record.usage
    ? {
      inputTokens: Number.isFinite(Number(record.usage.inputTokens)) ? Number(record.usage.inputTokens) : null,
      outputTokens: Number.isFinite(Number(record.usage.outputTokens)) ? Number(record.usage.outputTokens) : null,
      cacheReadInputTokens: Number.isFinite(Number(record.usage.cacheReadInputTokens)) ? Number(record.usage.cacheReadInputTokens) : null,
      generationMs: Number.isFinite(Number(record.generationMs)) ? Number(record.generationMs) : null,
      durationMs: Number.isFinite(Number(record.durationMs)) ? Number(record.durationMs) : null,
    }
    : shareUsageFromDom(messageEl);

  const stamp = Number(messageEl && messageEl.dataset.timestamp);
  const timestamp = Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now();

  return {
    schema: 'iexa.conversation.share/1',
    exportedAt: new Date().toISOString(),
    session: meta,
    exchange: {
      timestamp: new Date(timestamp).toISOString(),
      prompt: sharePromptOf(messageEl),
      reply: { thinking, toolCalls, content, usage },
    },
  };
}

function shareFormatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1000) return value + 'ms';
  if (value < 60000) return (value / 1000).toFixed(1) + 's';
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return minutes + 'm' + String(seconds).padStart(2, '0') + 's';
}

function shareFormatPlainText(payload) {
  const lines = [];
  const meta = payload.session || {};
  const exchange = payload.exchange || {};
  const reply = exchange.reply || {};

  lines.push('IEXA 对话分享');
  if (meta.title) lines.push('会话：' + meta.title);
  if (meta.model) lines.push('模型：' + meta.model);
  if (meta.project) lines.push('项目：' + meta.project);
  lines.push('时间：' + new Date(exchange.timestamp || Date.now()).toLocaleString('zh-CN'));
  lines.push('');

  if (exchange.prompt) {
    lines.push('──── 用户 ────');
    lines.push(exchange.prompt);
    lines.push('');
  }

  lines.push('──── 助手 ────');
  if (reply.thinking) {
    lines.push('[思考]');
    lines.push(reply.thinking);
    lines.push('');
  }
  const tools = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
  if (tools.length) {
    lines.push(`[工具调用] ${tools.length} 次`);
    tools.forEach((call, index) => {
      const bits = [call.name || 'tool'];
      if (call.status) bits.push(call.status);
      const duration = shareFormatDuration(call.durationMs);
      if (duration) bits.push(duration);
      lines.push(`${index + 1}. ${bits.join(' · ')}`);
      if (call.args) {
        lines.push('   参数：' + String(call.args).replace(/\n/g, '\n         '));
      }
      if (call.result) {
        const trimmed = String(call.result).trim();
        const clipped = trimmed.length > 800 ? trimmed.slice(0, 800) + '…' : trimmed;
        lines.push('   结果：' + clipped.replace(/\n/g, '\n         '));
      }
    });
    lines.push('');
  }
  lines.push(reply.content || '（无正文）');

  const usage = reply.usage || {};
  const summary = [];
  if (Number.isFinite(usage.inputTokens)) summary.push('输入 ' + usage.inputTokens + ' tokens');
  if (Number.isFinite(usage.outputTokens)) summary.push('输出 ' + usage.outputTokens + ' tokens');
  if (Number.isFinite(usage.generationMs) && usage.generationMs > 0) summary.push('生成 ' + shareFormatDuration(usage.generationMs));
  if (Number.isFinite(usage.durationMs) && usage.durationMs > 0) summary.push('耗时 ' + shareFormatDuration(usage.durationMs));
  if (summary.length) {
    lines.push('');
    lines.push('[用量] ' + summary.join(' · '));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function shareFormatJson(payload) {
  return JSON.stringify(payload, null, 2) + '\n';
}

function shareFileName(payload, format) {
  const title = String((payload.session && payload.session.title) || 'iexa')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'iexa';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${title}-${stamp}.${format === SHARE_FORMAT_JSON ? 'json' : 'txt'}`;
}

function shareStatus(text, tone) {
  if (!shareMenu) return;
  const status = shareMenu.querySelector('.share-menu-status');
  if (!status) return;
  status.textContent = text;
  status.dataset.tone = tone || 'ok';
}

async function copySharePayload(format) {
  try {
    const payload = await sharePayloadOf(shareMessageEl);
    const body = format === SHARE_FORMAT_JSON ? shareFormatJson(payload) : shareFormatPlainText(payload);
    await writeClipboardText(body);
    shareStatus(format === SHARE_FORMAT_JSON ? '已复制 JSON 到剪贴板' : '已复制纯文本到剪贴板');
  } catch (error) {
    shareStatus('复制失败：' + (error.message || error), 'error');
  }
}

async function downloadSharePayload(format) {
  try {
    const payload = await sharePayloadOf(shareMessageEl);
    const body = format === SHARE_FORMAT_JSON ? shareFormatJson(payload) : shareFormatPlainText(payload);
    const blob = new Blob([body], { type: format === SHARE_FORMAT_JSON ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = shareFileName(payload, format);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the download a tick to start before the blob URL is released.
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    shareStatus(format === SHARE_FORMAT_JSON ? '已开始下载 JSON' : '已开始下载纯文本');
  } catch (error) {
    shareStatus('下载失败：' + (error.message || error), 'error');
  }
}

function buildShareMenu() {
  const menu = document.createElement('div');
  menu.className = 'share-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '分享这条回复');
  menu.innerHTML = `
    <p class="share-menu-head">分享这条回复</p>
    <div class="share-menu-row">
      <button type="button" class="share-menu-item" role="menuitem" data-share="json">
        <span class="share-menu-badge">{ }</span>
        <span class="share-menu-text"><strong>JSON 格式</strong><small>结构化，含思考、工具调用与用量</small></span>
      </button>
      <button type="button" class="share-menu-download" data-download="json" title="下载 .json 文件" aria-label="下载 JSON 文件">${uiIcon('download')}</button>
    </div>
    <div class="share-menu-row">
      <button type="button" class="share-menu-item" role="menuitem" data-share="text">
        <span class="share-menu-badge">Aa</span>
        <span class="share-menu-text"><strong>纯文本格式</strong><small>直接粘贴到聊天或文档里</small></span>
      </button>
      <button type="button" class="share-menu-download" data-download="text" title="下载 .txt 文件" aria-label="下载纯文本文件">${uiIcon('download')}</button>
    </div>
    <p class="share-menu-status" role="status"></p>`;
  return menu;
}

function placeShareMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const box = menu.getBoundingClientRect();
  const margin = 8;
  let left = rect.right - box.width;
  if (left < margin) left = margin;
  if (left + box.width > window.innerWidth - margin) left = window.innerWidth - box.width - margin;
  // Prefer above the action row; fall back below when there is no room.
  let top = rect.top - box.height - 6;
  if (top < margin) top = rect.bottom + 6;
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.visibility = '';
}

function openShareMenu(messageEl, anchor) {
  const alreadyOpen = shareMenu && shareMessageEl === messageEl && shareAnchor === anchor;
  closeShareMenu();
  if (alreadyOpen) return;
  if (!messageEl || !anchor) return;

  const menu = buildShareMenu();
  shareMenu = menu;
  shareMessageEl = messageEl;
  shareAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  placeShareMenu(menu, anchor);

  menu.querySelectorAll('[data-share]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copySharePayload(button.dataset.share);
    });
  });
  menu.querySelectorAll('[data-download]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void downloadSharePayload(button.dataset.download);
    });
  });
  menu.querySelector('.share-menu-item')?.focus({ preventScroll: true });
}

function initShareConversation() {
  window.IexaShare = Object.freeze({ open: openShareMenu, close: closeShareMenu });

  document.addEventListener('click', (event) => {
    if (!shareMenu) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.includes(shareMenu) || path.includes(shareAnchor)) return;
    closeShareMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shareMenu) {
      const anchor = shareAnchor;
      closeShareMenu();
      anchor?.focus();
    }
  });
  // A scroll or resize would leave the menu pointing at a moved anchor. The
  // grace window matters: focusing the menu can emit a scroll in the same tick,
  // and the transcript auto-scrolls while a turn streams.
  const closeIfSettled = () => {
    if (Date.now() - shareOpenedAt < 250) return;
    closeShareMenu();
  };
  window.addEventListener('resize', closeIfSettled, { passive: true });
  document.addEventListener('scroll', closeIfSettled, { passive: true, capture: true });
}
