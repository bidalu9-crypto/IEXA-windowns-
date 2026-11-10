'use strict';
// Load the actual workbench and invoke its registered provider through the
// Monaco action contract. Native Monaco undo/rendering has separate Electron
// coverage; this fixture supplies model/action plumbing, not formatting logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const renderer = path.resolve(__dirname, '../src/renderer');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function fixture(t, options = {}) {
  global.gc?.();
  const dom = new JSDOM(fs.readFileSync(path.join(renderer, 'index.html'), 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const projects = [{ id: 'project-a', root: 'C:/projects/a', name: 'A' }, { id: 'project-b', root: 'C:/projects/b', name: 'B' }];
  const disk = new Map([
    ['project-a:one.py', { path: 'one.py', content: 'def one():\n    return {"one":1}\n', revision: 'a1' }],
    ['project-a:two.py', { path: 'two.py', content: 'def two():\n  return 2\n', revision: 'a2' }],
    ['project-a:tabs.py', { path: 'tabs.py', content: 'def tabs():\n\treturn 3\n', revision: 'a3' }],
    ['project-a:web.js', { path: 'web.js', content: 'const x=1;\n', revision: 'a4' }],
    ['project-b:one.py', { path: 'one.py', content: 'print("other project")\n', revision: 'b1' }],
  ]);
  const models = [], registrations = [], markers = [], formatRequests = [], cancels = [], writes = [], actionRuns = [], actionEdits = [], languageRequests = [], contexts = [], contextSignals = [];
  let provider, disposedRegistrations = 0, activeToken;
  const token = () => {
    const listeners = new Set();
    return {
      isCancellationRequested: false,
      onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
      cancel() { if (this.isCancellationRequested) return; this.isCancellationRequested = true; [...listeners].forEach(listener => listener()); },
      get listeners() { return listeners.size; },
    };
  };
  const editor = {
    model: null, disposed: false, revealLines: [], focusCalls: 0,
    setModel(model) { if (this.model !== model) activeToken?.cancel(); this.model = model; },
    getModel() { return this.model; }, focus() { this.focusCalls++; },
    saveViewState: () => ({}), restoreViewState() {}, addCommand() {}, layout() {},
    onDidChangeCursorPosition() {}, onDidChangeCursorSelection() {},
    getPosition: () => ({ lineNumber: 1, column: 1 }), getSelection: () => options.selection ? {} : null,
    revealLineInCenter(line) { this.revealLines.push(line); },
    dispose() { this.disposed = true; activeToken?.cancel(); },
    getAction(id) {
      if (id !== 'editor.action.formatDocument' || options.missingAction) return null;
      return {
        isSupported: () => !options.unsupported && (this.model?.language !== 'python' || !!provider),
        run: async () => {
          const model = this.model, version = model.getVersionId(), currentToken = token(); activeToken = currentToken;
          actionRuns.push({ id, model, token: currentToken });
          // Monaco routes Python to its registered provider. The test never
          // copies or reimplements the workbench provider's request/guard code.
          const edits = await provider.provideDocumentFormattingEdits(model, { tabSize: 4, insertSpaces: true }, currentToken);
          actionEdits.push(edits);
          if (!currentToken.isCancellationRequested && !model.isDisposed() && model.getVersionId() === version && edits.length) model.applyEdits(edits);
          if (activeToken === currentToken) activeToken = null;
        },
      };
    },
  };
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.IexaDialogs = { confirm: async () => true, prompt: async () => null };
  w.monaco = {
    Uri: { parse: value => value }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 }, MarkerSeverity: { Error: 8 },
    languages: { registerDocumentFormattingEditProvider(language, value) {
      registrations.push({ language, provider: value }); provider = value;
      return { dispose() { disposedRegistrations++; provider = null; } };
    } },
    editor: {
      create: () => editor, setTheme() {},
      setModelMarkers(model, owner, values) { markers.push({ model, owner, values: plain(values) }); },
      createModel(initial, _language, uri) {
        let text = initial, version = 1;
        const listeners = new Set(), disposalListeners = new Set(), undo = [];
        const model = {
          uri, language: /\.js$/.test(uri) ? 'javascript' : 'python', disposed: false, indentCalls: [], editOperations: [], setValueCalls: 0,
          getLineCount: () => text.split(/\r\n|\r|\n/).length, getValue: () => text, getVersionId: () => version, isDisposed() { return this.disposed; },
          getValueInRange: () => options.selection || '',
          getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: text.split('\n').length, endColumn: text.split('\n').at(-1).length + 1 }),
          detectIndentation(insertSpaces, tabSize) { this.indentCalls.push({ insertSpaces, tabSize }); },
          onDidChangeContent(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
          onWillDispose(listener) { disposalListeners.add(listener); return { dispose: () => disposalListeners.delete(listener) }; },
          setValue(value) { this.setValueCalls++; text = value; version++; [...listeners].forEach(listener => listener()); },
          applyEdits(edits) { this.editOperations.push(plain(edits)); undo.push(text); text = edits[0].text; version++; [...listeners].forEach(listener => listener()); },
          undo() { if (!undo.length) return; text = undo.pop(); version++; [...listeners].forEach(listener => listener()); },
          dispose() { [...disposalListeners].forEach(listener => listener()); this.disposed = true; listeners.clear(); disposalListeners.clear(); },
        };
        models.push(model); return model;
      },
    },
  };
  const bridge = {
    projects: async () => ({ projects }), chooseFolder: async () => projects[0],
    list: async ({ workspaceId }) => ({ entries: [...disk.entries()].filter(([key]) => key.startsWith(workspaceId + ':')).map(([, value]) => ({ name: value.path, path: value.path, directory: false, size: value.content.length })) }),
    read: async ({ workspaceId, path: file }) => { const record = disk.get(workspaceId + ':' + file); assert.ok(record); return { ...record }; },
    write: async request => { writes.push(plain(request)); throw new Error('Formatting must not save'); },
    inspect: async () => ({ type: 'none', scripts: [] }), status: async () => ({ status: 'stopped', logs: [], url: '' }),
    context: async input => { contexts.push(plain(input)); return options.context?.(input) ?? { ok: true }; }, preview: async () => ({ visible: false }), onEvent: () => () => {},
    languageRequest: async input => { languageRequests.push(plain(input)); return { status: 'ready', version: input.version }; },
    format: async input => {
      formatRequests.push(plain(input));
      if (options.format) return options.format(input);
      return { workspaceId: input.workspaceId, path: input.path, modelVersion: input.modelVersion, content: 'def one():\n    return {"one": 1}\n', changed: true, formatter: { name: 'ruff', version: '0.14.4' }, diagnostics: [] };
    },
    formatCancel: async input => { cancels.push(plain(input)); return { ok: true }; },
  };
  if (options.missingFormat) delete bridge.format;
  w.iexaDesktop = { ide: bridge };
  w.IexaIDEAgent = { contextChanged: value => contextSignals.push(value && plain(value)) };
  if (options.language) w.eval(fs.readFileSync(path.join(renderer, 'services/IDELanguageService.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(renderer, 'services/IDEWorkspace.js'), 'utf8'));
  const api = w.IexaIDE;
  const close = () => { if (w.closed) return; w.dispatchEvent(new w.Event('pagehide')); w.close(); };
  t.after(close);
  return { w, api, editor, models, disk, projects, formatRequests, cancels, writes, registrations, markers, actionRuns, actionEdits, languageRequests, contexts, contextSignals, close, get disposedRegistrations() { return disposedRegistrations; }, get provider() { return provider; } };
}
async function open(f, file = 'one.py') { await f.api.ready(); await f.api.openFile(file); return f.editor.model; }
function reply(input, extra = {}) { return { workspaceId: input.workspaceId, path: input.path, modelVersion: input.modelVersion, content: 'FORMATTED\n', changed: true, formatter: { name: 'ruff', version: '0.14.4' }, diagnostics: [], ...extra }; }

test('formatDocument invokes Monaco action and the actual registered Python provider, returning one undoable unsaved edit', async t => {
  const f = fixture(t), model = await open(f), before = model.getValue();
  await f.api.formatDocument();
  assert.equal(f.actionRuns.length, 1);
  assert.equal(f.actionRuns[0].id, 'editor.action.formatDocument');
  assert.equal(f.formatRequests.length, 1);
  assert.deepEqual(f.formatRequests[0], { workspaceId: 'project-a', path: 'one.py', modelVersion: 1, requestId: 1, content: before });
  assert.equal(model.editOperations.length, 1);
  assert.equal(model.editOperations[0].length, 1);
  assert.equal(model.setValueCalls, 0, 'workbench must let Monaco apply the provider edit');
  assert.equal(model.getValue(), 'def one():\n    return {"one": 1}\n');
  assert.equal(f.api.snapshot().files[0].dirty, true);
  assert.equal(f.writes.length, 0);
  assert.equal(f.disk.get('project-a:one.py').content, before);
  assert.equal(f.w.document.getElementById('ideFormat').disabled, false);
  assert.equal(f.w.document.getElementById('ideFormat').hasAttribute('aria-busy'), false);
  assert.match(f.w.document.getElementById('ideStatus').textContent, /Ctrl\+Z.*ruff 0\.14\.4/);
  assert.deepEqual(f.markers.at(-1).values, []);
  model.undo();
  assert.equal(model.getValue(), before);
  assert.equal(f.api.snapshot().files[0].dirty, false);
  assert.equal(f.actionRuns[0].token.listeners, 0, 'provider cancellation subscription released');
});

test('Python models request four-space indentation detection without changing existing two-space or tab source', async t => {
  const f = fixture(t);
  for (const file of ['one.py', 'two.py', 'tabs.py']) {
    const model = await open(f, file);
    assert.deepEqual(model.indentCalls, [{ insertSpaces: true, tabSize: 4 }]);
    assert.equal(model.getValue(), f.disk.get('project-a:' + file).content);
  }
  const js = await open(f, 'web.js'); assert.deepEqual(js.indentCalls, [{ insertSpaces: true, tabSize: 2 }]);
  await f.api.openFile('two.py');
  assert.equal(f.editor.model.indentCalls.length, 1, 'reusing a model preserves its detected settings');
  assert.equal(f.formatRequests.length, 0);
});

test('typing cancels the in-flight snapshot and an outdated response cannot overwrite current edits', async t => {
  const pending = deferred(); let input;
  const f = fixture(t, { format: request => { input = request; return pending.promise; } }), model = await open(f);
  const formatting = f.api.formatDocument(); await tick();
  assert.equal(f.w.document.getElementById('ideFormat').getAttribute('aria-busy'), 'true');
  model.setValue('MY NEW DRAFT\n');
  assert.equal(f.cancels.length, 1);
  assert.deepEqual(f.cancels[0], { workspaceId: 'project-a', path: 'one.py', modelVersion: 1, requestId: 1 });
  pending.resolve(reply(input)); await formatting;
  assert.equal(model.getValue(), 'MY NEW DRAFT\n');
  assert.equal(model.editOperations.length, 0);
  assert.equal(f.writes.length, 0);
  assert.match(f.api.snapshot().error, /代码已变化/);
});

test('even typing then restoring identical text invalidates the earlier model version', async t => {
  const pending = deferred(); let input;
  const f = fixture(t, { format: request => { input = request; return pending.promise; } }), model = await open(f), original = model.getValue();
  const formatting = f.api.formatDocument(); await tick(); model.setValue('temporary'); model.setValue(original);
  pending.resolve(reply(input)); await formatting;
  assert.equal(model.getValue(), original);
  assert.equal(model.getVersionId(), 3);
  assert.equal(model.editOperations.length, 0);
});

test('responses with a mismatched model version or file path return no edits', async t => {
  for (const mismatch of [{ modelVersion: 99 }, { path: 'two.py' }]) {
    const f = fixture(t, { format: async input => reply(input, mismatch) }), model = await open(f), before = model.getValue();
    await f.api.formatDocument();
    assert.equal(model.getValue(), before);
    assert.equal(model.editOperations.length, 0);
    assert.match(f.api.snapshot().error, /代码已变化/);
  }
});

test('switching tabs or projects cancels Monaco formatting and never writes the result into another file', async t => {
  for (const switchProject of [false, true]) {
    const pending = deferred(); let input;
    const f = fixture(t, { format: request => { input = request; return pending.promise; } }), originalModel = await open(f), original = originalModel.getValue();
    const formatting = f.api.formatDocument(); await tick();
    if (switchProject) { await f.api.openProject(f.projects[1]); await f.api.openFile('one.py'); }
    else await f.api.openFile('two.py');
    const nextModel = f.editor.model, nextOriginal = nextModel.getValue();
    assert.equal(f.cancels.length, 1);
    pending.resolve(reply(input)); await formatting;
    assert.equal(nextModel.getValue(), nextOriginal);
    assert.equal(originalModel.getValue(), original);
    assert.equal(originalModel.editOperations.length, 0);
    assert.equal(nextModel.editOperations.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('structured bridge syntax errors mark exact Python ranges, preserve text and restore the format control', async t => {
  const f = fixture(t, { format: async () => ({ __ideError: { code: 'IDE_FORMAT_SYNTAX', message: 'Python 缩进错误，已保留原文', diagnostics: [{ message: 'unindent does not match any outer indentation level', severity: 'error', line: 3, column: 12, endLine: 3, endColumn: 13 }] } }) }), model = await open(f);
  const source = 'def bad():\n    print(1)\n   print(2)\n'; model.setValue(source);
  await f.api.formatDocument();
  assert.equal(model.getValue(), source);
  assert.equal(model.editOperations.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.markers.at(-1).model, model);
  assert.equal(f.markers.at(-1).owner, 'iexa-python-format');
  assert.deepEqual(f.markers.at(-1).values, [{ message: 'unindent does not match any outer indentation level', severity: 8, startLineNumber: 3, startColumn: 12, endLineNumber: 3, endColumn: 13 }]);
  assert.deepEqual(f.editor.revealLines, [3]);
  assert.match(f.api.snapshot().error, /Python 缩进错误/);
  assert.equal(f.w.document.getElementById('ideFormat').disabled, false);
});

test('syntax failures for a changed model cannot paint stale markers onto later content', async t => {
  const pending = deferred();
  const f = fixture(t, { format: () => pending.promise }), model = await open(f);
  const formatting = f.api.formatDocument(); await tick(); model.setValue('later_valid = 1\n');
  pending.resolve({ __ideError: { code: 'IDE_FORMAT_SYNTAX', message: 'stale error', diagnostics: [{ message: 'bad', line: 3, column: 1 }] } });
  await formatting;
  assert.equal(model.getValue(), 'later_valid = 1\n');
  assert.equal(f.markers.length, 0);
});

test('overlapping provider requests keep their own request IDs and an older completion cannot clear the newer cancellation fence', async t => {
  const waiting = [], inputs = [];
  const f = fixture(t, { format: input => { const request = deferred(); waiting.push(request); inputs.push(input); return request.promise; } }), model = await open(f);
  const first = f.provider.provideDocumentFormattingEdits(model, {}, {});
  const second = f.provider.provideDocumentFormattingEdits(model, {}, {});
  await tick();
  assert.deepEqual(inputs.map(input => input.requestId), [1, 2]);
  assert.deepEqual(inputs.map(input => input.modelVersion), [1, 1]);
  waiting[0].resolve(reply(inputs[0]));
  assert.deepEqual(plain(await first), []);
  assert.equal(f.markers.length, 0, 'older completion cannot clear current markers');
  model.setValue('new input after first completion\n');
  assert.deepEqual(f.cancels.at(-1), { workspaceId: 'project-a', path: 'one.py', modelVersion: 1, requestId: 2 });
  waiting[1].resolve(reply(inputs[1]));
  assert.deepEqual(plain(await second), []);
  assert.equal(model.getValue(), 'new input after first completion\n');
});

test('an older failed request cannot replace the successful newer status or markers for the same model version', async t => {
  const waiting = [], inputs = [];
  const f = fixture(t, { format: input => { const request = deferred(); waiting.push(request); inputs.push(input); return request.promise; } }), model = await open(f);
  const first = f.provider.provideDocumentFormattingEdits(model, {}, {});
  const second = f.provider.provideDocumentFormattingEdits(model, {}, {});
  await tick();
  waiting[1].resolve(reply(inputs[1], { changed: false, content: model.getValue() }));
  assert.deepEqual(plain(await second), []);
  const status = f.w.document.getElementById('ideStatus').textContent;
  waiting[0].resolve({ __ideError: { code: 'IDE_FORMAT_SYNTAX', message: 'OLD ERROR', diagnostics: [{ message: 'old error', line: 3, column: 1 }] } });
  assert.deepEqual(plain(await first), []);
  assert.equal(f.w.document.getElementById('ideStatus').textContent, status);
  assert.equal(f.api.snapshot().error, '');
  assert.equal(f.markers.length, 1);
  assert.deepEqual(f.markers[0].values, []);
});

test('closing the source model cancels the pending action and no delayed edit reaches its replacement tab', async t => {
  const pending = deferred(); let input;
  const f = fixture(t, { format: request => { input = request; return pending.promise; } }), model = await open(f);
  await f.api.openFile('two.py'); await f.api.openFile('one.py');
  const formatting = f.api.formatDocument(); await tick();
  const tab = f.w.document.querySelector('.ide-editor-tab[data-path="one.py"]');
  tab.querySelector('button:last-child').click(); await tick();
  assert.equal(model.disposed, true);
  assert.equal(f.api.snapshot().activeFile, 'two.py');
  const replacement = f.editor.model, text = replacement.getValue();
  pending.resolve(reply(input)); await formatting;
  assert.equal(f.cancels.length, 1);
  assert.equal(replacement.getValue(), text);
  assert.equal(replacement.editOperations.length, 0);
  assert.equal(f.writes.length, 0);
});

test('missing format bridge or unsupported Monaco action reports a visible actionable message without changing code', async t => {
  for (const options of [{ missingFormat: true }, { missingAction: true }, { unsupported: true }]) {
    const f = fixture(t, options), model = await open(f), original = model.getValue();
    await f.api.formatDocument();
    assert.equal(model.getValue(), original);
    assert.equal(model.editOperations.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.w.document.getElementById('ideStatus').classList.contains('is-error'), true);
    assert.match(f.api.snapshot().error, options.missingFormat ? /桌面|desktop/i : /格式化器/);
  }
});

test('provider registers once across project/model switches and disposes on page teardown', async t => {
  const f = fixture(t); await open(f); await f.api.openFile('two.py'); await f.api.openProject(f.projects[1]); await f.api.openFile('one.py');
  f.api.init(); await f.api.ready();
  assert.equal(f.registrations.length, 1);
  assert.equal(f.registrations[0].language, 'python');
  assert.equal(f.disposedRegistrations, 0);
  f.close();
  assert.equal(f.disposedRegistrations, 1);
  assert.equal(f.editor.disposed, true);
  assert.equal(f.models.every(model => model.disposed), true);
});

test('the actual workbench keeps Python dormant until activated, releases it when hidden and reopens the retained draft', async t => {
  const f = fixture(t, { language: true }), model = await open(f);
  model.setValue('unsaved hidden Python'); await tick();
  assert.equal(f.languageRequests.length, 0);
  f.api.activate(true); await tick(); await tick();
  assert.equal(f.languageRequests.at(-1).method, 'open'); assert.equal(f.languageRequests.at(-1).text, 'unsaved hidden Python');
  f.api.activate(false); await tick(); assert.equal(f.languageRequests.at(-1).method, 'release');
  const count = f.languageRequests.length; model.setValue('retained while hidden'); await tick(); assert.equal(f.languageRequests.length, count);
  f.api.activate(true); await tick(); await tick(); assert.equal(f.languageRequests.at(-1).text, 'retained while hidden');
  assert.equal(model.isDisposed(), false); assert.equal(f.api.hasUnsavedChanges(), true);
});

test('bindProject changes the LSP root, preserves A draft and excludes A paths from B AI context', async t => {
  const f = fixture(t, { language: true }), a = await open(f); f.api.activate(true); await tick();
  a.setValue('UNSAVED A'); await f.api.bindProject(f.projects[1]); await f.api.openFile('one.py'); await tick(); await tick();
  const b = f.editor.model; b.setValue('UNSAVED B'); await f.api.flushContext();
  assert.ok(f.languageRequests.some(input => input.workspaceId === 'project-a' && input.method === 'release'));
  assert.ok(f.languageRequests.some(input => input.workspaceId === 'project-b' && input.method === 'open'));
  const context = f.contexts.at(-1); assert.equal(context.workspaceId, 'project-b'); assert.equal(context.content, 'UNSAVED B');
  assert.deepEqual(context.dirtyFiles, [{ workspaceId: 'project-b', path: 'one.py' }]);
  await f.api.bindProject(null); await tick(); assert.equal(f.api.snapshot().project, null); assert.equal(f.api.hasUnsavedChanges(), true); assert.equal(f.contextSignals.at(-1), null);
  await f.api.bindProject(f.projects[0]); assert.equal(f.editor.model, a); assert.equal(a.getValue(), 'UNSAVED A'); assert.equal(b.isDisposed(), false);
});

test('flushContext sends the latest selection and unsaved draft immediately, caps payload and signals success', async t => {
  const f = fixture(t, { selection: 'S'.repeat(10005) }), model = await open(f);
  model.setValue('C'.repeat(16005));
  for (let i = 0; i < 36; i++) { const file = `extra-${i}.py`; f.disk.set('project-a:' + file, { path: file, content: 'pass', revision: String(i) }); await f.api.openFile(file); }
  await f.api.openFile('one.py'); const before = f.contexts.length;
  const value = await f.api.flushContext();
  assert.equal(f.contexts.length, before + 1); assert.equal(value.content.length, 16000); assert.equal(value.selectedCode.length, 10000);
  assert.equal(value.contentTruncated, true); assert.equal(value.selectionTruncated, true); assert.equal(value.openFiles.length, 32);
  assert.equal(value.content, 'C'.repeat(16000)); assert.deepEqual(f.contextSignals.at(-1), plain(value));
  assert.equal(model.getValue().length, 16005); assert.equal(f.writes.length, 0);
  await f.api.bindProject(null); assert.equal(await f.api.flushContext(), null);
});

test('flushContext exposes bridge failure without claiming synchronization, preserving the draft for normal chat fallback', async t => {
  const f = fixture(t, { context: () => ({ __ideError: { message: 'Context sync failed' } }) }), model = await open(f);
  model.setValue('LOCAL DRAFT'); const before = f.contextSignals.length;
  await assert.rejects(f.api.flushContext(), /Context sync failed/);
  assert.equal(f.contextSignals.length, before); assert.equal(model.getValue(), 'LOCAL DRAFT'); assert.equal(f.api.hasUnsavedChanges(), true);
});
