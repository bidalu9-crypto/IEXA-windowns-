// Live tool cards — split out of app.js.
// Tool labels/icons, consecutive-step folding, task summary and the four tool lifecycle events.
//
// Classic script: top-level declarations join the same global scope as
// app.js, so callers keep working unchanged. Keep this file free of load-time
// side effects — it evaluates before app.js and before the DOM is ready.

// Labels live in the i18n table as tool.<name>; a tool with no entry simply
// shows its canonical name, so adding a tool never means editing two lists.

// One icon per tool. Duplicates here are what made two different calls look
// identical in the transcript, so every entry must stay distinct.
const TOOL_ICONS = {
  todo_write: 'check',
  shell_execute: 'terminal',
  shell_session: 'terminal-session',
  job_list: 'menu',
  job_output: 'scroll',
  goal: 'pin',
  file_read: 'file',
  file_write: 'file-plus',
  file_edit: 'edit',
  grep: 'search',
  glob: 'folder',
  browser_fetch: 'globe',
  web_search: 'web-search',
  memory_write: 'memory',
  memory_get: 'brain',
  ask_user: 'chat',
  desktop_control: 'monitor',
  display_file: 'image',
  project_instructions: 'book',
  read_image: 'eye',
  spawn_agent: 'robot',
  send_input: 'send',
  wait_agent: 'clock',
  close_agent: 'close',
  resume_agent: 'play',
};

// The model sometimes calls a tool by a familiar alias; the card must show the
// real tool, not the alias it guessed.
const TOOL_ALIASES = {
  edit: 'file_edit',
  edit_file: 'file_edit',
  fileedit: 'file_edit',
  write_file: 'file_write',
  read_file: 'file_read',
  search: 'grep',
  find: 'glob',
};

function canonicalToolName(name) {
  const raw = String(name || '');
  return TOOL_ALIASES[raw] || raw;
}

function toolDisplayName(name) {
  const canonical = canonicalToolName(name);
  if (canonical.startsWith('mcp_')) return 'MCP · ' + canonical.slice(4);
  const key = 'tool.' + canonical;
  const translated = IexaI18n.t(key);
  return translated !== key ? translated : canonical;
}

function toolIcon(name) {
  const canonical = canonicalToolName(name);
  // MCP tools share one family icon; everything else has its own.
  if (canonical.startsWith('mcp_')) return uiIcon('puzzle');
  return uiIcon(TOOL_ICONS[canonical] || 'box');
}

function formatTaskElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return IexaI18n.t('tool.elapsed.seconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  return IexaI18n.t('tool.elapsed.minutes', { minutes, seconds: String(seconds % 60).padStart(2, '0') });
}

/** Create the compact task pill. Click it to show or hide the tool capsules. */
function consecutiveToolFoldEnabled() {
  return document.documentElement.getAttribute('data-collapse-tools') === 'on';
}

function applyConsecutiveToolFoldSetting(enabled) {
  document.documentElement.setAttribute('data-collapse-tools', enabled ? 'on' : 'off');
  try { localStorage.setItem('iexa-collapse-tools', enabled ? 'on' : 'off'); } catch { /* current window still applies it */ }
  document.querySelectorAll('.tool-steps').forEach((host) => {
    const summary = [...host.children].find((node) => node.classList?.contains('task-summary'));
    if (summary) {
      applyConsecutiveToolFold(host, summary, railShouldCollapse(host, summary));
      summary.hidden = !enabled;
    }
    refreshToolGroupSummary(host);
  });
}

function setConsecutiveToolFold(enabled) {
  applyConsecutiveToolFoldSetting(enabled);
  try {
    if (typeof syncThemeUI === 'function') syncThemeUI();
    if (typeof scheduleAppearanceSave === 'function') scheduleAppearanceSave();
  } catch { /* the visible fold state is already applied */ }
}

/**
 * A live rail is open while its tools run. Reasoning or answer text taking
 * over folds it back into the summary bar, so only the current step is
 * expanded. Explicit clicks always win over that default.
 */
function railShouldCollapse(host, summary) {
  if (summary.dataset.userCollapsed === 'true') return true;
  if (summary.dataset.userExpanded === 'true') return false;
  return host.dataset.autoOpen !== 'true';
}

function applyConsecutiveToolFold(host, summary, collapsed) {
  if (!host || !summary) return;
  const enabled = consecutiveToolFoldEnabled();
  host.classList.toggle('is-collapsed', enabled && collapsed);
  summary.hidden = !enabled;
  summary.setAttribute('aria-expanded', String(!(enabled && collapsed)));
  summary.title = enabled && collapsed ? IexaI18n.t('tool.fold.expand') : IexaI18n.t('tool.fold.collapse');
}

function refreshToolGroupSummary(host) {
  if (!host) return;
  const summary = [...host.children].find((node) => node.classList?.contains('task-summary'));
  if (!summary) return;
  const blocks = [...host.children].filter((node) => node.classList?.contains('tool-block'));
  const errors = blocks.filter((block) => block.classList.contains('is-error') || ['failed', 'denied', 'timed_out', 'error'].includes(block.dataset.executionStatus || block.dataset.status || '')).length;
  const countEl = summary.querySelector('.task-summary-count');
  const errorEl = summary.querySelector('.task-summary-errors');
  if (countEl) countEl.textContent = IexaI18n.t('tool.calls', { count: blocks.length });
  if (errorEl) errorEl.textContent = errors > 0 ? IexaI18n.t('tool.errors', { count: errors }) : '';
  const terminal = new Set(['done', 'completed', 'error', 'failed', 'denied', 'cancelled', 'timed-out', 'timed_out', 'unknown']);
  const running = blocks.some((block) => !terminal.has(block.dataset.executionStatus || '') && (block.classList.contains('is-active') || !terminal.has(block.dataset.status || 'running')));
  const started = blocks.map((block) => Number(block.dataset.startedAt)).filter(Number.isFinite);
  const ended = blocks.map((block) => Number(block.dataset.finishedAt)).filter(Number.isFinite);
  const start = started.length ? Math.min(...started) : Number(host.dataset.startedAt) || Date.now();
  const end = running || !blocks.length || ended.length !== blocks.length ? Date.now() : Math.max(...ended);
  const timeEl = summary.querySelector('.task-summary-time');
  if (timeEl) timeEl.textContent = formatTaskElapsed(end - start);
  const labelEl = summary.querySelector('.task-summary-label');
  if (labelEl) labelEl.textContent = running ? IexaI18n.t('tool.running') : IexaI18n.t('tool.ran');
  summary.classList.toggle('is-running', running);
  summary.classList.toggle('is-complete', !running && blocks.length > 0);
  const spinner = summary.querySelector('.task-summary-spinner');
  if (spinner) spinner.hidden = !running;
  applyConsecutiveToolFold(host, summary, railShouldCollapse(host, summary));
}

function createTaskSummary(toolCount) {
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'task-summary';
  summary.setAttribute('aria-expanded', 'false');
  summary.innerHTML =
    '<span class="task-summary-spinner" aria-hidden="true"></span>' +
    '<span class="task-summary-label">' + IexaI18n.t('tool.running') + '</span>' +
    '<span class="task-summary-count">' + IexaI18n.t('tool.calls', { count: Number(toolCount) || 0 }) + '</span>' +
    '<span class="task-summary-errors"></span>' +
    '<span class="task-summary-time">' + IexaI18n.t('tool.elapsed.seconds', { seconds: 0 }) + '</span>' +
    '<span class="task-summary-chevron" aria-hidden="true"></span>';
  summary.title = IexaI18n.t('tool.fold.expand');
  summary.addEventListener('click', function () {
    const host = summary.closest('.tool-steps');
    if (!host || !consecutiveToolFoldEnabled()) return;
    const collapsed = !host.classList.contains('is-collapsed');
    summary.dataset.userExpanded = collapsed ? '' : 'true';
    summary.dataset.userCollapsed = collapsed ? 'true' : '';
    applyConsecutiveToolFold(host, summary, collapsed);
  });
  return summary;
}

/**
 * Give a rail its task bar and apply the current fold.
 * Transcript replay rebuilds rails without going through the live start path;
 * it calls this instead of duplicating the summary markup, so a restored rail
 * can be collapsed exactly like the one the turn had while streaming.
 */
function attachToolGroupSummary(host) {
  if (!host) return null;
  let summary = [...host.children].find((node) => node.classList?.contains('task-summary'));
  if (!summary) {
    summary = createTaskSummary(0);
    host.insertBefore(summary, host.firstChild);
  }
  refreshToolGroupSummary(host);
  return summary;
}

/** Keep this turn's rail open while its tools are the current activity. */
function expandToolGroup(host) {
  if (!host) return;
  host.dataset.autoOpen = 'true';
  refreshToolGroupSummary(host);
}

/** Fold every rail whose tools have been superseded by reasoning or answer text. */
function collapseActiveToolGroups() {
  if (!currentAssistantMsg) return;
  currentAssistantMsg.querySelectorAll('.tool-steps[data-auto-open="true"]').forEach((host) => {
    delete host.dataset.autoOpen;
    refreshToolGroupSummary(host);
  });
}

// Exposed through an IIFE so the module keeps its declaration-only top level;
// transcript replay attaches task bars through this instead of duplicating the
// summary markup.
(() => {
  window.IexaToolRail = Object.freeze({
    attach: attachToolGroupSummary,
    refresh: refreshToolGroupSummary,
    createSummary: createTaskSummary,
    expand: expandToolGroup,
    collapseActive: collapseActiveToolGroups,
  });
})();

function taskSummaryForCurrentMessage() {
  // Bind the summary to its own chat turn. currentAssistantMsg can be reset
  // by a done event or replaced when a queued turn starts.
  return currentTaskSummary;
}

function updateTaskSummary(label) {
  const summary = taskSummaryForCurrentMessage();
  if (!summary || !currentTaskStartedAt) return;
  const labelEl = summary.querySelector('.task-summary-label');
  if (labelEl && label) labelEl.textContent = label;
  refreshToolGroupSummary(summary.closest('.tool-steps'));
}

function beginTaskSummary(label) {
  if (!currentTaskStartedAt) {
    currentTaskStartedAt = Date.now();
    // Timers remain owned by the background session that created the tool
    // step; a later session switch cannot redirect its elapsed-time updates.
    const ownerSessionId = currentSessionId;
    currentTaskTimer = window.setInterval(function () {
      withSessionRuntime(ownerSessionId, function () {
        updateTaskSummary();
        snapshotActiveSessionRuntime();
      });
    }, 250);
  }
  const summary = taskSummaryForCurrentMessage();
  if (summary) {
    summary.classList.remove('is-complete');
    const spinner = summary.querySelector('.task-summary-spinner');
    if (spinner) spinner.style.display = '';
  }
  updateTaskSummary(label);
}

function finishTaskSummary() {
  if (currentTaskTimer) window.clearInterval(currentTaskTimer);
  currentTaskTimer = null;
  // The turn is over, so no rail stays expanded waiting for a successor.
  collapseActiveToolGroups();
  if (!currentTaskStartedAt) return;
  const summary = taskSummaryForCurrentMessage();
  if (summary) {
    refreshToolGroupSummary(summary.closest('.tool-steps'));
  }
  currentTaskStartedAt = 0;
  currentTaskSummary = null;
}

/** Extract a partial JSON string value while args are still streaming. */
function extractPartialStringValue(key, json) {
  if (!json || typeof json !== 'string' || !key) return null;
  // Scan for "key": "value without needing a complete JSON object.
  const needle = '"' + key + '"';
  let i = json.indexOf(needle);
  if (i < 0) return null;
  i = json.indexOf(':', i + needle.length);
  if (i < 0) return null;
  i += 1;
  while (i < json.length && (json[i] === ' ' || json[i] === '\t' || json[i] === '\n' || json[i] === '\r')) i++;
  if (i >= json.length || json[i] !== '"') return null;
  i += 1; // first char of value
  let out = '';
  for (; i < json.length; i++) {
    const ch = json[i];
    if (ch === '\\') {
      if (i + 1 >= json.length) { out += ch; break; }
      const nx = json[++i];
      if (nx === 'n') out += '\n';
      else if (nx === 't') out += '\t';
      else if (nx === 'r') out += '\r';
      else if (nx === '"') out += '"';
      else if (nx === '\\') out += '\\';
      else if (nx === '/') out += '/';
      else if (nx === 'u' && i + 4 < json.length) {
        const hex = json.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += nx;
        }
      } else {
        out += nx;
      }
    } else if (ch === '"') {
      break; // closed string
    } else {
      out += ch;
    }
  }
  return out;
}

/** Prefer model tool_title; fall back to a short primary-arg preview. */
function toolLiveTitle(name, argsOrJson) {
  let title = null;
  let preview = null;
  if (argsOrJson && typeof argsOrJson === 'object') {
    if (argsOrJson.tool_title) title = String(argsOrJson.tool_title);
    if (name === 'shell_execute' && argsOrJson.command) preview = String(argsOrJson.command);
    else if ((name === 'file_read' || name === 'file_write' || name === 'file_edit') && argsOrJson.path) preview = String(argsOrJson.path);
    else if (name === 'browser_fetch' && argsOrJson.url) preview = String(argsOrJson.url);
    else if (name === 'memory_get' && argsOrJson.keywords) preview = String(argsOrJson.keywords);
  } else if (typeof argsOrJson === 'string') {
    title = extractPartialStringValue('tool_title', argsOrJson);
    if (name === 'shell_execute') preview = extractPartialStringValue('command', argsOrJson);
    else if (name === 'file_read' || name === 'file_write' || name === 'file_edit') preview = extractPartialStringValue('path', argsOrJson);
    else if (name === 'browser_fetch') preview = extractPartialStringValue('url', argsOrJson);
    else if (name === 'memory_get') preview = extractPartialStringValue('keywords', argsOrJson);
    else if (name === 'memory_write') preview = extractPartialStringValue('content', argsOrJson);
  }
  if (title && title.trim()) return title.trim();
  if (preview && preview.trim()) {
    const one = preview.trim().replace(/\s+/g, ' ');
    return one.length > 48 ? one.slice(0, 48) + '…' : one;
  }
  return toolDisplayName(name);
}

function ensureAssistantMessage() {
  if (!currentAssistantMsg) {
    currentAssistantMsg = addMessage('assistant', '', undefined, { streaming: true });
  }
  return currentAssistantMsg;
}

function showWaitingIndicator() {
  // A cancel request can race with late tool/stream events. Once stopping has
  // started, the old turn must never recreate the "IEXA正在处理..." surface.
  const runtime = currentSessionId ? runtimeForSession(currentSessionId) : null;
  if (runtime?.turnStopPending) return;
  const msg = ensureAssistantMessage();
  if (msg.querySelector('.waiting-indicator')) return;
  const indicator = window.IexaChatActivity.createWaiting();
  const footer = assistantFooterAnchor(msg);
  if (footer) msg.insertBefore(indicator, footer);
  else msg.appendChild(indicator);
  scrollToBottom();
}

function hideWaitingIndicator() {
  if (!currentAssistantMsg) return;
  const indicator = currentAssistantMsg.querySelector('.waiting-indicator');
  if (indicator) indicator.remove();
}

function ensureToolStepsHost() {
  const msg = ensureAssistantMessage();
  const last = window.IexaTranscriptView.lastNode(msg);
  // Reuse only the rail at the end of the turn. A folded rail can sit before
  // newer reasoning; appending to it would move the new tool step backwards
  // in time, so those get a fresh rail in their real position.
  if (last?.classList.contains('tool-steps')) return last;
  const host = document.createElement('div');
  host.className = 'tool-steps activity-list';
  host.dataset.startedAt = String(Date.now());
  window.IexaTranscriptView.append(msg, host);
  return host;
}

function setToolStepStatus(block, status, label) {
  const statusEl = block.querySelector('.tool-status');
  if (!statusEl) return;
  statusEl.className = 'tool-status ' + status;
  if (label != null) statusEl.textContent = label;
  else if (status === 'running' || status === 'streaming') statusEl.textContent = IexaI18n.t('tool.status.running');
  else if (status === 'done') statusEl.innerHTML = uiIcon('check') + '<span>' + IexaI18n.t('tool.status.done') + '</span>';
  else if (status === 'error') statusEl.innerHTML = uiIcon('alert') + '<span>' + IexaI18n.t('tool.status.error') + '</span>';
  block.dataset.status = status;
  block.classList.toggle('is-active', status === 'running' || status === 'streaming');
  block.classList.toggle('is-done', status === 'done');
  block.classList.toggle('is-error', ['error', 'denied', 'timed-out'].includes(status));
  block.classList.toggle('is-cancelled', status === 'cancelled');
  window.IexaLabelGlow?.syncRow(block);
}

function toolKind(name) {
  const canonical = canonicalToolName(name);
  if (canonical === 'shell_execute' || canonical === 'shell_session' || canonical.startsWith('terminal_')) return 'terminal';
  if (['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'project_instructions'].includes(canonical)) return 'file';
  if (canonical.startsWith('mcp_')) return 'mcp';
  if (canonical === 'browser_fetch' || canonical === 'web_search') return 'web';
  if (canonical === 'read_image' || canonical === 'display_file') return 'vision';
  if (canonical.startsWith('memory_')) return 'memory';
  if (canonical === 'desktop_control') return 'desktop';
  return 'agent';
}

function toolMeta(name, args) {
  const source = args && typeof args === 'object' ? args : {};
  const canonical = canonicalToolName(name);
  if (canonical === 'shell_execute') return source.shell ? `${source.shell} · ${IexaI18n.t('tool.meta.workspaceCommand')}` : IexaI18n.t('tool.meta.workspaceCommand');
  if (canonical === 'shell_session') return `${source.action || 'open'}${source.session_id ? ' · ' + String(source.session_id).slice(0, 8) : ''}`;
  if (canonical === 'job_list') return IexaI18n.t('tool.meta.recentJobs');
  if (canonical === 'job_output') return String(source.job_id || IexaI18n.t('tool.meta.jobOutput'));
  if (canonical === 'goal') return `${source.action || 'get'}${source.objective ? ' · ' + String(source.objective).slice(0, 40) : ''}`;
  if (canonical.startsWith('mcp_')) return IexaI18n.t('tool.meta.mcp');
  if (canonical === 'read_image') return String(source.path || IexaI18n.t('tool.meta.vision'));
  if (canonical === 'display_file') return String(source.path || IexaI18n.t('tool.meta.deliverable'));
  if (canonical === 'browser_fetch') return String(source.url || IexaI18n.t('tool.meta.webPage'));
  if (canonical === 'web_search') return String(source.query || IexaI18n.t('tool.meta.publicInfo'));
  if (canonical === 'desktop_control') return String(source.action || IexaI18n.t('tool.meta.desktop'));
  if (canonical === 'project_instructions') return String(source.path || source.kind || IexaI18n.t('tool.meta.projectRoot'));
  if (canonical === 'grep') return source.path ? `${source.path} · ${source.pattern || ''}` : String(source.pattern || IexaI18n.t('tool.meta.workspace'));
  if (canonical === 'glob') return String(source.pattern || IexaI18n.t('tool.meta.workspace'));
  if (canonical === 'memory_get') return String(source.keywords || IexaI18n.t('tool.meta.allMemory'));
  if (canonical === 'memory_write') return String(source.content || '').slice(0, 40) || IexaI18n.t('tool.meta.longTermMemory');
  if (canonical === 'ask_user') return IexaI18n.t('tool.meta.awaitingChoice');
  if (canonical === 'todo_write') {
    const count = Array.isArray(source.todos) ? source.todos.length : 0;
    return count ? IexaI18n.t('tool.meta.planCount', { count }) : IexaI18n.t('tool.meta.plan');
  }
  if (canonical === 'spawn_agent') return String(source.nickname || IexaI18n.t('tool.meta.subagent'));
  if (canonical === 'send_input') return String(source.id || IexaI18n.t('tool.meta.subagent'));
  if (canonical === 'wait_agent') return Array.isArray(source.ids) ? IexaI18n.t('tool.meta.subagentCount', { count: source.ids.length }) : IexaI18n.t('tool.meta.subagent');
  if (canonical === 'close_agent' || canonical === 'resume_agent') return String(source.id || IexaI18n.t('tool.meta.subagent'));
  if (source.path) return String(source.path);
  return IexaI18n.t('tool.meta.unknown');
}

function handleToolStart(id, name) {
  if (name === 'desktop_control') showDesktopLive();
  hideWaitingIndicator();
  finishActiveThinkingBlock();
  ensureAssistantMessage();
  if (currentToolBlocks[id]?.block.dataset.executionStatus) return;
  if (currentToolBlocks[id]) {
    // Already created via tool_input fallback — just ensure visible/active
    const info = currentToolBlocks[id];
    info.name = name || info.name;
    const iconEl = info.block.querySelector('.tool-icon');
    if (iconEl) iconEl.innerHTML = toolIcon(info.name);
    if (!info.block.querySelector('.tool-name').dataset.locked) {
      info.block.querySelector('.tool-name').textContent = toolDisplayName(info.name);
    }
    setToolStepStatus(info.block, 'streaming', IexaI18n.t('tool.status.preparing'));
    scrollToBottom();
    return;
  }

  const host = ensureToolStepsHost();
  const block = document.createElement('div');
  block.className = 'tool-block is-active';
  block.id = 'tool-' + id;
  block.dataset.toolId = id;
  block.dataset.toolName = name || '';
  block.dataset.status = 'streaming';
  block.dataset.startedAt = String(Date.now());
  block.dataset.kind = toolKind(name || '');
  block.innerHTML =
    '<div class="tool-header" data-ui-action="toggleToolBody" data-ui-arg="tool-body-' + escapeHtml(id) + '">' +
      '<span class="tool-icon">' + toolIcon(name) + '</span><span class="tool-heading"><span class="tool-name">' + escapeHtml(toolDisplayName(name)) + '</span><span class="tool-meta">' + escapeHtml(toolMeta(name)) + '</span></span>' +
      '<span class="tool-status running">' + IexaI18n.t('tool.status.preparing') + '</span>' +
      '<span class="tool-chevron" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="tool-body" id="tool-body-' + escapeHtml(id) + '" style="display:none;">' +
      '<div class="tool-section-label">' + IexaI18n.t('tool.section.input') + '</div><pre class="tool-args">' + IexaI18n.t('tool.preparing.placeholder') + '</pre>' +
    '</div>';

  // Insert the compact task bar once, above the individual capsules.
  // Capsules remain collapsed until the user taps the task bar.
  let summary = host.querySelector('.task-summary');
  if (!summary) {
    summary = createTaskSummary(0);
    host.insertBefore(summary, host.firstChild);
  }
  // Keep a direct reference so completion always stops this turn's spinner.
  currentTaskSummary = summary;
  host.appendChild(block);
  // A new tool makes its rail the current activity again. Use the rail API so
  // the transcript harness can run this function without the whole module.
  window.IexaToolRail?.expand?.(host);
  currentTaskToolCount += 1;
  beginTaskSummary(toolDisplayName(name));
  refreshToolGroupSummary(host);
  currentToolBlocks[id] = { block, name, argsText: '' };
  window.IexaChatActivity.updateTool(block, name);
  scrollToBottom();
}

function resolveToolBlockForInput(id, name) {
  if (id && currentToolBlocks[id]) return { id, info: currentToolBlocks[id] };
  // Fallback: latest running block with same name
  const entries = Object.entries(currentToolBlocks);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [bid, info] = entries[i];
    if (info.name === name && (info.block.dataset.status === 'streaming' || info.block.dataset.status === 'running')) {
      return { id: bid, info };
    }
  }
  // Create on the fly if start event was missed (OpenAI old path / partial reconnect)
  if (id) {
    handleToolStart(id, name);
    return { id, info: currentToolBlocks[id] };
  }
  const syntheticId = 'pending_' + name + '_' + Date.now();
  handleToolStart(syntheticId, name);
  return { id: syntheticId, info: currentToolBlocks[syntheticId] };
}

function handleToolInput(name, args, id) {
  const resolved = resolveToolBlockForInput(id, name);
  if (!resolved || !resolved.info) return;
  const { info } = resolved;
  if (info.block.dataset.executionStatus) return;
  info.argsText = typeof args === 'string' ? args : JSON.stringify(args || {}, null, 2);

  const argsEl = info.block.querySelector('.tool-args');
  if (argsEl) {
    try {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      setPagedText(argsEl, JSON.stringify(parsed, null, 2));
    } catch {
      setPagedText(argsEl, String(args || ''));
    }
  }
  const metaEl = info.block.querySelector('.tool-meta');
  if (metaEl && args && typeof args === 'object') metaEl.textContent = toolMeta(name || info.name, args);

  const nameEl = info.block.querySelector('.tool-name');
  if (nameEl) {
    const live = toolLiveTitle(name || info.name, args);
    nameEl.textContent = live;
    if (typeof args === 'string' && extractPartialStringValue('tool_title', args)) {
      nameEl.dataset.locked = '1';
    } else if (args && typeof args === 'object' && args.tool_title) {
      nameEl.dataset.locked = '1';
    }
  }

  const activityArgs = args && typeof args === 'object' ? args : {
    path: extractPartialStringValue('path', String(args || '')),
    command: extractPartialStringValue('command', String(args || '')),
    url: extractPartialStringValue('url', String(args || '')),
    tool_title: extractPartialStringValue('tool_title', String(args || '')),
  };
  window.IexaChatActivity.updateTool(info.block, name || info.name, activityArgs);
  setToolStepStatus(info.block, 'streaming', IexaI18n.t('tool.status.streaming'));
  updateTaskSummary(toolLiveTitle(name || info.name, args));
  scrollToBottom();
}

function handleToolComplete(id, name, args) {
  let info = currentToolBlocks[id];
  if (!info) {
    // Late complete without start — still show the step
    handleToolStart(id, name);
    info = currentToolBlocks[id];
  }
  if (!info) return;
  info.name = name || info.name;

  const argsEl = info.block.querySelector('.tool-args');
  if (argsEl) {
    try {
      setPagedText(argsEl, JSON.stringify(args || {}, null, 2));
    } catch {
      setPagedText(argsEl, String(args || ''));
    }
  }
  const metaEl = info.block.querySelector('.tool-meta');
  if (metaEl) metaEl.textContent = toolMeta(name || info.name, args);

  const nameEl = info.block.querySelector('.tool-name');
  if (nameEl) {
    nameEl.textContent = toolLiveTitle(name || info.name, args);
    if (args && args.tool_title) nameEl.dataset.locked = '1';
  }

  window.IexaChatActivity.updateTool(info.block, name || info.name, args);
  if (!info.block.dataset.executionStatus) setToolStepStatus(info.block, 'queued', IexaI18n.t('tool.status.queued'));
  updateTaskSummary(toolLiveTitle(name || info.name, args));
  scrollToBottom();
}

function setPagedText(element, text, options) {
  text = String(text || '');
  options = options || {};
  element._fullText = text;
  const pageSize = 16000;
  if (text.length <= pageSize && !element._pager) {
    element.textContent = text;
    return;
  }
  if (!element._pager) {
    const controls = document.createElement('div');
    controls.className = 'text-pager';
    const previous = document.createElement('button');
    const next = document.createElement('button');
    const copy = document.createElement('button');
    const label = document.createElement('span');
    previous.textContent = IexaI18n.t('tool.pager.prev');
    next.textContent = IexaI18n.t('tool.pager.next');
    copy.textContent = IexaI18n.t('tool.pager.copy');
    for (const button of [previous, next, copy]) button.type = 'button';
    controls.append(previous, label, next, copy);
    element.after(controls);
    element._page = 0;
    element._pager = { previous, next, label };
    previous.onclick = () => { element._page--; setPagedText(element, element._fullText); };
    next.onclick = () => { element._page++; setPagedText(element, element._fullText); };
    copy.onclick = () => writeClipboardText(element._fullText).catch((error) => addError(error.message));
  }
  const pages = Math.max(1, Math.ceil(text.length / pageSize));
  if (options.followLatest) element._page = pages - 1;
  element._page = Math.max(0, Math.min(element._page, pages - 1));
  element.textContent = text.slice(element._page * pageSize, (element._page + 1) * pageSize);
  element._pager.label.textContent = `${element._page + 1} / ${pages}`;
  element._pager.previous.disabled = element._page === 0;
  element._pager.next.disabled = element._page === pages - 1;
}

function handleToolResult(id, output, success, todos, fileChange, imageData, imageMimeType, artifacts, executionStatus, durationMs, pluginUI, metadata) {
  window.IexaQuestionCard?.completeForResult?.(id, { success, executionStatus });
  const info = currentToolBlocks[id];
  if (!info) return;

  window.IexaToolLifecycleView.applyResult(info.block, { success, executionStatus, metadata }, setToolStepStatus);
  info.block.dataset.finishedAt = String(Date.now());
  window.IexaChatActivity.updateTool(info.block, info.name, undefined, { success, fileChange, pluginUI });
  refreshToolGroupSummary(info.block.closest('.tool-steps'));

  if (Array.isArray(todos) && success && currentAssistantMsg) {
    renderTodoPlan(currentAssistantMsg, todos);
    window.IexaPlanDock?.setTodos(currentSessionId, todos);
  }

  const bodyEl = info.block.querySelector('.tool-body');
  if (bodyEl) {
    // Keep args, replace/append result
    let resultPre = bodyEl.querySelector('.tool-result');
    if (!resultPre) {
      resultPre = document.createElement('pre');
      resultPre.className = 'tool-result';
      const outputLabel = document.createElement('div');
      outputLabel.className = 'tool-section-label tool-output-label';
      outputLabel.textContent = IexaI18n.t('tool.section.output');
      bodyEl.appendChild(outputLabel);
      bodyEl.appendChild(resultPre);
    }
    setPagedText(resultPre, output || '');
    const startedAt = Number(info.block.dataset.startedAt || 0);
    const elapsed = Number.isFinite(durationMs) ? durationMs : startedAt ? Date.now() - startedAt : null;
    const duration = elapsed !== null ? (elapsed / 1000).toFixed(elapsed > 10_000 ? 1 : 2) + 's' : '';
    const status = info.block.querySelector('.tool-status');
    if (status && duration) status.insertAdjacentHTML('beforeend', `<span class="tool-duration">${duration}</span>`);
    if (imageData && imageMimeType && !(artifacts && artifacts.length)) {
      const image = document.createElement('button');
      image.type = 'button';
      image.className = 'tool-result-image';
      image.title = IexaI18n.t('tool.image.open');
      const img = document.createElement('img');
      img.src = `data:${imageMimeType};base64,${imageData}`;
      img.alt = IexaI18n.t('tool.image.generated');
      image.appendChild(img);
      image.addEventListener('click', () => openImagePreview(img.src, IexaI18n.t('tool.image.generated'), img));
      bodyEl.appendChild(image);
    }
    if (fileChange && fileChange.path) {
      info.fileChange = fileChange;
      info.success = !!success;
      renderFileChange(bodyEl, fileChange);
    }
    const mediaArtifacts = artifacts && artifacts.length
      ? artifacts
      : imageData && imageMimeType
        ? [{ kind: 'image', path: IexaI18n.t('tool.image.generated'), mimeType: imageMimeType, url: `data:${imageMimeType};base64,${imageData}` }]
        : [];
    if (mediaArtifacts.length) {
      // display_file is an explicit model instruction. Place its media after
      // this exact tool step, not in a shared end-of-message gallery, so the
      // visible order matches the streamed tool-call/result order.
      if (info.name === 'display_file') renderToolArtifactsAfterStep(info.block, mediaArtifacts);
      else renderToolArtifacts(bodyEl, mediaArtifacts);
    }
  }

  window.IexaChatActivity.refreshDetail(info.block);

  // A tool result is followed by another provider turn. Show the same
  // lightweight status again only after all visible tool steps are complete.
  const hasActiveTool = Object.values(currentToolBlocks || {}).some((item) => {
    const status = item && item.block && item.block.dataset.status;
    return ['running', 'streaming', 'queued', 'awaiting-approval', 'cancelling'].includes(status);
  });
  if (!hasActiveTool) showWaitingIndicator();

  scrollToBottom();
}
