'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, handler) {
  const dom = new JSDOM('', { runScripts: 'outside-only', url: 'http://localhost/' }), w = dom.window;
  const providers = {}, requests = [], markers = [], statuses = [], diagnosticEvents = [], listeners = new Set(), opened = [], registrations = [];
  let opener;
  const register = key => (_language, provider) => { providers[key] = provider; const item = { disposed: false, dispose() { this.disposed = true; } }; registrations.push(item); return item; };
  const monaco = {
    Uri: { parse: value => ({ toString: () => value }) }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    languages: {
      CompletionItemKind: { Text: 0, Function: 1 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: register('completion'), registerHoverProvider: register('hover'), registerDefinitionProvider: register('definition'), registerReferenceProvider: register('references'),
    },
    editor: {
      setModelMarkers(model, owner, value) { markers.push({ model, owner, value: plain(value) }); },
      registerEditorOpener(value) { opener = value; return { dispose() { opener = null; } }; },
    },
  };
  const bridge = {
    async languageRequest(input) { requests.push(plain(input)); return handler?.(input) ?? { status: 'ready', version: input.version, result: input.method === 'completion' ? [{ label: 'print', kind: 3, insertText: 'print($1)', insertTextFormat: 2 }] : null }; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  w.eval(fs.readFileSync(path.resolve(__dirname, '../src/renderer/services/IDELanguageService.js'), 'utf8'));
  const service = w.IexaIDELanguageService.create({ monaco, bridge, debounce: 12,
    onStatus: value => statuses.push(plain(value)), onDiagnostics: value => diagnosticEvents.push(plain(value)),
    openFile: async (file, selection) => opened.push({ file, selection: plain(selection) }),
    enabled: handler?.enabled,
  });
  t.after(() => { service.dispose(); w.close(); });
  function model(initial = 'pri', file = 'main.py') {
    let text = initial, version = 1, disposed = false;
    const changes = new Set(), disposals = new Set();
    return {
      uri: monaco.Uri.parse('iexa-ide://a/' + file), getValue: () => text, getVersionId: () => version, isDisposed: () => disposed,
      getWordUntilPosition: position => ({ startColumn: 1, endColumn: position.column }),
      onDidChangeContent(listener) { changes.add(listener); return { dispose: () => changes.delete(listener) }; },
      onWillDispose(listener) { disposals.add(listener); return { dispose: () => disposals.delete(listener) }; },
      setValue(value) { text = value; version++; [...changes].forEach(listener => listener()); },
      dispose() { [...disposals].forEach(listener => listener()); disposed = true; changes.clear(); disposals.clear(); },
      get listeners() { return changes.size + disposals.size; },
    };
  }
  function attach(value, workspaceId = 'a', file = 'main.py') { service.attach(value, { workspaceId, path: file }); }
  function emit(value) { [...listeners].forEach(listener => listener({ type: 'language', workspaceId: 'a', ...value })); }
  return { service, providers, requests, markers, statuses, diagnosticEvents, model, attach, emit, listeners, opened, registrations, get opener() { return opener; } };
}
async function start(f, value = f.model()) { f.service.switchProject({ id: 'a' }); f.attach(value); await tick(); await tick(); return value; }
const position = { lineNumber: 1, column: 4 };
function diagnostic(version, message = 'Unknown name') { return { kind: 'diagnostics', path: 'main.py', version, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message, source: 'Pyright' }] }; }

test('registers real Python providers, opens Python only, translates completion coordinates/snippets without writing the document', async t => {
  const f = fixture(t), model = await start(f);
  f.attach(f.model('const x=1', 'web.js'), 'a', 'web.js');
  const result = await f.providers.completion.provideCompletionItems(model, position, { triggerKind: 0 });
  assert.deepEqual(f.requests.map(item => item.method), ['open', 'completion']);
  assert.equal(f.requests[0].text, 'pri'); assert.equal(f.requests[1].text, 'pri');
  assert.deepEqual(f.requests[1].position, { line: 0, character: 3 });
  assert.equal(result.suggestions[0].label, 'print'); assert.equal(result.suggestions[0].insertTextRules, 4);
  assert.deepEqual(plain(result.suggestions[0].range), { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 4 });
  assert.equal(model.getValue(), 'pri'); assert.equal(model.getVersionId(), 1);
});

test('typing changes the local draft synchronously; a query flushes one latest snapshot before requesting completion', async t => {
  const f = fixture(t), model = await start(f);
  model.setValue('p'); model.setValue('pr'); model.setValue('print');
  assert.equal(model.getValue(), 'print'); assert.equal(f.requests.length, 1, 'no IPC on the local editing stack');
  await f.providers.completion.provideCompletionItems(model, position, { triggerKind: 0 });
  assert.deepEqual(f.requests.map(item => item.method), ['open', 'change', 'completion']);
  assert.equal(f.requests[1].text, 'print'); assert.equal(f.requests[1].version, 4);
  assert.equal(f.requests[2].version, 4);
});

test('Python stub and windowed files receive the same completion and draft synchronization as .py', async t => {
  const f = fixture(t); f.service.switchProject({ id: 'a' });
  for (const file of ['types.pyi', 'window.pyw']) {
    const model = f.model('pri', file); f.attach(model, 'a', file);
    await tick(); await tick();
    const result = await f.providers.completion.provideCompletionItems(model, position, { triggerKind: 0 });
    assert.equal(result.suggestions[0].label, 'print');
    assert.equal(f.requests.at(-1).method, 'completion'); assert.equal(f.requests.at(-1).path, file);
    model.setValue('latest unsaved text');
    await f.providers.hover.provideHover(model, position);
    assert.equal(f.requests.at(-1).text, 'latest unsaved text'); assert.equal(f.requests.at(-1).version, 2);
    model.dispose(); await tick();
    assert.equal(f.requests.at(-1).method, 'close'); assert.equal(f.requests.at(-1).path, file);
  }
});

test('a late completion for an old model version is discarded, including identical text restored by a newer edit', async t => {
  const pending = deferred(); const f = fixture(t, input => input.method === 'completion' ? pending.promise : undefined), model = await start(f);
  const completion = f.providers.completion.provideCompletionItems(model, position, {}); await tick();
  model.setValue('different'); model.setValue('pri'); pending.resolve({ status: 'ready', version: 1, result: [{ label: 'OLD' }] });
  const result = await completion; assert.equal(result.suggestions.length, 0); assert.equal(model.getValue(), 'pri');
});

test('project switching releases A while preserving its unsaved model and fences A results from B', async t => {
  const pending = deferred(); const f = fixture(t, input => input.method === 'completion' ? pending.promise : undefined), a = await start(f);
  a.setValue('unsaved A');
  const completion = f.providers.completion.provideCompletionItems(a, position, {}); await tick();
  const b = f.model('B'); f.attach(b, 'b'); f.service.switchProject({ id: 'b' }); await tick(); await tick();
  assert.ok(f.requests.some(input => input.workspaceId === 'a' && input.method === 'release'));
  assert.ok(f.requests.some(input => input.workspaceId === 'b' && input.method === 'open'));
  pending.resolve({ status: 'ready', version: 2, result: [{ label: 'OLD A' }] });
  assert.equal((await completion).suggestions.length, 0); assert.equal(a.getValue(), 'unsaved A'); assert.equal(a.isDisposed(), false);
  f.service.switchProject({ id: 'a' }); await tick(); await tick();
  assert.equal(f.requests.filter(input => input.method === 'open' && input.workspaceId === 'a').at(-1).text, 'unsaved A');
});

test('rapid A/B/A switching waits for release completion before reopening A, without blocking local edits', async t => {
  const pending = deferred(); const f = fixture(t, input => input.method === 'release' && input.workspaceId === 'a' ? pending.promise : undefined), model = await start(f);
  f.service.switchProject({ id: 'b' }); f.service.switchProject({ id: 'a' }); model.setValue('LATEST A');
  await tick(); assert.equal(f.requests.filter(input => input.method === 'open').length, 1);
  pending.resolve({ status: 'idle' }); await tick(); await tick();
  const opened = f.requests.filter(input => input.method === 'open'); assert.equal(opened.length, 2); assert.equal(opened.at(-1).text, 'LATEST A');
  assert.equal(opened.at(-1).workspaceId, 'a');
});

test('diagnostics require the current workspace and exact version; typing clears stale markers immediately', async t => {
  const f = fixture(t), model = await start(f);
  f.emit(diagnostic(1)); assert.equal(f.service.diagnostics().length, 1);
  assert.deepEqual(f.markers.at(-1).value[0], { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4, message: 'Unknown name', source: 'Pyright', severity: 8 });
  model.setValue('new'); assert.deepEqual(f.markers.at(-1).value, []);
  f.emit(diagnostic(1)); f.emit(diagnostic(undefined)); f.emit({ ...diagnostic(2), workspaceId: 'b' });
  assert.equal(f.service.diagnostics().length, 0);
  await f.providers.hover.provideHover(model, position); f.emit(diagnostic(2));
  assert.equal(f.service.diagnostics()[0].version, 2);
  f.service.switchProject({ id: 'b' }); f.emit(diagnostic(2)); assert.equal(f.service.diagnostics().length, 0);
});

test('model disposal closes the document, removes subscriptions and prevents late diagnostics', async t => {
  const f = fixture(t), model = await start(f); model.dispose(); await tick();
  assert.equal(model.listeners, 0); assert.equal(f.requests.at(-1).method, 'close');
  f.emit(diagnostic(1)); assert.equal(f.service.diagnostics().length, 0);
  f.service.dispose(); assert.equal(f.listeners.size, 0); assert.ok(f.registrations.every(item => item.disposed));
});

test('definition/references use host-authorized relative paths; Monaco opener refuses another project and traversal', async t => {
  const f = fixture(t, input => ['definition', 'references'].includes(input.method) ? { status: 'ready', version: input.version, result: [{ path: 'lib/utils.py', range: { start: { line: 2, character: 1 }, end: { line: 2, character: 6 } } }, { path: '../outside.py', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } }] } : undefined), model = await start(f);
  const result = await f.providers.definition.provideDefinition(model, position);
  assert.equal(result.length, 1); assert.equal(result[0].uri.toString(), 'iexa-ide://a/lib/utils.py');
  assert.equal(await f.opener.openCodeEditor(null, result[0].uri, result[0].range), true);
  assert.equal(f.opened[0].file, 'lib/utils.py'); assert.equal(f.opened[0].selection.startLineNumber, 3);
  assert.equal(await f.opener.openCodeEditor(null, { toString: () => 'iexa-ide://b/lib/utils.py' }), false);
  assert.equal(await f.opener.openCodeEditor(null, { toString: () => 'iexa-ide://a/%2E%2E/outside.py' }), false);
  await f.providers.references.provideReferences(model, position, { includeDeclaration: true });
  assert.equal(f.requests.at(-1).includeDeclaration, true);
});

test('hover markdown is untrusted, completion cancellation releases the token subscription, and unavailable stays explicit', async t => {
  const pending = deferred(); const f = fixture(t, input => input.method === 'hover' ? { status: 'ready', result: { contents: { kind: 'markdown', value: '[run](command:danger)' } } } : input.method === 'completion' ? pending.promise : undefined), model = await start(f);
  const hover = await f.providers.hover.provideHover(model, position); assert.equal(hover.contents[0].isTrusted, false); assert.equal(hover.contents[0].supportHtml, false);
  let cancel, subscriptions = 0;
  const token = { isCancellationRequested: false, onCancellationRequested(listener) { cancel = listener; subscriptions++; return { dispose() { subscriptions--; } }; } };
  const completion = f.providers.completion.provideCompletionItems(model, position, {}, token); await tick(); cancel();
  pending.resolve({ status: 'ready', version: 1, result: [{ label: 'late' }] }); assert.equal((await completion).suggestions.length, 0); assert.equal(subscriptions, 0);
  const unavailable = fixture(t, () => ({ status: 'unavailable', reason: 'Missing bundled Python language server' })), other = await start(unavailable);
  assert.equal((await unavailable.providers.completion.provideCompletionItems(other, position, {})).suggestions.length, 0);
  assert.equal(unavailable.service.status().status, 'unavailable'); assert.match(unavailable.service.status().reason, /Missing/);
});

test('disabled IDE never starts Python; enable opens latest draft and disable releases while preserving it', async t => {
  const handler = () => undefined; handler.enabled = false;
  const f = fixture(t, handler), model = await start(f);
  model.setValue('DRAFT WHILE HIDDEN'); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.requests.length, 0); assert.equal((await f.providers.completion.provideCompletionItems(model, position, {})).suggestions.length, 0);
  f.service.setEnabled(true); await tick(); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'open'); assert.equal(f.requests[0].text, 'DRAFT WHILE HIDDEN');
  f.service.setEnabled(false); model.setValue('HIDDEN AGAIN'); await tick();
  assert.equal(f.requests.at(-1).method, 'release'); const count = f.requests.length;
  f.service.switchProject({ id: 'b' }); f.service.switchProject({ id: 'a' }); await tick(); assert.equal(f.requests.length, count);
  f.service.setEnabled(true); await tick(); await tick(); assert.equal(f.requests.at(-1).text, 'HIDDEN AGAIN'); assert.equal(model.isDisposed(), false);
});

test('disposing a document during its delayed open closes it after initialization completes', async t => {
  const pending = deferred(); const f = fixture(t, input => input.method === 'open' ? pending.promise : undefined), model = f.model();
  f.service.switchProject({ id: 'a' }); f.attach(model); await tick(); model.dispose();
  assert.deepEqual(f.requests.map(input => input.method), ['open']);
  pending.resolve({ status: 'ready', version: 1 }); await tick(); await tick();
  assert.deepEqual(f.requests.map(input => input.method), ['open', 'close']); assert.equal(model.listeners, 0);
});
