'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/services/IDEAgent.js'), 'utf8');

function fixture(t, sessions) {
  const dom = new JSDOM('<button class="nav-btn" data-view="chat"></button><div id="view-chat" class="view active"><div id="chatMessages"></div><textarea id="chatInput">KEEP_MY_DRAFT</textarea><div id="idePanel" class="is-expanded"></div></div><select id="terminalShell"><option>powershell</option></select>', { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });
  const w = dom.window, calls = [];
  w.currentSessionId = 'old-project-chat';
  w.iexaDesktop = { ide: { context: async data => { calls.push({ type: 'context', data }); return { ok: true }; } } };
  w.switchSession = async id => { calls.push({ type: 'switch', id }); };
  w.loadSessionList = async () => {};
  w.syncIDEProject = async () => {};
  w.fetch = async (route, options) => {
    calls.push({ type: 'fetch', route, options });
    const data = route === '/api/sessions' && !options ? { sessions }
      : route === '/api/sessions' ? { session: { id: 'new-ide-chat', projectRoot: 'C:\\ide-project' } }
      : route === '/api/terminal/sessions' && !options ? { sessions: [] }
      : { session: { id: 'ide-terminal', cwd: 'C:\\ide-project' } };
    return { ok: true, json: async () => data };
  };
  w.eval(source);
  const context = { workspaceId: 'workspace-capability', root: 'C:\\ide-project', activeFile: 'src/main.js' };
  w.IexaIDE = { context: () => context };
  return { w, calls, context };
}

test('AI entry reuses a matching project conversation and preserves the draft without sending', async t => {
  const { w, calls, context } = fixture(t, [
    { id: 'old-project-chat', projectRoot: 'C:\\old-project', updated: 30 },
    { id: 'matching-chat', projectRoot: 'c:/IDE-PROJECT/', updated: 20 },
    { id: 'archived-chat', projectRoot: 'C:\\ide-project', archived: true, updated: 40 },
  ]);
  const result = await w.IexaIDEAgent.openAI(context);
  assert.equal(result.sessionId, 'matching-chat');
  assert.equal(calls[0].type, 'context');
  assert.equal(calls.find(call => call.type === 'switch').id, 'matching-chat');
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 0);
  assert.equal(w.document.getElementById('chatInput').value, 'KEEP_MY_DRAFT');
  assert.equal(w.document.activeElement.id, 'chatInput');
  assert.ok(calls.every(call => call.route !== '/api/chat'));
});

test('AI entry creates a project-bound conversation once and keeps old conversation metadata intact', async t => {
  const old = { id: 'old-project-chat', projectRoot: 'C:\\old-project' };
  const { w, calls, context } = fixture(t, [old]);
  const [a, b] = await Promise.all([w.IexaIDEAgent.open(context), w.IexaIDEAgent.open(context)]);
  assert.equal(a.sessionId, b.sessionId);
  const creates = calls.filter(call => call.options?.method === 'POST');
  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(creates[0].options.body), { ideProjectRoot: context.root });
  assert.equal(old.projectRoot, 'C:\\old-project');
  assert.ok(calls.every(call => !call.route?.includes('/api/project')));
  assert.equal(w.document.getElementById('chatInput').value, 'KEEP_MY_DRAFT');
});

test('a delayed AI handoff cannot switch back to an old project after context, session lookup or creation', async t => {
  for (const phase of ['context', 'sessions', 'create']) {
    const { w, calls, context } = fixture(t, []);
    let live = context, release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    w.IexaIDE.context = () => live;
    if (phase === 'context') {
      const original = w.iexaDesktop.ide.context;
      w.iexaDesktop.ide.context = async data => { entered(); await blocked; return original(data); };
    } else {
      const original = w.fetch;
      w.fetch = async (route, options) => {
        if (route === '/api/sessions' && (phase === 'create' ? options?.method === 'POST' : !options)) { entered(); await blocked; }
        return original(route, options);
      };
    }
    const pending = w.IexaIDEAgent.openAI(context);
    const rejected = assert.rejects(pending, /项目已切换/);
    await reached;
    live = { workspaceId: 'new-project-capability', root: 'C:\\new-project', activeFile: 'other.py' };
    release(); await rejected;
    assert.equal(calls.some(call => call.type === 'switch'), false, phase + ' must not reactivate the old conversation');
    assert.equal(w.document.getElementById('chatInput').dataset.ideProject, undefined);
    assert.equal(w.document.getElementById('chatInput').value, 'KEEP_MY_DRAFT');
  }
});

test('a new project AI handoff proceeds while an older project lookup is pending and retains its own deduplication', async t => {
  const { w, calls, context } = fixture(t, []);
  const next = { workspaceId: 'new-capability', root: 'C:\\new-project', activeFile: 'next.py' };
  let live = context, releaseOld, releaseNext, enteredOld, enteredNext, lookups = 0;
  const oldBlocked = new Promise(resolve => { releaseOld = resolve; }), nextBlocked = new Promise(resolve => { releaseNext = resolve; });
  const oldReached = new Promise(resolve => { enteredOld = resolve; }), nextReached = new Promise(resolve => { enteredNext = resolve; });
  w.IexaIDE.context = () => live;
  w.fetch = async (route, options) => {
    calls.push({ type: 'fetch', route, options });
    assert.equal(route, '/api/sessions'); assert.equal(options, undefined);
    if (++lookups === 1) { enteredOld(); await oldBlocked; }
    else { enteredNext(); await nextBlocked; }
    return { ok: true, json: async () => ({ sessions: [{ id: 'new-project-chat', projectRoot: next.root }] }) };
  };
  const older = w.IexaIDEAgent.openAI(context), rejected = assert.rejects(older, /项目已切换/);
  await oldReached; live = next;
  const newer = w.IexaIDEAgent.openAI(next); await nextReached;
  releaseOld(); await rejected;
  assert.equal(w.IexaIDEAgent.openAI(next), newer, 'the old finalizer must not clear the new project handoff');
  releaseNext(); const result = await newer;
  assert.equal(result.sessionId, 'new-project-chat'); assert.equal(lookups, 2);
  assert.deepEqual(calls.filter(call => call.type === 'switch').map(call => call.id), ['new-project-chat']);
  assert.equal(w.document.getElementById('chatInput').dataset.ideProject, next.root);
});

test('AI handoff keeps the expanded IDE and original composer visible while changing only the project conversation', async t => {
  const { w, calls, context } = fixture(t, [{ id: 'project-chat', projectRoot: 'C:\\ide-project' }]);
  const model = { path: 'src/main.js', content: 'UNSAVED_IDE_DRAFT', dirty: true };
  const state = { active: true, expanded: true, files: [model], previewAttached: 'workspace-capability' };
  w.IexaIDE = { context: () => context, activate: value => { state.active = value; calls.push({ type: 'ide-active', value }); } };
  // The actual workbench tab selector changes display and calls activate. A
  // main-navigation click would instead close the fixture's IDE, exposing the
  // previous handoff behavior that hid the live preview and covered chat.
  const { functions } = require('./helpers/transcript-harness.cjs');
  w.eval(functions(['switchWorkbenchView']));
  w.document.querySelector('.nav-btn').addEventListener('click', () => { state.expanded = false; state.previewAttached = ''; state.active = false; calls.push({ type: 'main-navigation' }); });
  const composer = w.document.getElementById('chatInput');
  await w.IexaIDEAgent.openAI(context);
  assert.equal(calls.find(call => call.type === 'switch').id, 'project-chat');
  assert.equal(calls.some(call => call.type === 'main-navigation'), false);
  assert.equal(w.document.getElementById('idePanel').style.display, 'flex');
  assert.equal(w.document.getElementById('view-chat').classList.contains('active'), true);
  assert.equal(w.document.querySelectorAll('#chatInput').length, 1);
  assert.equal(w.document.getElementById('chatInput'), composer);
  assert.equal(w.document.activeElement, composer);
  assert.equal(composer.value, 'KEEP_MY_DRAFT');
  assert.equal(state.active, true); assert.equal(state.expanded, true);
  assert.equal(state.previewAttached, context.workspaceId);
  assert.equal(state.files[0], model); assert.equal(model.content, 'UNSAVED_IDE_DRAFT');
  assert.equal(calls.some(call => call.type === 'ide-active' && !call.value), false);
});

test('IDE terminal uses the IDE root and selects the terminal without executing a command', async t => {
  const { w, calls, context } = fixture(t, []);
  w.IexaIDE = { context: () => context };
  w.IexaIDE = { context: () => ({ ...context }) };
  w.switchWorkbenchView = view => calls.push({ type: 'view', view });
  w.loadTerminalSessions = async () => calls.push({ type: 'terminal-list' });
  w.selectTerminalSession = id => calls.push({ type: 'select-terminal', id });
  await w.IexaIDEAgent.openTerminal(context);
  const created = calls.find(call => call.route === '/api/terminal/sessions' && call.options);
  assert.deepEqual(JSON.parse(created.options.body), { shell: 'powershell', ideProjectRoot: context.root });
  assert.equal(calls.find(call => call.type === 'select-terminal').id, 'ide-terminal');
  assert.ok(calls.every(call => !call.route?.includes('/execute') && call.type !== 'switch'));
});

test('a terminal handoff interrupted by a project switch never selects the old terminal and cleans up only its new session', async t => {
  for (const phase of ['create', 'list']) {
    const { w, calls, context } = fixture(t, []);
    let live = context, release, entered;
    const blocked = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
    w.IexaIDE.context = () => live;
    w.switchWorkbenchView = view => calls.push({ type: 'view', view });
    w.selectTerminalSession = id => calls.push({ type: 'select-terminal', id });
    w.loadTerminalSessions = async () => { if (phase === 'list') { entered(); await blocked; } };
    const original = w.fetch;
    w.fetch = async (route, options) => {
      if (phase === 'create' && route === '/api/terminal/sessions' && options?.method === 'POST') { entered(); await blocked; }
      return original(route, options);
    };
    const pending = w.IexaIDEAgent.openTerminal(context), rejected = assert.rejects(pending, /项目已切换/);
    await reached;
    live = { workspaceId: 'next-capability', root: 'C:\\next-project' };
    release(); await rejected;
    assert.equal(calls.some(call => call.type === 'select-terminal'), false, phase + ' must not select the old terminal');
    assert.deepEqual(calls.filter(call => call.route?.endsWith('/terminate')).map(call => call.route), ['/api/terminal/sessions/ide-terminal/terminate']);
    assert.equal(calls.some(call => call.route?.endsWith('/execute')), false);
  }
});

function taskFixture(t, options = {}) {
  const f = fixture(t, []), { w, calls, context } = f;
  let live = { ...context, dirty: !!options.dirty }, session = 0;
  const replies = [], plan = { kind: 'file', label: '运行 Python 文件', cwd: context.root, shell: 'powershell', command: "& 'python.exe' 'src/main.py'; Write-Output ('IEXA_IDE_EXIT_CODE=' + $LASTEXITCODE)", exitMarker: 'IEXA_IDE_EXIT_CODE' };
  w.IexaIDE = { context: () => ({ ...live }), save: async () => { calls.push({ type: 'save' }); if (options.saveError) throw new Error(options.saveError); live.dirty = !!options.keepDirty; } };
  w.IexaDialogs = { confirm: async text => { calls.push({ type: 'confirm', text }); return options.confirm !== false; } };
  w.iexaDesktop.ide.runPlan = async input => { calls.push({ type: 'plan', input }); if (options.planError) throw new Error(options.planError); return { ...plan, kind: input.kind }; };
  w.fetch = async (route, request) => {
    calls.push({ type: 'fetch', route, options: request });
    const data = route === '/api/terminal/sessions' ? { session: { id: 'owned-' + ++session, cwd: context.root, running: true } }
      : !request ? replies.shift() || { chunks: [], lastSeq: 0, running: true } : { ok: true };
    return { ok: true, json: async () => data };
  };
  return { ...f, context: live, replies, plan, setLive: value => { live = value; } };
}

test('running a dirty file saves before planning, confirms the exact cwd/command and starts a dedicated terminal beside code', async t => {
  const { w, calls, context, plan } = taskFixture(t, { dirty: true });
  const task = await w.IexaIDEAgent.runTask(context, 'file');
  assert.deepEqual(calls.slice(0, 4).map(call => call.type), ['save', 'context', 'plan', 'confirm']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.type === 'plan').input)), { workspaceId: context.workspaceId, kind: 'file', path: context.activeFile });
  assert.ok(calls.find(call => call.type === 'confirm').text.includes(plan.cwd));
  assert.ok(calls.find(call => call.type === 'confirm').text.includes(plan.command));
  const create = calls.find(call => call.route === '/api/terminal/sessions');
  assert.deepEqual(JSON.parse(create.options.body), { shell: 'powershell', ideProjectRoot: plan.cwd });
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/terminal/sessions/owned-1/execute').options.body), { command: plan.command });
  assert.equal(task.sessionId, 'owned-1'); assert.equal(task.status, 'running'); assert.equal(task.exitCode, null);
  assert.equal(calls.some(call => ['view', 'switch', 'select-terminal'].includes(call.type)), false);
  assert.equal(w.document.getElementById('chatInput').value, 'KEEP_MY_DRAFT');
});

test('task cancellation, failed saves, unresolved conflicts and missing runtimes execute no command', async t => {
  for (const options of [{ confirm: false }, { dirty: true, saveError: 'IDE_CONFLICT' }, { dirty: true, keepDirty: true }, { planError: '未找到 Python 运行环境' }]) {
    const { w, calls, context } = taskFixture(t, options);
    if (options.confirm === false) assert.equal(await w.IexaIDEAgent.runTask(context, 'file'), null);
    else await assert.rejects(w.IexaIDEAgent.runTask(context, 'file'), /CONFLICT|尚未保存|未找到 Python/);
    assert.equal(calls.some(call => call.route?.startsWith('/api/terminal/')), false);
    if (options.saveError || options.keepDirty) assert.equal(calls.some(call => call.type === 'plan'), false);
  }
});

test('project build and test plans stay separate from preview and do not reuse unrelated terminals', async t => {
  const { w, calls, context, replies } = taskFixture(t);
  for (const kind of ['project', 'build', 'test']) {
    const task = await w.IexaIDEAgent.runTask(context, kind, kind === 'project' ? 'start' : undefined);
    replies.push({ chunks: [{ seq: 1, text: 'IEXA_IDE_EXIT_CODE=0\r\n' }], lastSeq: 1, running: true });
    await w.IexaIDEAgent.pollTask(context.workspaceId);
    assert.equal(w.IexaIDEAgent.taskState(context.workspaceId).status, 'completed');
    assert.match(task.sessionId, /^owned-/);
  }
  const plans = calls.filter(call => call.type === 'plan');
  assert.deepEqual(plans.map(call => call.input.kind), ['project', 'build', 'test']);
  assert.equal(plans[0].input.script, 'start');
  assert.equal(plans[1].input.script, undefined);
  assert.equal(calls.filter(call => call.route === '/api/terminal/sessions').length, 3);
  assert.deepEqual(calls.filter(call => call.route?.endsWith('/terminate')).map(call => call.route), ['/api/terminal/sessions/owned-1/terminate', '/api/terminal/sessions/owned-2/terminate']);
  assert.equal(calls.some(call => call.route?.includes('preview')), false);
});

test('project tasks save all buffers in the selected project before planning even when the active file is clean', async t => {
  const { w, context, calls } = taskFixture(t);
  w.IexaIDE.saveProject = async id => { calls.push({ type: 'save-project', id }); };
  await w.IexaIDEAgent.runTask(context, 'build');
  assert.equal(calls[0].type, 'save-project'); assert.equal(calls[0].id, context.workspaceId);
  assert.equal(calls.findIndex(call => call.type === 'save-project') < calls.findIndex(call => call.type === 'plan'), true);
  const failed = taskFixture(t);
  failed.w.IexaIDE.saveProject = async () => { throw new Error('隐藏标签存在未解决冲突'); };
  await assert.rejects(failed.w.IexaIDEAgent.runTask(failed.context, 'test'), /隐藏标签/);
  assert.equal(failed.calls.some(call => call.type === 'plan' || call.route?.includes('/terminal/')), false);
});

test('PTY output ignores echoed and partial markers, removes ANSI and reports real zero/nonzero program exits while shell stays running', async t => {
  for (const exitCode of [0, 7]) {
    const { w, context, replies, plan } = taskFixture(t); const states = [];
    w.IexaIDEAgent.onTask(task => states.push(task.status));
    await w.IexaIDEAgent.runTask(context, 'file');
    replies.push({ chunks: [{ seq: 1, text: 'PS> ' + plan.command + '\r\n\x1b[32mREAL_OUTPUT\x1b[0m\r\nIEXA_IDE_EXIT_CODE=' + exitCode }], lastSeq: 1, running: true });
    await w.IexaIDEAgent.pollTask(context.workspaceId);
    let task = w.IexaIDEAgent.taskState(context.workspaceId);
    assert.equal(task.status, 'running', 'a partial marker without a completed line must not finish');
    assert.equal(task.exitCode, null); assert.ok(task.output.includes('REAL_OUTPUT')); assert.equal(task.output.includes('\x1b'), false);
    replies.push({ chunks: [{ seq: 2, text: '\r\nPS> ' }], lastSeq: 2, running: true });
    await w.IexaIDEAgent.pollTask(context.workspaceId); task = w.IexaIDEAgent.taskState(context.workspaceId);
    assert.equal(task.exitCode, exitCode); assert.equal(task.status, exitCode === 0 ? 'completed' : 'failed');
    assert.equal(task.sessionRunning, true, 'the persistent PowerShell process is independent from program completion');
    assert.equal(states.at(-1), task.status);
  }
});

test('interrupt and stop address only the owned task session and a late poll cannot overwrite stopped state', async t => {
  const { w, calls, context } = taskFixture(t); await w.IexaIDEAgent.runTask(context, 'file');
  await assert.rejects(w.IexaIDEAgent.runTask(context, 'build'), /已有运行任务/);
  await w.IexaIDEAgent.interruptTask(context.workspaceId);
  const interrupt = calls.find(call => call.route === '/api/terminal/sessions/owned-1/input');
  assert.deepEqual(JSON.parse(interrupt.options.body), { input: '\u0003' });
  assert.equal(w.IexaIDEAgent.taskState(context.workspaceId).status, 'interrupting');
  let resolvePoll;
  const original = w.fetch;
  w.fetch = (route, options) => !options ? new Promise(resolve => { resolvePoll = resolve; }) : original(route, options);
  const pending = w.IexaIDEAgent.pollTask(context.workspaceId);
  await w.IexaIDEAgent.stopTask(context.workspaceId);
  resolvePoll({ ok: true, json: async () => ({ chunks: [{ seq: 1, text: 'IEXA_IDE_EXIT_CODE=0\n' }], lastSeq: 1, running: false }) });
  await pending;
  assert.equal(w.IexaIDEAgent.taskState(context.workspaceId).status, 'stopped');
  assert.equal(w.IexaIDEAgent.taskState(context.workspaceId).exitCode, null);
  assert.deepEqual(calls.filter(call => call.route?.endsWith('/terminate')).map(call => call.route), ['/api/terminal/sessions/owned-1/terminate']);
});

test('an ended shell without a marker reports an unconfirmed exit instead of success', async t => {
  const { w, context, replies } = taskFixture(t); await w.IexaIDEAgent.runTask(context, 'file');
  replies.push({ chunks: [{ seq: 1, text: 'program started\n' }], lastSeq: 1, running: false });
  await w.IexaIDEAgent.pollTask(context.workspaceId);
  const task = w.IexaIDEAgent.taskState(context.workspaceId);
  assert.equal(task.status, 'failed'); assert.equal(task.exitCode, null); assert.match(task.error, /未收到任务退出码/);
});

test('a successful tool result synchronizes the IDE even with no mounted chat tool card', async t => {
  const { w, calls } = fixture(t, []);
  w.activeChatTurnToken = 1;
  w.runtimeForSession = () => ({});
  w.IexaIDE = { onFileChange: change => calls.push({ type: 'file-change', path: change.path }) };
  w.handleToolResult = () => {};
  w.eval(fs.readFileSync(path.join(__dirname, '../src/renderer/services/StreamPipeline.js'), 'utf8'));
  w.handleSSEEvent('event: tool_result\ndata: ' + JSON.stringify({ id: 'missing-card', success: true, fileChange: { path: 'src/main.js', after: 'TRUNCATED' } }), 1);
  assert.equal(calls.find(call => call.type === 'file-change').path, 'src/main.js');
  w.handleSSEEvent('event: tool_result\ndata: ' + JSON.stringify({ id: 'missing-card', success: false, fileChange: { path: 'failed.js' } }), 1);
  assert.equal(calls.filter(call => call.type === 'file-change').length, 1);
});

test('one tool result renders the original chat card and updates the adjacent IDE without switching panels', async t => {
  const { w, calls } = fixture(t, []);
  const { functions } = require('./helpers/transcript-harness.cjs');
  const transcript = w.document.getElementById('chatMessages');
  transcript.innerHTML = '<div class="tool-steps"><div id="live-tool" class="tool-block" data-status="running"><span class="tool-status"></span><div class="tool-body"><div data-pane="output"></div><div data-pane="diff"></div></div></div></div>';
  const block = w.document.getElementById('live-tool');
  const editorState = { content: 'before', dirty: false };
  w.currentToolBlocks = { 'edit-call': { block, name: 'file_edit' } };
  w.activeChatTurnToken = 1;
  w.runtimeForSession = () => ({});
  w.setToolStepStatus = (tool, status) => { tool.dataset.status = status; };
  w.refreshToolGroupSummary = () => {};
  w.setPagedText = (node, text) => { node.textContent = text; };
  w.renderFileChange = (host, change) => { host.textContent = change.path; };
  w.showWaitingIndicator = () => {};
  w.scrollToBottom = () => {};
  w.IexaChatActivity = { updateTool() {}, refreshDetail() {} };
  w.IexaIDE = { onFileChange: change => { editorState.content = 'READ_FROM_DISK_AFTER_EDIT'; calls.push({ type: 'file-change', path: change.path }); } };
  w.eval(fs.readFileSync(path.join(__dirname, '../src/renderer/services/ToolLifecycleView.js'), 'utf8'));
  w.eval(functions(['handleToolResult']));
  w.eval(fs.readFileSync(path.join(__dirname, '../src/renderer/services/StreamPipeline.js'), 'utf8'));
  w.handleSSEEvent('event: tool_result\ndata: ' + JSON.stringify({ id: 'edit-call', success: true, executionStatus: 'completed', output: 'File edited: src/main.js', fileChange: { path: 'src/main.js', after: 'TRUNCATED_PREVIEW' } }), 1);
  assert.equal(block.dataset.executionStatus, 'completed');
  assert.equal(block.dataset.status, 'done');
  assert.equal(block.querySelector('.tool-result').textContent, 'File edited: src/main.js');
  assert.equal(block.querySelector('[data-pane="diff"]').textContent, 'src/main.js');
  assert.equal(calls.filter(call => call.type === 'file-change').length, 1);
  assert.equal(editorState.content, 'READ_FROM_DISK_AFTER_EDIT');
  assert.equal(w.document.getElementById('idePanel').classList.contains('is-expanded'), true);
  assert.equal(w.document.getElementById('chatInput').value, 'KEEP_MY_DRAFT');
});
