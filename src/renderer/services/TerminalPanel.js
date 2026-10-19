// =============================================================================
// Terminal panel
//
// Terminal tabs, session lifecycle, output polling and the command runner.
//
// Classic script, split out of services/FilesPanel.js. Top-level declarations
// stay in the global lexical scope; index.html fixes the load order and this
// file runs nothing when it is evaluated.
// =============================================================================
let terminalSessions = [];
let activeTerminalId = '';
let terminalLastSeq = 0;
let terminalPollTimer = null;
let terminalPollErrorShownFor = '';
let terminalPollBlockedFor = '';
let terminalPollInFlightFor = '';

function renderTerminalTabs() {
  const tabs = document.getElementById('terminalTabs');
  const stop = document.getElementById('terminalStopBtn');
  if (!tabs) return;
  tabs.innerHTML = terminalSessions.length ? terminalSessions.map((session) => {
    const active = session.id === activeTerminalId;
    const state = session.running ? '●' : '○';
    return `<button type="button" class="terminal-tab${active ? ' active' : ''}${session.running ? '' : ' ended'}" data-terminal-id="${escapeHtml(session.id)}" title="${escapeHtml(session.cwd)}">${state} ${escapeHtml(session.shell)}</button>`;
  }).join('') : '<span class="terminal-tabs-empty">没有运行中的终端</span>';
  tabs.querySelectorAll('[data-terminal-id]').forEach((button) => {
    button.addEventListener('click', () => selectTerminalSession(button.dataset.terminalId));
  });
  const active = terminalSessions.find((session) => session.id === activeTerminalId);
  if (stop) stop.disabled = !active || !active.running;
}

function selectTerminalSession(id) {
  if (!terminalSessions.some((session) => session.id === id)) return;
  activeTerminalId = id;
  terminalLastSeq = 0;
  terminalPollErrorShownFor = '';
  terminalPollBlockedFor = '';
  terminalPollInFlightFor = '';
  const output = document.getElementById('terminalOutput');
  if (output) output.textContent = '';
  renderTerminalTabs();
  pollTerminalOutput();
}

// node-pty returns the shell's full terminal stream, including ANSI cursor,
// clear-line and title sequences. The workbench uses a plain <pre> instead of
// a terminal emulator, so strip those control sequences before displaying the
// stream and keep only readable text.
function cleanTerminalOutput(value) {
  return String(value || '')
    // OSC title/notification sequences (BEL or ST terminated)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // CSI cursor movement, colors, erase and mode toggles
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    // Remaining two-byte escape sequences
    .replace(/\x1b[()][0-2A-Z]/g, '')
    .replace(/\x1b./g, '')
    // PTY carriage returns/backspaces are editing controls, not content.
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) => ch === '\t' ? '\t' : '');
}

function appendTerminalOutput(text) {
  const output = document.getElementById('terminalOutput');
  if (!output || !text) return;
  if (!output._lastOutputNode || output.lastChild !== output._lastOutputNode) output._outputLength = output.textContent.length;
  const chunk = cleanTerminalOutput(text);
  output.appendChild(document.createTextNode(chunk));
  output._lastOutputNode = output.lastChild;
  output._outputLength = (output._outputLength || 0) + chunk.length;
  while (output._outputLength > 100000 && output.firstChild) {
    const excess = output._outputLength - 100000;
    const first = output.firstChild;
    if (first.textContent.length <= excess) {
      output._outputLength -= first.textContent.length;
      first.remove();
    } else {
      first.textContent = first.textContent.slice(excess);
      output._outputLength -= excess;
    }
  }
  output.scrollTop = output.scrollHeight;
}

function resizeActiveTerminal() {
  const output = document.getElementById('terminalOutput');
  if (!activeTerminalId || !output || output.clientWidth < 1 || output.clientHeight < 1) return;
  const cols = Math.max(20, Math.floor((output.clientWidth - 22) / 8));
  const rows = Math.max(5, Math.floor((output.clientHeight - 22) / 18));
  fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/resize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols, rows }),
  }).catch(() => {});
}

async function loadTerminalSessions() {
  if (workbenchView !== 'terminal') return;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取终端失败');
    terminalSessions = data.sessions || [];
    if (!activeTerminalId || !terminalSessions.some((session) => session.id === activeTerminalId)) {
      activeTerminalId = terminalSessions.find((session) => session.running)?.id || terminalSessions[0]?.id || '';
      terminalLastSeq = 0;
      terminalPollErrorShownFor = '';
      terminalPollBlockedFor = '';
      terminalPollInFlightFor = '';
      const output = document.getElementById('terminalOutput');
      if (output) output.textContent = activeTerminalId ? '' : '点击“新建”启动终端。';
    }
    renderTerminalTabs();
    if (activeTerminalId) { resizeActiveTerminal(); pollTerminalOutput(); }
  } catch (error) {
    const output = document.getElementById('terminalOutput');
    if (output) output.textContent = '终端不可用：' + (error.message || error);
  }
}

async function createTerminalSession() {
  const shell = document.getElementById('terminalShell')?.value || 'powershell';
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shell }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建终端失败');
    activeTerminalId = data.session.id;
    terminalLastSeq = 0;
    terminalPollErrorShownFor = '';
    terminalPollBlockedFor = '';
    terminalPollInFlightFor = '';
    const output = document.getElementById('terminalOutput');
    if (output) output.textContent = `[${data.session.shell} · ${data.session.cwd}]\n`;
    await loadTerminalSessions();
  } catch (error) {
    addError('创建终端失败：' + (error.message || error));
  }
}

async function pollTerminalOutput() {
  if (workbenchView !== 'terminal' || !activeTerminalId) return;
  const id = activeTerminalId;
  if (terminalPollBlockedFor === id) return;
  // The interval can fire again while fetch is still pending. Reusing the
  // same `after` cursor in concurrent requests duplicates prompt/output chunks.
  if (terminalPollInFlightFor === id) return;
  terminalPollInFlightFor = id;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(id)}?after=${terminalLastSeq}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取终端输出失败');
    if (id !== activeTerminalId) return;
    terminalPollErrorShownFor = '';
    terminalPollBlockedFor = '';
    (data.chunks || []).forEach((chunk) => appendTerminalOutput(chunk.text));
    terminalLastSeq = Math.max(terminalLastSeq, Number(data.lastSeq) || 0);
    const known = terminalSessions.find((session) => session.id === id);
    if (known && known.running !== data.running) loadTerminalSessions();
  } catch (error) {
    // Do not append the same polling failure every 350ms. Show it once and
    // let the next session-list refresh recover if the backend becomes ready.
    if (terminalPollErrorShownFor !== id) {
      terminalPollErrorShownFor = id;
      appendTerminalOutput(`\n[终端连接错误：${error.message || error}]\n`);
    }
    terminalPollBlockedFor = id;
    // Give the backend a moment to recover, then refresh the session list and
    // resume polling without appending another duplicate error line.
    setTimeout(() => {
      if (workbenchView === 'terminal' && activeTerminalId === id) {
        terminalPollBlockedFor = '';
        loadTerminalSessions();
      }
    }, 2000);
  } finally {
    if (terminalPollInFlightFor === id) terminalPollInFlightFor = '';
  }
}

async function executeTerminalCommand() {
  const input = document.getElementById('terminalCommand');
  const command = input?.value || '';
  if (!activeTerminalId || !command.trim()) return;
  try {
    appendTerminalOutput(`\n$ ${command}\n`);
    if (input) input.value = '';
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '终端命令执行失败');
    setTimeout(pollTerminalOutput, 80);
  } catch (error) {
    appendTerminalOutput(`[命令失败：${error.message || error}]\n`);
  }
}

async function terminateTerminalSession() {
  if (!activeTerminalId) return;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/terminate`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '终止终端失败');
    setTimeout(loadTerminalSessions, 120);
  } catch (error) {
    addError('终止终端失败：' + (error.message || error));
  }
}

async function interruptTerminalSession() {
  if (!activeTerminalId) return;
  try {
    const response = await fetch(`${API_BASE}/api/terminal/sessions/${encodeURIComponent(activeTerminalId)}/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '\u0003' }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '发送 Ctrl+C 失败');
    appendTerminalOutput('^C\n');
  } catch (error) {
    addError('终端中断失败：' + (error.message || error));
  }
}

function initTerminalPanel() {
  document.getElementById('terminalNewBtn')?.addEventListener('click', createTerminalSession);
  document.getElementById('terminalRunBtn')?.addEventListener('click', executeTerminalCommand);
  document.getElementById('terminalInterruptBtn')?.addEventListener('click', interruptTerminalSession);
  document.getElementById('terminalStopBtn')?.addEventListener('click', terminateTerminalSession);
  document.getElementById('terminalCommand')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); executeTerminalCommand(); }
  });
  if (terminalPollTimer) clearInterval(terminalPollTimer);
  terminalPollTimer = setInterval(() => pollTerminalOutput(), 350);
  const output = document.getElementById('terminalOutput');
  if (output && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resizeActiveTerminal()).observe(output);
}
