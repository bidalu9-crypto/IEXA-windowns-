// The IDE uses the application's existing conversations, tools and terminals.
// Opening an IDE project never changes a running conversation's working directory.
(() => {
  'use strict';
  const rootKey = root => String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const base = () => typeof API_BASE === 'string' ? API_BASE : '';
  let opening = null, disposed = false;
  const tasks = new Map(), starting = new Set(), listeners = new Set();
  const taskRoute = task => '/api/terminal/sessions/' + encodeURIComponent(task.sessionId);
  function contextChanged(context) {
    let chip = document.getElementById('ideAgentContext');
    if (!context) { chip?.remove(); return; }
    const input = document.getElementById('chatInput'), wrapper = input?.closest('.chat-input-wrapper');
    if (!wrapper) return;
    if (!chip) {
      chip = document.createElement('button'); chip.type = 'button'; chip.id = 'ideAgentContext'; chip.className = 'ide-agent-context';
      chip.addEventListener('click', () => { if (typeof switchWorkbenchView === 'function') switchWorkbenchView('ide'); });
      wrapper.before(chip);
    }
    const path = context.activeFile || context.name || context.root.split(/[\\/]/).pop();
    chip.textContent = 'IDE · ' + path + (context.dirty ? ' · 未保存' : '') + (context.languageDiagnostics?.length ? ' · ' + context.languageDiagnostics.length + ' 项诊断' : '');
    chip.title = '已同步到当前项目智能体：活动文件、选区、未保存状态、诊断和运行日志。点击查看 IDE。';
    chip.setAttribute('aria-label', chip.title + ' ' + path);
  }

  async function request(route, options) {
    const response = await fetch(base() + route, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function updateContext(context) {
    if (!context?.workspaceId || !context.root || !window.iexaDesktop?.ide?.context) throw new Error('请先在 IDE 中打开项目文件夹');
    const result = await window.iexaDesktop.ide.context(context);
    if (result?.error) throw new Error(result.error);
  }
  function requireCurrentProject(context, action = '运行') {
    const latest = window.IexaIDE?.context?.();
    if (!latest || latest.workspaceId !== context.workspaceId || rootKey(latest.root) !== rootKey(context.root)) throw new Error('项目已切换，请在当前项目重新' + action);
    return latest;
  }

  async function openProjectChat(context) {
    requireCurrentProject(context, '打开 AI 对话');
    await updateContext(context);
    requireCurrentProject(context, '打开 AI 对话');
    const key = rootKey(context.root);
    const data = await request('/api/sessions');
    requireCurrentProject(context, '打开 AI 对话');
    const eligible = (data.sessions || []).filter(session => session.archived !== true && !session.botId && rootKey(session.projectRoot) === key);
    const current = typeof currentSessionId === 'string' ? currentSessionId : '';
    let session = eligible.find(item => item.id === current) || eligible.sort((a, b) => b.updated - a.updated)[0];
    if (!session) {
      const created = await request('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ideProjectRoot: context.root }),
      });
      session = created.session;
      if (!session?.id) throw new Error('项目会话创建失败');
    }
    requireCurrentProject(context, '打开 AI 对话');
    if (typeof switchSession !== 'function') throw new Error('聊天页面尚未就绪');
    await switchSession(session.id);
    requireCurrentProject(context, '打开 AI 对话');
    if (typeof loadSessionList === 'function') await loadSessionList();
    requireCurrentProject(context, '打开 AI 对话');
    // The existing transcript and composer remain beside the IDE. Re-select
    // only its workbench tab; activate(true) preserves project, models and the
    // expanded layout, and never runs the main page-navigation click handler.
    if (typeof switchWorkbenchView === 'function') switchWorkbenchView('ide');
    else window.IexaIDE?.activate?.(true);
    // Keep the person's existing draft and leave sending to the normal composer.
    const input = document.getElementById('chatInput');
    if (input) {
      input.dataset.ideProject = context.root;
      input.focus({ preventScroll: true });
    }
    return { sessionId: session.id, root: session.projectRoot };
  }

  function open(context) {
    const key = context?.workspaceId + ':' + rootKey(context?.root);
    if (opening?.key === key) return opening.promise;
    const entry = { key, promise: null };
    entry.promise = openProjectChat(context).finally(() => { if (opening === entry) opening = null; });
    opening = entry;
    return entry.promise;
  }

  async function openTerminal(context) {
    requireCurrentProject(context, '打开终端');
    await updateContext(context);
    const data = await request('/api/terminal/sessions');
    requireCurrentProject(context, '打开终端');
    let session = (data.sessions || []).find(item => item.running && rootKey(item.cwd) === rootKey(context.root));
    let created = false;
    if (!session) {
      const shell = document.getElementById('terminalShell')?.value || 'powershell';
      session = (await request('/api/terminal/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shell, ideProjectRoot: context.root }),
      })).session;
      created = true;
    }
    try {
      requireCurrentProject(context, '打开终端');
      if (!session?.id) throw new Error('终端会话创建失败');
      if (typeof switchWorkbenchView !== 'function' || typeof loadTerminalSessions !== 'function' || typeof selectTerminalSession !== 'function') throw new Error('终端页面尚未就绪');
      switchWorkbenchView('terminal');
      await loadTerminalSessions();
      requireCurrentProject(context, '打开终端');
      selectTerminalSession(session.id);
      return { sessionId: session.id, root: session.cwd };
    } catch (error) {
      // Only this handoff's newly created terminal is ours to clean up.
      // An existing user terminal survives a project switch unchanged.
      if (created && session?.id) await request('/api/terminal/sessions/' + encodeURIComponent(session.id) + '/terminate', { method: 'POST' }).catch(() => {});
      throw error;
    }
  }

  function taskState(workspaceId) {
    const task = tasks.get(workspaceId); if (!task) return null;
    const { rawOutput, timer, polling, ...visible } = task; return { ...visible };
  }
  function notify(task) { const value = taskState(task.workspaceId); listeners.forEach(listener => listener(value)); }
  function onTask(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function readable(value) {
    return String(value || '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\x1b[()][0-2A-Z]/g, '').replace(/\x1b./g, '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }
  function scheduleTask(task, delay = 350) {
    clearTimeout(task.timer);
    if (disposed || tasks.get(task.workspaceId) !== task || !['running', 'interrupting'].includes(task.status)) return;
    task.timer = setTimeout(() => pollTask(task.workspaceId), delay);
  }
  async function pollTask(workspaceId) {
    const task = tasks.get(workspaceId);
    if (!task || task.polling || !['running', 'interrupting'].includes(task.status)) return taskState(workspaceId);
    task.polling = true; clearTimeout(task.timer);
    try {
      const data = await request(taskRoute(task) + '?after=' + task.lastSeq);
      if (disposed || tasks.get(workspaceId) !== task || !['running', 'interrupting'].includes(task.status)) return taskState(workspaceId);
      task.lastSeq = Math.max(task.lastSeq, Number(data.lastSeq) || 0);
      task.rawOutput = (task.rawOutput + (data.chunks || []).map(chunk => String(chunk.text || '')).join('')).slice(-240000);
      const output = readable(task.rawOutput);
      task.output = output.slice(-120000); task.connectionError = ''; task.sessionRunning = data.running !== false;
      // The PTY shell stays alive after the program exits. Only the planner's
      // complete marker line proves the program's exit code; command echoes
      // and a partial marker at the end of a chunk must never complete a task.
      const marker = task.exitMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exits = [...output.matchAll(new RegExp('(?:^|\\n)' + marker + '=(-?\\d+)[ \\t]*\\n', 'g'))];
      if (exits.length) {
        task.exitCode = Number(exits.at(-1)[1]); task.status = task.exitCode === 0 ? 'completed' : 'failed'; task.finishedAt = Date.now();
      } else if (!task.sessionRunning && ['running', 'interrupting'].includes(task.status)) {
        task.status = 'failed'; task.error = '终端已退出，未收到任务退出码'; task.finishedAt = Date.now();
      }
      notify(task);
    } catch (error) { task.connectionError = error.message || String(error); notify(task); }
    finally { task.polling = false; scheduleTask(task, task.connectionError ? 1500 : 350); }
    return taskState(workspaceId);
  }
  async function savedContext(context, kind) {
    if (!context?.workspaceId || !context.root) throw new Error('请先在 IDE 中打开项目文件夹');
    requireCurrentProject(context);
    const projectSave = kind !== 'file' && window.IexaIDE?.saveProject;
    if (!context.dirty && !projectSave) return context;
    if (!projectSave && !window.IexaIDE?.save) throw new Error('请先保存当前文件');
    const before = window.IexaIDE.context?.();
    if (before?.workspaceId !== context.workspaceId || before.activeFile !== context.activeFile) throw new Error('项目或文件已切换，请重新运行');
    if (projectSave) await projectSave(context.workspaceId); else await window.IexaIDE.save();
    const next = window.IexaIDE.context?.();
    if (next?.workspaceId !== context.workspaceId || next.activeFile !== context.activeFile) throw new Error('项目或文件已切换，请重新运行');
    if (next.dirty) throw new Error('当前文件尚未保存，请先处理文件冲突');
    return next;
  }
  async function runTask(context, kind = 'file', script) {
    const workspaceId = context?.workspaceId;
    if (!['file', 'project', 'build', 'test'].includes(kind)) throw new Error('任务类型无效');
    if (!workspaceId) throw new Error('请先在 IDE 中打开项目文件夹');
    if (starting.has(workspaceId) || ['running', 'interrupting', 'stopping'].includes(tasks.get(workspaceId)?.status)) throw new Error('此项目已有运行任务，请等待结束或停止后再运行');
    starting.add(workspaceId); let task;
    try {
      context = await savedContext(context, kind);
      if (kind === 'file' && !context.activeFile) throw new Error('请先打开要运行的文件');
      await updateContext(context);
      if (!window.iexaDesktop?.ide?.runPlan) throw new Error('运行计划接口尚未就绪');
      const plan = await window.iexaDesktop.ide.runPlan({ workspaceId, kind, ...(kind === 'file' ? { path: context.activeFile } : {}), ...(script ? { script } : {}) });
      if (!plan?.command || !plan.cwd || plan.shell !== 'powershell' || !plan.exitMarker) throw new Error(plan?.error?.message || '运行计划无效');
      if (!window.IexaDialogs?.confirm) throw new Error('确认对话框尚未就绪');
      if (!(await window.IexaDialogs.confirm(`${plan.label}\n\n工作目录：${plan.cwd}\n\n${plan.command}`))) return null;
      requireCurrentProject(context);
      const previous = tasks.get(workspaceId);
      if (previous?.sessionRunning) { await request(taskRoute(previous) + '/terminate', { method: 'POST' }); previous.sessionRunning = false; }
      const { session } = await request('/api/terminal/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shell: 'powershell', ideProjectRoot: plan.cwd }) });
      if (!session?.id) throw new Error('终端会话创建失败');
      try { requireCurrentProject(context); }
      catch (error) { await request('/api/terminal/sessions/' + encodeURIComponent(session.id) + '/terminate', { method: 'POST' }); throw error; }
      task = { workspaceId, sessionId: session.id, kind, label: plan.label, cwd: plan.cwd, command: plan.command, exitMarker: plan.exitMarker, status: 'running', output: '', rawOutput: '', lastSeq: 0, sessionRunning: true, exitCode: null, error: '', connectionError: '', startedAt: Date.now(), timer: 0, polling: false };
      tasks.set(workspaceId, task); notify(task);
      await request(taskRoute(task) + '/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: plan.command }) });
      scheduleTask(task, 60); return taskState(workspaceId);
    } catch (error) {
      if (task) { task.status = 'failed'; task.error = error.message || String(error); notify(task); await request(taskRoute(task) + '/terminate', { method: 'POST' }).then(() => { task.sessionRunning = false; notify(task); }, () => {}); }
      throw error;
    } finally { starting.delete(workspaceId); }
  }
  async function interruptTask(workspaceId) {
    const task = tasks.get(workspaceId); if (!task || !['running', 'interrupting'].includes(task.status)) return;
    await request(taskRoute(task) + '/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '\u0003' }) });
    task.status = 'interrupting'; notify(task); scheduleTask(task, 60);
  }
  async function stopTask(workspaceId) {
    const task = tasks.get(workspaceId); if (!task?.sessionRunning) return;
    task.status = 'stopping'; clearTimeout(task.timer); notify(task);
    try { await request(taskRoute(task) + '/terminate', { method: 'POST' }); task.sessionRunning = false; task.status = 'stopped'; task.finishedAt = Date.now(); }
    catch (error) { task.status = 'running'; task.connectionError = error.message || String(error); scheduleTask(task); throw error; }
    finally { notify(task); }
  }
  window.addEventListener('pagehide', () => { disposed = true; tasks.forEach(task => clearTimeout(task.timer)); listeners.clear(); });

  window.IexaIDEAgent = Object.freeze({ open, openAI: open, openTerminal, runTask, taskState, onTask, pollTask, interruptTask, stopTask, contextChanged });
})();
