// Exercise editor state through the public IDE surface. Native WebContents and
// Monaco rendering are covered separately by the Electron acceptance runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const renderer = path.join(__dirname, '../src/renderer');

function fixture(t, options = {}) {
  global.gc?.();
  const dom = new JSDOM(fs.readFileSync(path.join(renderer, 'index.html'), 'utf8'), {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  if (options.layout) w.localStorage.setItem('iexa-ide-layout', options.layout);
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.IexaDialogs = { confirm: async () => true, prompt: async () => null };
  const projects = [{ id: 'project-a', root: 'C:/fixtures/a', name: 'Project A' }, { id: 'project-b', root: 'C:/fixtures/b', name: 'Project B' }];
  const disk = new Map([
    ['project-a:one.js', { path: 'one.js', content: 'const one = 1;\n', revision: 'a1', encoding: 'utf-8' }],
    ['project-a:two.css', { path: 'two.css', content: 'body { color: red; }\n', revision: 'a2', encoding: 'utf-8' }],
    ['project-b:other.py', { path: 'other.py', content: 'print("other")\n', revision: 'b1', encoding: 'utf-8' }],
  ]);
  const writes = [], models = [], requests = [], previewRequests = [];
  const editor = {
    model: null, setModel(model) { this.model = model; }, getModel() { return this.model; },
    saveViewState: () => ({}), restoreViewState() {}, addCommand() {}, layout() {}, focus() {}, dispose() {},
    onDidChangeCursorPosition(handler) { this.cursorHandler = handler; }, onDidChangeCursorSelection() {},
    position: { lineNumber: 1, column: 1 }, getPosition() { return this.position; }, getSelection: () => null,
  };
  w.monaco = {
    Uri: { parse: value => value }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
    editor: {
      create: () => editor, setTheme() {}, createModel(content, _language, uri) {
        let text = content;
        const handlers = [];
        const model = { uri, disposed: false, getLineCount: () => text.split(/\r\n|\r|\n/).length, getValue: () => text, setValue(value) { text = value; handlers.forEach(handler => handler()); }, onDidChangeContent(handler) { handlers.push(handler); }, dispose() { this.disposed = true; } };
        models.push(model); return model;
      },
    },
  };
  w.iexaDesktop = { ide: {
    chooseFolder: async () => projects[0], projects: async () => { if (options.projectsWait) await options.projectsWait; return { projects }; },
    list: async ({ workspaceId }) => ({ entries: [...disk.entries()].filter(([key]) => key.startsWith(workspaceId + ':')).map(([, value]) => ({ name: value.path, path: value.path, directory: false, size: value.content.length })) }),
    read: async ({ workspaceId, path: file }) => {
      const result = disk.get(workspaceId + ':' + file); if (!result) throw new Error('ENOENT'); return { ...result };
    },
    write: async input => {
      const key = input.workspaceId + ':' + input.path, previous = disk.get(key);
      if (input.revision !== previous.revision) { const error = new Error('External file changed'); error.code = 'IDE_CONFLICT'; throw error; }
      writes.push(input); const next = { ...previous, content: input.content, revision: previous.revision + '+' }; disk.set(key, next); return { ...next };
    },
    inspect: async () => ({ type: 'static', scripts: [] }),
    status: async ({ workspaceId }) => ({ workspaceId, status: 'stopped', logs: [], url: '' }),
    context: async input => { requests.push(input); return { ok: true }; },
    preview: async input => { previewRequests.push(input); return { visible: false }; }, onEvent: () => () => {},
  } };
  w.projectRoot = options.chatRoot || 'C:/chat-project';
  const taskRuns = [], taskStates = new Map(); let taskListener;
  if (options.taskAgent) w.IexaIDEAgent = {
    taskState: id => taskStates.get(id), onTask: listener => { taskListener = listener; return () => { taskListener = null; }; },
    runTask: async (context, kind, script) => {
      taskRuns.push({ context, kind, script });
      if (options.taskError) throw new Error(options.taskError);
      const task = { workspaceId: context.workspaceId, sessionId: 'owned-task', kind, label: 'Python', cwd: context.root, command: 'python main.py', status: 'running', output: 'REAL_TASK_OUTPUT\n', exitCode: null, sessionRunning: true };
      taskStates.set(context.workspaceId, task); taskListener?.(task); return task;
    },
    interruptTask: async id => { taskRuns.push({ interrupt: id }); }, stopTask: async id => { taskRuns.push({ stop: id }); },
  };
  const lexicalRoot = options.lexicalChatRoot ? 'let projectRoot = ' + JSON.stringify(options.lexicalChatRoot) + ';\n' : '';
  w.eval(lexicalRoot + fs.readFileSync(path.join(renderer, 'services/IDEWorkspace.js'), 'utf8'));
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  return { w, api: w.IexaIDE, projects, disk, editor, models, writes, requests, previewRequests, taskRuns, taskStates, emitTask: task => { taskStates.set(task.workspaceId, task); taskListener?.(task); } };
}

test('cursor reports current buffer line count and updates on motion, edits, tab switches and close', async t => {
  const f = fixture(t); await f.api.ready(); await f.api.openFile('one.js');
  const el = f.w.document.getElementById('ideCursor');
  assert.equal(el.textContent, '行 1/2，列 1');
  f.editor.model.setValue('first\r\nsecond\r\nthird');
  assert.equal(el.textContent, '行 1/3，列 1');
  f.editor.position = {lineNumber:3,column:4}; f.editor.cursorHandler();
  assert.equal(el.textContent, '行 3/3，列 4'); assert.match(el.title, /共 3 行/);
  f.editor.position = {lineNumber:1,column:1};
  await f.api.openFile('two.css'); assert.equal(el.textContent, '行 1/2，列 1');
  f.editor.model.setValue(''); assert.equal(el.textContent, '行 1/1，列 1');
  await f.api.openProject(f.projects[1]); assert.equal(el.textContent, '');
});

test('preview tab starts selected non-index HTML, switches pages, restarts and clears stale read errors', async t => {
  const f = fixture(t); await f.api.ready(); const d = f.w.document, starts = [];
  for (const name of ['pelican-ride.html', '中文 space/second.htm']) f.disk.set('project-a:'+name, {path:name,content:'<h1>'+name+'</h1>',revision:name,encoding:'utf-8'});
  f.w.iexaDesktop.ide.inspect = async () => ({type:'unknown',scripts:[]});
  f.w.iexaDesktop.ide.start = f.w.iexaDesktop.ide.restart = async input => {
    starts.push(input); return {status:'running',url:'http://127.0.0.1:12345/'+input.entryPath.split('/').map(encodeURIComponent).join('/'),logs:[],entryPath:input.entryPath};
  };
  await f.api.openFile('pelican-ride.html'); assert.equal(starts.length, 0);
  d.getElementById('ideViewPreview').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts[0].entryPath, 'pelican-ride.html'); assert.equal(starts[0].confirmed, undefined);
  await f.api.openFile('中文 space/second.htm'); assert.equal(starts.at(-1).entryPath, '中文 space/second.htm');
  d.getElementById('ideRestart').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 3); assert.equal(starts.at(-1).entryPath, '中文 space/second.htm');
  f.editor.model.setValue('<h1>saved</h1>'); await f.api.save();
  assert.ok(f.previewRequests.some(input => input.action === 'reload'));
  const read = f.w.iexaDesktop.ide.read;
  f.w.iexaDesktop.ide.read = async input => { if(input.path === 'one.js')throw Error('此文件包含二进制数据。'); return read(input); };
  d.getElementById('ideTree').querySelector('[data-path="one.js"]').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.api.snapshot().error, /二进制/);
  await f.api.openFile('pelican-ride.html'); assert.equal(f.api.snapshot().error, '');
  assert.equal(d.getElementById('ideStatus').classList.contains('is-error'),false);
});

test('late failed read does not overwrite the newer selected file status', async t => {
  const f = fixture(t); await f.api.ready(); let reject;
  const read = f.w.iexaDesktop.ide.read;
  f.w.iexaDesktop.ide.read = input => input.path === 'one.js' ? new Promise((_, fail) => {reject=fail;}) : read(input);
  const old = f.api.openFile('one.js'); await new Promise(resolve => setImmediate(resolve));
  await f.api.openFile('two.css'); reject(Error('此文件包含二进制数据。')); await old;
  assert.equal(f.api.snapshot().activeFile, 'two.css'); assert.equal(f.api.snapshot().error,'');
});

test('IDE keeps separate projects, tabs and unsaved models while its page is hidden', async t => {
  const f = fixture(t);
  await f.api.openProject(f.projects[0]);
  assert.equal(f.w.document.querySelectorAll('#ideTree [data-path]').length, 2);
  await f.api.openFile('one.js');
  const first = f.editor.model;
  first.setValue('const one = "draft";\n');
  await f.api.openFile('two.css');
  assert.equal(f.api.snapshot().files.length, 2);
  await f.api.openProject(f.projects[1]);
  await f.api.openFile('other.py');
  f.api.activate(false); f.api.activate(true);
  await f.api.openProject(f.projects[0]);
  await f.api.openFile('one.js');
  assert.equal(f.editor.model, first);
  assert.equal(first.getValue(), 'const one = "draft";\n');
  assert.equal(f.api.snapshot().files.find(file => file.path === 'one.js').dirty, true);
  assert.equal(f.w.projectRoot, 'C:/chat-project', 'opening an IDE project preserves the chat project');
  assert.equal(f.models.filter(model => !model.disposed).length, 3);
});

test('authorized projects reopen and switch before Monaco is initialized, including hydrated projects', async t => {
  for (const hydrated of [false, true]) {
    const f = fixture(t, hydrated ? { layout: JSON.stringify({ projectId: 'project-a', open: [{ id: 'project-a', paths: [], activePath: '' }] }) } : {});
    delete f.w.monaco;
    await f.api.ready();
    if (!hydrated) await f.api.openProject(f.projects[0]);
    assert.equal(f.api.snapshot().workspaceId, 'project-a');
    assert.equal(f.w.document.getElementById('ideMonaco'), null);
    await assert.doesNotReject(f.api.openProject(f.projects[0]), 'reopening a project without a model must not save a null editor view');
    await assert.doesNotReject(f.api.openProject(f.projects[1]), 'switching projects without an editor must preserve first-open flow');
    await assert.doesNotReject(f.api.openProject(f.projects[0]));
    assert.equal(f.w.document.getElementById('ideTree').querySelectorAll('[data-path]').length, 2);
    assert.equal(f.api.snapshot().activeFile, '');
    assert.equal(f.api.snapshot().error, '');
    assert.equal(f.models.length, 0, 'project browsing must keep Monaco lazy');
  }
});

test('initial authorized projects prefer the current chat root before a saved project, with no conversation mutation', async t => {
  for (const options of [
    {},
    { chatRoot: 'c:\\fixtures\\b\\' },
    { lexicalChatRoot: 'C:/fixtures/b' },
    { layout: JSON.stringify({ projectId: 'project-a' }), chatRoot: 'C:/fixtures/b' },
    { layout: JSON.stringify({ projectId: 'removed-project' }), chatRoot: 'C:/unapproved' },
  ]) {
    const f = fixture(t, options); await f.api.ready();
    const expected = /fixtures[\\/]b/i.test(options.chatRoot || options.lexicalChatRoot || '') ? 'project-b' : 'project-a';
    assert.equal(f.api.snapshot().workspaceId, expected);
    assert.equal(f.w.document.getElementById('ideProjectSelect').value, expected, 'the displayed selection is an opened authorized project');
    assert.ok(f.w.document.getElementById('ideTree').querySelector('[data-path]'));
    assert.equal(f.models.length, 0, 'initial folder loading does not initialize Monaco');
    assert.equal(f.w.projectRoot, options.chatRoot || 'C:/chat-project');
    assert.equal(f.api.snapshot().error, '');
  }
  let release;
  const pending = new Promise(resolve => { release = resolve; }); const f = fixture(t, { projectsWait: pending, chatRoot: 'C:/fixtures/a' });
  const ready = f.api.ready(); await f.api.openProject(f.projects[1]); release(); await ready;
  assert.equal(f.api.snapshot().workspaceId, 'project-b', 'a late initial list cannot override the explicit user choice');
});

test('a selected project in a narrow sidebar exposes files and opens code without another folder picker', async t => {
  const f = fixture(t); await f.api.ready(); const d = f.w.document;
  Object.defineProperty(d.getElementById('idePanel'), 'clientWidth', { configurable: true, value: 530 });
  f.api.activate(true); await f.api.openProject(f.projects[0]);
  assert.equal(d.getElementById('ideExplorer').hidden, false, 'the initial project tree must be visible');
  const files = d.getElementById('ideViewFiles');
  assert.ok(files, 'a labeled Files tab must stay available');
  assert.equal(files.textContent.trim(), '文件');
  assert.equal(files.closest('[hidden]'), null);
  assert.equal(files.getAttribute('aria-selected'), 'true');
  d.getElementById('ideTree').querySelector('[data-path="one.js"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.snapshot().activeFile, 'one.js');
  assert.equal(f.editor.model.getValue(), 'const one = 1;\n');
  assert.equal(d.getElementById('ideExplorer').hidden, true);
  assert.equal(d.getElementById('ideEditorColumn').hidden, false);
  assert.equal(d.getElementById('ideMain').hidden, false);
  assert.equal(files.closest('[hidden]'), null, 'the Files tab must remain visible after the code is opened');
  f.editor.model.setValue('draft while browsing'); files.click();
  assert.equal(d.getElementById('ideExplorer').hidden, false);
  d.getElementById('ideViewCode').click();
  assert.equal(f.editor.model.getValue(), 'draft while browsing');
  assert.equal(d.getElementById('ideMain').hidden, false);
  await f.api.openProject(f.projects[1]);
  d.getElementById('ideViewCode').click();
  assert.equal(d.getElementById('ideWelcomeOpen').hidden, true, 'an authorized project does not ask for the folder again');
  const choose = d.getElementById('ideWelcomeSelect');
  assert.ok(choose && !choose.hidden, 'the empty editor offers a Choose file action');
  assert.equal(choose.textContent.trim(), '选择文件'); choose.click();
  assert.equal(d.getElementById('ideExplorer').hidden, false);
  assert.ok(d.getElementById('ideTree').querySelector('[data-path="other.py"]'));
  assert.equal(f.api.snapshot().error, '');
});

test('an unexpanded 530px sidebar runs and shows native preview, then hides it for files, code and late attachments', async t => {
  const f = fixture(t); await f.api.ready(); const d = f.w.document;
  const rect = { x: 400, y: 160, left: 400, top: 160, right: 930, bottom: 560, width: 530, height: 400 };
  d.getElementById('idePanel').style.display = 'flex';
  for (const id of ['idePanel', 'ideCanvas', 'idePreviewViewport']) d.getElementById(id).getBoundingClientRect = () => rect;
  Object.defineProperty(d.getElementById('idePanel'), 'clientWidth', { configurable: true, value: 530 });
  const frame = async () => { await new Promise(resolve => f.w.requestAnimationFrame(resolve)); await new Promise(resolve => setImmediate(resolve)); };
  f.w.iexaDesktop.ide.start = async ({ workspaceId }) => ({ workspaceId, status: 'running', url: 'http://127.0.0.1:12345/', logs: [] });
  f.api.activate(true); await f.api.openProject(f.projects[0]);
  d.getElementById('ideRun').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.snapshot().expanded, false, 'preview must work in the original right sidebar');
  assert.equal(f.api.snapshot().server.status, 'running');
  d.getElementById('ideViewPreview').click(); await frame();
  let attached = f.previewRequests.find(input => input.action === 'attach');
  assert.ok(attached, 'the visible preview tab attaches a native surface without expansion');
  assert.equal(attached.visible, true); assert.equal(attached.bounds.width, 530);
  assert.equal(f.api.snapshot().previewAttached, 'project-a');
  d.getElementById('idePreviewRefresh').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.previewRequests.findLast(input => input.action === 'reload').visible, true, 'navigation actions use the same visibility rule');
  d.getElementById('ideViewFiles').click(); await frame();
  assert.equal(f.api.snapshot().previewAttached, '');
  assert.equal(f.previewRequests.at(-1).action, 'hide');
  f.previewRequests.length = 0;
  const original = f.w.iexaDesktop.ide.preview; let release;
  f.w.iexaDesktop.ide.preview = async input => {
    if (input.action === 'attach') await new Promise(resolve => { release = resolve; });
    return original(input);
  };
  d.getElementById('ideViewPreview').click(); await frame(); assert.ok(release);
  d.getElementById('ideViewCode').click(); release(); await frame();
  assert.equal(f.api.snapshot().previewAttached, '');
  assert.equal(f.previewRequests.at(-1).action, 'hide', 'a late attach cannot cover the code tab');
  d.getElementById('idePreviewRefresh').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.previewRequests.findLast(input => input.action === 'reload').visible, false);
});

test('file/project/build/test controls display owned terminal output beside the original code and composer', async t => {
  const f = fixture(t, { taskAgent: true }); await f.api.ready(); await f.api.openFile('one.js'); f.api.activate(true);
  const d = f.w.document, model = f.editor.model, composer = d.getElementById('chatInput'); composer.value = 'KEEP_CHAT_DRAFT';
  const frame = async () => { await new Promise(resolve => setImmediate(resolve)); };
  assert.equal(d.getElementById('ideRun').textContent.trim(), '启动网页预览');
  assert.equal(d.getElementById('ideRunFile').textContent.trim(), '运行文件');
  d.getElementById('ideRunFile').click(); await frame();
  assert.equal(f.taskRuns[0].kind, 'file');
  assert.equal(f.taskRuns[0].context.activeFile, 'one.js');
  assert.equal(d.getElementById('ideTerminalTab').getAttribute('aria-selected'), 'true');
  assert.equal(d.getElementById('ideTaskTerminal').hidden, false);
  assert.equal(d.getElementById('ideTaskOutput').textContent, 'REAL_TASK_OUTPUT\n');
  assert.equal(d.getElementById('ideTaskStatus').dataset.state, 'running');
  assert.equal(d.getElementById('ideMain').hidden, false); assert.equal(d.getElementById('ideEditorColumn').hidden, false);
  assert.equal(f.editor.model, model); assert.equal(composer.value, 'KEEP_CHAT_DRAFT');
  d.getElementById('ideTaskInterrupt').click(); await frame(); d.getElementById('ideTaskStop').click(); await frame();
  assert.equal(f.taskRuns[1].interrupt, 'project-a'); assert.equal(f.taskRuns[2].stop, 'project-a');
  f.emitTask({ ...f.taskStates.get('project-a'), status: 'failed', exitCode: 7, output: '<img src=x onerror=alert(1)>\nIEXA_IDE_EXIT_CODE=7\n' });
  assert.equal(d.getElementById('ideTaskStatus').textContent, '结束代码 7');
  assert.equal(d.getElementById('ideTaskStatus').dataset.state, 'failed');
  assert.equal(d.getElementById('ideTaskOutput').querySelector('img'), null, 'terminal data is text only');
  d.getElementById('ideLogTab').click();
  assert.equal(d.getElementById('ideTaskTerminal').hidden, true);
  d.getElementById('ideTerminalTab').click();
  assert.match(d.getElementById('ideTaskOutput').textContent, /IEXA_IDE_EXIT_CODE=7/);
  for (const kind of ['project', 'build', 'test']) { d.getElementById('ideTasks').value = kind; d.getElementById('ideRunTask').click(); await frame(); }
  assert.deepEqual(f.taskRuns.filter(call => call.kind).map(call => call.kind), ['file', 'project', 'build', 'test']);
  assert.equal(f.previewRequests.some(input => input.action === 'start'), false);
  assert.equal(f.api.snapshot().expanded, false); assert.equal(composer.value, 'KEEP_CHAT_DRAFT');
});

test('a missing runtime leaves code and chat visible and reports the actual planner error', async t => {
  const f = fixture(t, { taskAgent: true, taskError: '未找到 Python 运行环境' }); await f.api.ready(); await f.api.openFile('one.js');
  const d = f.w.document, model = f.editor.model; d.getElementById('ideRunFile').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(d.getElementById('ideStatus').textContent, '未找到 Python 运行环境');
  assert.equal(d.getElementById('ideStatus').classList.contains('is-error'), true);
  assert.equal(d.getElementById('ideEditorColumn').hidden, false); assert.equal(f.editor.model, model);
  assert.equal(f.taskStates.size, 0);
});

test('only genuine local Monaco cancellation rejections are handled during model changes', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  f.editor.model.setValue('draft before switching');
  await f.api.openFile('two.css');
  const source = 'http://localhost/vendor/monaco/vs/editor/editor.main.js:10:42';
  const rejection = (name, message, stack, plain = false) => {
    const reason = plain ? { name, message, stack } : Object.assign(new f.w.Error(message), { name, stack });
    const event = new f.w.Event('unhandledrejection', { cancelable: true });
    Object.defineProperty(event, 'reason', { value: reason }); f.w.dispatchEvent(event); return event;
  };
  assert.equal(rejection('Canceled', 'Canceled', `Canceled: Canceled\n    at cancel (${source})`).defaultPrevented, true);
  for (const [name, message, stack, plain] of [
    ['Error', 'Canceled', `Error: Canceled\n    at worker (${source})`],
    ['Canceled', 'Actual worker failure', `Canceled: Actual worker failure\n    at worker (${source})`],
    ['Canceled', 'Canceled', 'Canceled: Canceled\n    at application (http://localhost/services/ChatService.js:5:1)'],
    ['Canceled', 'Canceled', 'Canceled: Canceled\n    at cancel (https://other.test/vendor/monaco/vs/editor/editor.main.js:10:42)'],
    ['Canceled', 'Canceled', undefined],
    ['Canceled', 'Canceled', `Canceled: Canceled\n    at cancel (${source})`, true],
  ]) assert.equal(rejection(name, message, stack, plain).defaultPrevented, false, 'unrelated rejection must remain visible');
  await f.api.openFile('one.js');
  assert.equal(f.editor.model.getValue(), 'draft before switching');
  assert.equal(f.api.snapshot().files[0].dirty, true);
  assert.equal(f.api.snapshot().error, '');
});

test('external edits update clean models and preserve dirty models until an explicit conflict choice', async t => {
  const f = fixture(t);
  await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  f.disk.set('project-a:one.js', { ...f.disk.get('project-a:one.js'), content: 'const one = "external";\n', revision: 'external-1' });
  await f.api.refresh();
  assert.equal(f.editor.model.getValue(), 'const one = "external";\n');
  assert.equal(f.api.snapshot().files[0].dirty, false);
  f.editor.model.setValue('const one = "my draft";\n');
  f.disk.set('project-a:one.js', { ...f.disk.get('project-a:one.js'), content: 'const one = "agent";\n', revision: 'external-2' });
  await f.api.refresh();
  assert.equal(f.editor.model.getValue(), 'const one = "my draft";\n');
  assert.equal(f.api.snapshot().files[0].conflict, true);
  assert.equal(f.w.document.getElementById('ideConflict').hidden, false);
  await f.api.save();
  assert.equal(f.writes.length, 0, 'a conflicted editor must not silently overwrite disk');
  f.w.document.getElementById('ideKeepEdits').click();
  await new Promise(resolve => setImmediate(resolve));
  await f.api.save();
  assert.equal(f.writes[0].revision, 'external-2', 'the explicit keep choice accepts the latest disk revision');
  assert.equal(f.disk.get('project-a:one.js').content, 'const one = "my draft";\n');
  assert.equal(f.api.snapshot().files[0].dirty, false);
});

test('saving uses the workspace capability and the revision read from disk', async t => {
  const f = fixture(t);
  await f.api.openProject(f.projects[1]); await f.api.openFile('other.py');
  f.editor.model.setValue('print("saved")\n');
  await f.api.save();
  assert.deepEqual(f.writes.map(input => ({ workspaceId: input.workspaceId, path: input.path, revision: input.revision, content: input.content })), [{ workspaceId: 'project-b', path: 'other.py', revision: 'b1', content: 'print("saved")\n' }]);
  assert.equal(f.api.context().dirty, false);
  assert.equal(f.api.context().root, 'C:/fixtures/b');
  assert.equal(f.api.snapshot().files[0].revision, 'b1+');
});

test('every IDE toolbar action and dynamically rendered file row resolves its SVG sprite', async t => {
  const f = fixture(t);
  await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  const uses = [...f.w.document.querySelectorAll('#idePanel use')];
  assert.ok(uses.length >= 20, 'the complete toolbar and editor tabs were rendered');
  const unresolved = uses.map(use => use.getAttribute('href')).filter(href => !href || !f.w.document.querySelector(href));
  assert.deepEqual(unresolved, [], 'dynamic icons must use an existing application sprite symbol');
  for (const action of f.w.document.querySelectorAll('#idePanel button')) {
    assert.ok(action.getAttribute('aria-label') || action.textContent.trim(), 'every IDE action has an accessible name');
  }
});

test('late file reads cannot replace the most recently selected tab', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]);
  const originalRead = f.w.iexaDesktop.ide.read;
  let release;
  f.w.iexaDesktop.ide.read = async input => {
    if (input.path === 'one.js') await new Promise(resolve => { release = resolve; });
    return originalRead(input);
  };
  const first = f.api.openFile('one.js');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.api.openFile('two.css'); release(); await first;
  assert.equal(f.api.snapshot().activeFile, 'two.css');
  assert.equal(f.editor.model.getValue(), 'body { color: red; }\n');
  assert.equal(f.api.snapshot().files.length, 2, 'the late file remains available as an inactive tab');
});

test('save all keeps using its original project when the user switches projects mid-save', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]);
  await f.api.openFile('one.js'); f.editor.model.setValue('first draft');
  await f.api.openFile('two.css'); f.editor.model.setValue('second draft');
  const originalWrite = f.w.iexaDesktop.ide.write;
  let release;
  f.w.iexaDesktop.ide.write = async input => {
    if (input.path === 'one.js') await new Promise(resolve => { release = resolve; });
    return originalWrite(input);
  };
  const saving = f.api.saveAll();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.api.openProject(f.projects[1]); await f.api.openFile('other.py');
  release(); await saving;
  assert.deepEqual(f.writes.map(input => input.workspaceId), ['project-a', 'project-a']);
  assert.equal(f.disk.get('project-a:one.js').content, 'first draft');
  assert.equal(f.disk.get('project-a:two.css').content, 'second draft');
  assert.equal(f.api.snapshot().workspaceId, 'project-b');
  assert.equal(f.editor.model.getValue(), 'print("other")\n');
});

test('saving a project for build writes every dirty project tab and leaves other project drafts untouched', async t => {
  const f = fixture(t); await f.api.ready(); await f.api.openFile('one.js'); f.editor.model.setValue('first project draft');
  await f.api.openFile('two.css'); f.editor.model.setValue('second project draft');
  await f.api.openProject(f.projects[1]); await f.api.openFile('other.py'); f.editor.model.setValue('independent other draft');
  await f.api.openProject(f.projects[0]); await f.api.saveProject('project-a');
  assert.deepEqual(f.writes.map(write => [write.workspaceId, write.path]), [['project-a', 'one.js'], ['project-a', 'two.css']]);
  assert.equal(f.api.snapshot().files.some(file => file.dirty), false);
  await f.api.openProject(f.projects[1]);
  assert.equal(f.editor.model.getValue(), 'independent other draft'); assert.equal(f.api.context().dirty, true);
  assert.equal(f.disk.get('project-b:other.py').content, 'print("other")\n');
});

test('new edits made while a save is pending remain dirty after its earlier buffer reaches disk', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  f.editor.model.setValue('saved buffer');
  const originalWrite = f.w.iexaDesktop.ide.write;
  let release;
  f.w.iexaDesktop.ide.write = async input => { await new Promise(resolve => { release = resolve; }); return originalWrite(input); };
  const saving = f.api.save();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.editor.model.setValue('newer unsaved buffer'); release(); await saving;
  assert.equal(f.disk.get('project-a:one.js').content, 'saved buffer');
  assert.equal(f.editor.model.getValue(), 'newer unsaved buffer');
  assert.equal(f.api.snapshot().files[0].dirty, true);
});

test('agent file changes refresh cached files in projects that are currently hidden', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  const model = f.editor.model; model.setValue('unsaved local buffer');
  await f.api.openProject(f.projects[1]);
  f.disk.set('project-a:one.js', { ...f.disk.get('project-a:one.js'), content: 'agent changed disk', revision: 'agent-2' });
  f.api.onFileChange({ path: 'one.js' });
  await new Promise(resolve => setTimeout(resolve, 230));
  await f.api.openProject(f.projects[0]);
  assert.equal(model.getValue(), 'unsaved local buffer');
  assert.equal(f.api.snapshot().files[0].conflict, true);
});

test('renaming preserves text typed while the filesystem operation is pending', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  let release;
  f.w.IexaDialogs.prompt = async () => 'renamed.js';
  f.w.iexaDesktop.ide.rename = async input => {
    await new Promise(resolve => { release = resolve; });
    const old = f.disk.get(input.workspaceId + ':' + input.path);
    f.disk.delete(input.workspaceId + ':' + input.path);
    f.disk.set(input.workspaceId + ':' + input.newPath, { ...old, path: input.newPath });
    return { ok: true };
  };
  f.w.document.querySelector('#ideTree [data-path="one.js"]').dispatchEvent(new f.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  f.w.document.querySelector('#ideContextMenu [data-ide-label="rename"]').click();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.editor.model.setValue('typed during rename'); release();
  for (let i = 0; i < 50 && f.api.snapshot().activeFile !== 'renamed.js'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.snapshot().activeFile, 'renamed.js');
  assert.equal(f.editor.model.getValue(), 'typed during rename');
  assert.equal(f.api.snapshot().files[0].dirty, true);
  assert.equal(f.disk.get('project-a:renamed.js').content, 'const one = 1;\n');
});

test('deleting a file preserves a newer buffer typed after deletion was confirmed', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  let release;
  f.w.iexaDesktop.ide.remove = async input => {
    await new Promise(resolve => { release = resolve; });
    f.disk.delete(input.workspaceId + ':' + input.path); return { ok: true };
  };
  f.w.document.querySelector('#ideTree [data-path="one.js"]').dispatchEvent(new f.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  f.w.document.querySelector('#ideContextMenu [data-ide-label="remove"]').click();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.editor.model.setValue('new text typed during delete'); release();
  for (let i = 0; i < 50 && f.w.document.getElementById('ideConflict').hidden; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.editor.model.getValue(), 'new text typed during delete');
  assert.equal(f.api.snapshot().files[0].dirty, true);
  assert.equal(f.w.document.getElementById('ideConflict').hidden, false);
  assert.match(f.w.document.getElementById('ideConflictText').textContent, /已删除或移动/);
  assert.equal(f.disk.has('project-a:one.js'), false);
});

test('native close guard sees hidden projects and save all saves every project before allowing exit', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  f.editor.model.setValue('first project edit');
  await f.api.openProject(f.projects[1]); await f.api.openFile('other.py'); f.editor.model.setValue('second project edit');
  assert.equal(f.api.hasUnsavedChanges(), true);
  const blocked = new f.w.Event('beforeunload', { cancelable: true }); f.w.dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, true);
  await f.api.saveAll();
  assert.equal(f.api.hasUnsavedChanges(), false);
  assert.equal(f.disk.get('project-a:one.js').content, 'first project edit');
  assert.equal(f.disk.get('project-b:other.py').content, 'second project edit');
  f.editor.model.setValue('discard explicitly');
  f.api.allowClose();
  const allowed = new f.w.Event('beforeunload', { cancelable: true }); f.w.dispatchEvent(allowed);
  assert.equal(allowed.defaultPrevented, false, 'only native approved discard bypasses the renderer guard');
});

test('save all rejects unresolved conflicts so a native exit cannot silently discard changes', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  f.editor.model.setValue('local unsaved edit');
  f.disk.set('project-a:one.js', { ...f.disk.get('project-a:one.js'), content: 'changed externally', revision: 'external-conflict' });
  await f.api.refresh();
  await assert.rejects(f.api.saveAll());
  assert.equal(f.api.hasUnsavedChanges(), true);
  assert.equal(f.disk.get('project-a:one.js').content, 'changed externally');
});

test('serialized tabs, active project and layout restore in a new renderer without hydration overwriting storage', async t => {
  const first = fixture(t); await first.api.ready();
  await first.api.openProject(first.projects[0]); await first.api.openFile('one.js'); await first.api.openFile('two.css');
  await first.api.openProject(first.projects[1]); await first.api.openFile('other.py');
  await first.api.openProject(first.projects[0]); first.api.toggleExpand();
  const layout = first.w.localStorage.getItem('iexa-ide-layout');
  const stored = JSON.parse(layout);
  assert.equal(stored.projectId, 'project-a'); assert.equal(stored.expanded, true);
  let release;
  const projectsWait = new Promise(resolve => { release = resolve; });
  const second = fixture(t, { layout, projectsWait });
  second.api.activate(true);
  assert.equal(second.w.localStorage.getItem('iexa-ide-layout'), layout, 'initial layout painting cannot erase persisted tabs before the projects request finishes');
  release(); await second.api.ready();
  assert.equal(second.api.snapshot().workspaceId, 'project-a');
  assert.equal(second.api.snapshot().expanded, true);
  assert.equal(second.api.snapshot().activeFile, 'two.css');
  assert.deepEqual(Array.from(second.api.snapshot().files, file => file.path), ['one.js', 'two.css']);
  await second.api.openProject(second.projects[1]);
  assert.equal(second.api.snapshot().activeFile, 'other.py');
  assert.equal(second.editor.model.getValue(), 'print("other")\n');
});

test('Ask AI keeps the editor expanded beside chat with the same unsaved model', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  f.api.activate(true); f.api.toggleExpand();
  const model = f.editor.model; model.setValue('live editable draft');
  const contexts = []; f.w.IexaIDEAgent = { openAI: async value => { contexts.push(value); } };
  f.previewRequests.length = 0;
  f.w.document.getElementById('ideAI').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.snapshot().expanded, true);
  assert.equal(f.api.snapshot().active, true);
  assert.equal(f.api.snapshot().activeFile, 'one.js');
  assert.equal(f.api.snapshot().files[0].dirty, true);
  assert.equal(f.editor.model, model);
  assert.equal(f.w.document.body.classList.contains('ide-side-by-side'), true);
  assert.equal(contexts[0].content, 'live editable draft');
  assert.equal(f.previewRequests.filter(input => input.action === 'hide').length, 0);
});

test('expanded IDE uses the shared conversation layout and restores the original panel mode when deactivated', async t => {
  const f = fixture(t); await f.api.ready(); f.api.activate(true); f.api.toggleExpand();
  assert.equal(f.w.document.body.classList.contains('ide-side-by-side'), true);
  const panel = f.w.document.getElementById('idePanel');
  assert.equal(panel.style.left, ''); assert.equal(panel.style.top, ''); assert.equal(panel.style.width, '');
  for (const id of ['filesResizer', 'ideExplorerResizer', 'idePreviewResizer', 'ideLogsResizer']) {
    const divider = f.w.document.getElementById(id); assert.equal(divider.getAttribute('role'), 'separator'); assert.equal(divider.tabIndex, 0);
  }
  f.api.activate(false);
  assert.equal(f.w.document.body.classList.contains('ide-side-by-side'), false);
  assert.equal(f.api.snapshot().expanded, true, 'returning to IDE preserves its expansion preference');
});

for (const dividerId of ['ideExplorerResizer', 'idePreviewResizer', 'ideLogsResizer', 'filesResizer']) {
  test(`IDE drag lifecycle releases ${dividerId} across delayed native hide, interruption and reentry`, async t => {
    const f = fixture(t); await f.api.ready(); await f.api.openProject(f.projects[0]);
    const d = f.w.document;
    const rect = { x: 100, y: 100, left: 100, top: 100, right: 900, bottom: 600, width: 800, height: 500 };
    for (const id of ['idePanel', 'ideCanvas', 'idePreviewViewport']) d.getElementById(id).getBoundingClientRect = () => rect;
    d.getElementById('idePanel').style.display = 'flex';
    Object.defineProperty(d.getElementById('idePanel'), 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(d.getElementById('ideLayout'), 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(d.getElementById('ideMain'), 'clientHeight', { configurable: true, value: 700 });
    Object.defineProperty(d.querySelector('#view-chat .chat-layout'), 'clientWidth', { configurable: true, value: 1400 });
    const frame = async () => { await new Promise(resolve => f.w.requestAnimationFrame(resolve)); await new Promise(resolve => setImmediate(resolve)); };
    f.w.iexaDesktop.ide.status = async ({ workspaceId }) => ({ workspaceId, status: 'running', url: 'http://127.0.0.1:12345/', logs: [] });
    f.api.activate(true); f.api.toggleExpand(); await f.api.refresh(); d.getElementById('ideViewSplit').click(); await frame();
    assert.equal(f.api.snapshot().previewAttached, 'project-a', 'the real public preview path starts attached');
    const divider = d.getElementById(dividerId), nativePreview = f.w.iexaDesktop.ide.preview;
    const pointer = (target, type, x = 200, y = 200) => target.dispatchEvent(new f.w.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const deferHide = () => {
      let release;
      f.w.iexaDesktop.ide.preview = async input => {
        if (input.action === 'hide') await new Promise(resolve => { release = resolve; });
        return nativePreview(input);
      };
      return () => { assert.equal(typeof release, 'function', 'native hide is actually pending'); f.w.iexaDesktop.ide.preview = nativePreview; release(); };
    };
    for (const finish of ['pointerup', 'pointercancel', 'blur']) {
      const release = deferHide(); pointer(divider, 'pointerdown');
      if (finish === 'blur') f.w.dispatchEvent(new f.w.Event('blur')); else pointer(d, finish);
      release(); await frame();
      assert.equal(d.querySelectorAll('.ide-drag-shield').length, 0, `${finish} before hide resolves must not leave a late overlay`);
      assert.equal(f.api.snapshot().previewAttached, 'project-a', `${finish} restores native preview after the pending hide settles`);
      const saved = f.w.localStorage.getItem('iexa-ide-layout');
      const sizes = [d.getElementById('idePanel').style.cssText, d.querySelector('#view-chat .chat-layout').style.cssText];
      pointer(d, 'pointermove', 340, 300);
      assert.equal(f.w.localStorage.getItem('iexa-ide-layout'), saved, 'ended drag no longer consumes movement');
      assert.deepEqual([d.getElementById('idePanel').style.cssText, d.querySelector('#view-chat .chat-layout').style.cssText], sizes, 'ended drag cannot resize a panel');
    }
    const release = deferHide(); pointer(divider, 'pointerdown'); pointer(divider, 'pointerdown');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(d.querySelectorAll('.ide-drag-shield').length, 1, 'a new drag replaces the previous gesture');
    pointer(d, 'pointerup'); pointer(d, 'pointercancel'); release(); await frame();
    assert.equal(d.querySelectorAll('.ide-drag-shield').length, 0, 'duplicate finish events clean up once');
    assert.equal(f.api.snapshot().previewAttached, 'project-a', 'reentry leaves native preview usable');

    const bridge = f.w.iexaDesktop.ide;
    Object.defineProperty(f.w.iexaDesktop, 'ide', { configurable: true, get() { throw new Error('native hide bridge unavailable'); } });
    pointer(divider, 'pointerdown'); await new Promise(resolve => setImmediate(resolve));
    Object.defineProperty(f.w.iexaDesktop, 'ide', { configurable: true, writable: true, value: bridge });
    assert.equal(d.querySelectorAll('.ide-drag-shield').length, 0, 'a rejected native hide releases its modal state and overlay');
    await frame(); assert.equal(f.api.snapshot().previewAttached, 'project-a');

    const closeRelease = deferHide(); pointer(divider, 'pointerdown'); f.w.dispatchEvent(new f.w.Event('pagehide'));
    const attachCount = f.previewRequests.filter(input => input.action === 'attach').length;
    closeRelease(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(d.querySelectorAll('.ide-drag-shield').length, 0, 'page teardown cannot install a delayed shield');
    assert.equal(f.previewRequests.filter(input => input.action === 'attach').length, attachCount, 'page teardown cannot reattach native contents');
  });
}

test('the workspace has a single run toolbar and a shared tabbed output panel outside the browser dock', async t => {
  const f = fixture(t); await f.api.ready();
  const d = f.w.document;
  assert.ok(d.querySelector('.ide-topbar #ideRun'));
  assert.ok(d.querySelector('.ide-topbar #ideScript'));
  assert.ok(d.querySelector('.ide-topbar #ideServerStatus'));
  assert.equal(d.querySelector('#idePreviewColumn #ideRun'), null);
  assert.equal(d.querySelector('#idePreviewColumn #ideLogs'), null);
  assert.ok(d.querySelector('#ideMain > #ideBottomPanel #ideLogs'));
  assert.ok(d.querySelector('#ideBottomPanel #ideLogTab'));
  assert.ok(d.querySelector('#ideBottomPanel #ideErrorsTab'));
  assert.equal(d.querySelector('.ide-editor-toolbar'), null, 'editor action buttons are consolidated into the workspace toolbar');
});

test('wide code, preview and split tabs preserve editor buffers without stacking panels', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  f.api.activate(true); f.api.toggleExpand(); const d = f.w.document, model = f.editor.model;
  assert.equal(d.getElementById('ideEditorColumn').hidden, false);
  assert.equal(d.getElementById('idePreviewColumn').hidden, true, 'ordinary code starts with full editor space');
  model.setValue('draft while previewing');
  d.getElementById('ideViewPreview').click();
  assert.equal(d.getElementById('ideEditorColumn').hidden, true);
  assert.equal(d.getElementById('idePreviewColumn').hidden, false);
  assert.equal(d.getElementById('idePreviewResizer').hidden, true);
  await f.api.openFile('one.js');
  assert.equal(d.getElementById('idePreviewColumn').hidden, true, 'opening code with no running preview restores editor space');
  d.getElementById('ideViewCode').click();
  assert.equal(d.getElementById('ideEditorColumn').hidden, false);
  assert.equal(d.getElementById('idePreviewColumn').hidden, true);
  d.getElementById('ideViewSplit').click();
  assert.equal(d.getElementById('ideEditorColumn').hidden, false);
  assert.equal(d.getElementById('idePreviewColumn').hidden, false);
  assert.equal(d.getElementById('idePreviewResizer').hidden, false);
  assert.equal(f.editor.model, model); assert.equal(model.getValue(), 'draft while previewing');
  assert.equal(f.api.snapshot().files[0].dirty, true);
});

test('narrow IDE selects code or preview and filters errors in the shared panel', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); await f.api.openFile('one.js');
  const d = f.w.document;
  Object.defineProperty(d.getElementById('idePanel'), 'clientWidth', { configurable: true, value: 460 });
  f.api.activate(true); f.api.toggleExpand();
  assert.equal(d.getElementById('ideViewSplit').hidden, true);
  assert.equal(d.getElementById('idePreviewColumn').hidden, true, 'narrow split preference defaults to the code tab');
  d.getElementById('ideViewPreview').click();
  assert.equal(d.getElementById('ideEditorColumn').hidden, true);
  assert.equal(d.getElementById('idePreviewColumn').hidden, false);
  d.getElementById('ideViewCode').click();
  assert.equal(d.getElementById('ideEditorColumn').hidden, false);
  assert.equal(d.getElementById('idePreviewColumn').hidden, true);
  f.w.iexaDesktop.ide.status = async () => ({ status: 'running', url: 'http://127.0.0.1:12345/', logs: [{ level: 'stdout', message: 'server ready' }, { level: 'error', message: 'example runtime error' }] });
  await f.api.refresh();
  d.getElementById('ideErrorsTab').click();
  assert.equal(d.getElementById('ideLogs').textContent, 'example runtime error');
  d.getElementById('ideLogTab').click();
  assert.match(d.getElementById('ideLogs').textContent, /server ready/);
  assert.match(d.getElementById('ideLogs').textContent, /example runtime error/);
});


test('mixed-control action popovers expose dialog semantics and keyboard navigation starts at either end', async t => {
  const f = fixture(t); await f.api.openProject(f.projects[0]); f.api.activate(true);
  const d = f.w.document, trigger = d.getElementById('ideRunMenu'), popup = d.getElementById('ideRunMenuPopup');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(popup.getAttribute('role'), 'dialog');
  assert.equal(popup.getAttribute('aria-modal'), 'false');
  assert.equal(trigger.getAttribute('aria-controls'), popup.id);
  const key = (target, value) => target.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: value, bubbles: true }));
  trigger.focus(); key(trigger, 'ArrowUp');
  assert.equal(popup.hidden, false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(d.activeElement, [...popup.querySelectorAll(':is(button, select):not(:disabled)')].at(-1), 'ArrowUp from trigger reaches the last available control');
  key(d.activeElement, 'Escape');
  assert.equal(popup.hidden, true); assert.equal(d.activeElement, trigger);
  key(trigger, 'ArrowDown'); assert.equal(d.activeElement, d.getElementById('ideTasks'), JSON.stringify({active:d.activeElement.id,items:[...popup.querySelectorAll(':is(button, select):not(:disabled)')].map(el=>el.id)}));
  key(d.activeElement, 'ArrowDown'); assert.equal(d.activeElement, d.getElementById('ideTasks'), 'native select keeps its own option navigation');
  d.getElementById('ideMoreMenu').click();
  assert.equal(popup.hidden, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(d.getElementById('ideMoreMenuPopup').hidden, false);
});
