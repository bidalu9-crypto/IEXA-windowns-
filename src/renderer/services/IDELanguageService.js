// Monaco remains the editor. A project-scoped Python LSP runs asynchronously
// in the main process; no language request blocks a local model edit.
(function (root) {
  'use strict';
  const OWNER = 'iexa-python-lsp';
  const safePath = value => typeof value === 'string' && value && !/^(?:[a-z]:|[\\/])/i.test(value) && !value.replace(/\\/g, '/').split('/').some(part => part === '..');
  const uriFor = (id, path) => `iexa-ide://${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const range = value => value && ({ startLineNumber: value.start.line + 1, startColumn: value.start.character + 1, endLineNumber: value.end.line + 1, endColumn: value.end.character + 1 });
  const markdown = value => {
    if (typeof value === 'string') return { value, isTrusted: false, supportHtml: false };
    if (value?.language) return { value: '```' + value.language.replace(/[^\w+-]/g, '') + '\n' + value.value + '\n```', isTrusted: false, supportHtml: false };
    const text = String(value?.value || '');
    return { value: value?.kind === 'plaintext' ? text.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&') : text, isTrusted: false, supportHtml: false };
  };
  function create(options) {
    const monaco = options.monaco, docs = new Map(), registrations = [];
    const bridge = () => typeof options.bridge === 'function' ? options.bridge() : options.bridge;
    let workspaceId = '', epoch = 0, disposed = false, enabled = options.enabled !== false, status = { status: 'idle' }, transition = Promise.resolve();
    const current = doc => enabled && !disposed && workspaceId === doc.workspaceId && docs.get(doc.model) === doc && !doc.model.isDisposed?.();
    function announce(value) { status = { ...value, workspaceId }; options.onStatus?.(status); }
    function diagnostics() { return [...docs.values()].filter(current).flatMap(doc => (doc.diagnostics || []).map(item => ({ path: doc.path, version: doc.model.getVersionId(), ...item }))); }
    function changed() { options.onDiagnostics?.(diagnostics()); }
    function clear(doc) { doc.diagnostics = []; if (!doc.model.isDisposed?.()) monaco.editor.setModelMarkers(doc.model, OWNER, []); }
    async function request(input) {
      const result = await bridge()?.languageRequest?.(input);
      if (result?.__ideError) throw new Error(result.__ideError.message);
      if (result?.ok === false) throw new Error(result.error?.message || result.error || 'Language service request failed');
      return result || { status: 'unavailable', reason: 'Python language service is not installed' };
    }
    function report(error, turn, id) { if (!disposed && epoch === turn && workspaceId === id) announce({ status: 'error', reason: error?.message || String(error) }); }
    function sync(doc) {
      clearTimeout(doc.timer); doc.timer = 0;
      const turn = epoch, id = workspaceId, version = doc.model.getVersionId(), text = doc.model.getValue();
      if (!current(doc)) return Promise.resolve(false);
      doc.queue = doc.queue.catch(() => {}).then(async () => {
        await transition;
        if (!current(doc) || epoch !== turn || doc.model.getVersionId() !== version) return false;
        if (doc.sentEpoch === turn && doc.sentVersion === version) return true;
        const result = await request({ workspaceId: id, method: doc.sentEpoch === turn ? 'change' : 'open', path: doc.path, text, version });
        if (!current(doc) || epoch !== turn) return false;
        announce(result);
        if (result.status !== 'ready') return false;
        doc.sentEpoch = turn; doc.sentVersion = version;
        return doc.model.getVersionId() === version;
      }).catch(error => { report(error, turn, id); return false; });
      return doc.queue;
    }
    function attach(model, descriptor) {
      if (disposed || docs.has(model) || !/\.(py|pyi|pyw)$/i.test(descriptor.path) || !safePath(descriptor.path)) return;
      const doc = { model, workspaceId: descriptor.workspaceId, path: descriptor.path.replace(/\\/g, '/'), queue: Promise.resolve(), sentEpoch: -1, sentVersion: -1, diagnostics: [], timer: 0 };
      docs.set(model, doc);
      doc.change = model.onDidChangeContent(() => {
        clearTimeout(doc.timer); clear(doc);
        if (!current(doc)) return;
        changed(); doc.timer = setTimeout(() => { void sync(doc); }, options.debounce ?? 160);
      });
      doc.dispose = model.onWillDispose?.(() => detach(model));
      if (current(doc)) void sync(doc);
    }
    function detach(model) {
      const doc = docs.get(model); if (!doc) return;
      docs.delete(model); clearTimeout(doc.timer); doc.change?.dispose(); doc.dispose?.dispose(); clear(doc);
      const turn = epoch;
      // Closing during initialize must follow the pending open, rather than
      // overtake it and leave an orphan document in the language server.
      if (enabled && workspaceId === doc.workspaceId) void doc.queue.catch(() => {}).then(() => {
        if (!disposed && enabled && workspaceId === doc.workspaceId && epoch === turn) return request({ workspaceId: doc.workspaceId, method: 'close', path: doc.path });
      }).catch(() => {});
      changed();
    }
    function switchProject(project) {
      const id = project?.id || ''; if (disposed || id === workspaceId) return;
      const previous = enabled ? workspaceId : '', turn = ++epoch; workspaceId = id;
      docs.forEach(doc => { clearTimeout(doc.timer); doc.timer = 0; clear(doc); }); changed();
      announce({ status: 'idle' });
      // Invalidate immediately. Opening the next document waits only in this
      // asynchronous task; the editor can already show and edit project B.
      transition = transition.then(() => previous ? request({ workspaceId: previous, method: 'release' }).catch(() => {}) : undefined);
      void transition.then(() => { if (disposed || turn !== epoch) return; docs.forEach(doc => { if (current(doc)) void sync(doc); }); });
    }
    function setEnabled(value) {
      value = !!value; if (disposed || value === enabled) return;
      const previous = enabled ? workspaceId : '', turn = ++epoch; enabled = value;
      docs.forEach(doc => { clearTimeout(doc.timer); doc.timer = 0; clear(doc); }); changed(); announce({ status: 'idle' });
      transition = transition.then(() => previous ? request({ workspaceId: previous, method: 'release' }).catch(() => {}) : undefined);
      void transition.then(() => { if (disposed || turn !== epoch || !enabled) return; docs.forEach(doc => { if (current(doc)) void sync(doc); }); });
    }
    async function query(model, method, position, token, extra = {}) {
      const doc = docs.get(model), turn = epoch, version = model.getVersionId();
      if (!doc || !current(doc) || token?.isCancellationRequested) return null;
      let cancelled = false;
      const subscription = token?.onCancellationRequested?.(() => { cancelled = true; });
      try {
        if (!(await sync(doc)) || cancelled || token?.isCancellationRequested || turn !== epoch || !current(doc) || model.getVersionId() !== version) return null;
        const result = await request({ workspaceId: doc.workspaceId, method, path: doc.path, text: model.getValue(), version, position: { line: position.lineNumber - 1, character: position.column - 1 }, ...extra });
        if (cancelled || token?.isCancellationRequested || turn !== epoch || !current(doc) || model.getVersionId() !== version || (result.version !== undefined && result.version !== version)) return null;
        announce(result);
        return result.status === 'ready' ? result.result : null;
      } catch (error) { report(error, turn, doc.workspaceId); return null; }
      finally { subscription?.dispose(); }
    }
    function event(value) {
      if (disposed || !enabled || value?.type !== 'language' || value.workspaceId !== workspaceId) return;
      if (value.kind === 'status') { announce(value); return; }
      if (value.kind !== 'diagnostics') return;
      const doc = [...docs.values()].find(doc => current(doc) && doc.path === value.path);
      // Never attach an unversioned server message to whichever draft happens
      // to be current. In particular, old project A must not mark project B.
      if (!doc || value.version !== doc.model.getVersionId() || doc.sentEpoch !== epoch) return;
      doc.diagnostics = (value.diagnostics || []).filter(item => item?.range?.start && item.range.end).slice(0, 200).map(item => ({ ...item }));
      monaco.editor.setModelMarkers(doc.model, OWNER, doc.diagnostics.map(item => ({
        ...range(item.range), message: String(item.message), source: item.source || 'Python', code: item.code === undefined ? undefined : String(item.code),
        severity: [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][item.severity || 1],
      })));
      changed();
    }
    function locations(result) {
      return (Array.isArray(result) ? result : result ? [result] : []).filter(item => safePath(item.path) && (item.range || item.targetSelectionRange || item.targetRange)).map(item => ({
        uri: monaco.Uri.parse(uriFor(workspaceId, item.path.replace(/\\/g, '/'))), range: range(item.targetSelectionRange || item.range || item.targetRange),
      }));
    }
    const language = monaco.languages;
    if (language?.registerCompletionItemProvider) registrations.push(language.registerCompletionItemProvider('python', {
      triggerCharacters: ['.'],
      async provideCompletionItems(model, position, context, token) {
        const result = await query(model, 'completion', position, token, { context: { triggerKind: context?.triggerKind === 0 ? 1 : context?.triggerKind === 1 ? 2 : 3, triggerCharacter: context?.triggerCharacter } });
        const items = Array.isArray(result) ? result : result?.items || [], word = model.getWordUntilPosition?.(position);
        const defaultRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word?.startColumn || position.column, endColumn: word?.endColumn || position.column };
        const kinds = ['', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
        return { incomplete: !!result?.isIncomplete, suggestions: items.map(item => ({
          label: item.label, kind: language.CompletionItemKind?.[kinds[item.kind]] ?? language.CompletionItemKind?.Text ?? 0,
          detail: item.detail, documentation: item.documentation ? markdown(item.documentation) : undefined,
          insertText: item.textEdit?.newText ?? item.insertText ?? (typeof item.label === 'string' ? item.label : item.label?.label),
          insertTextRules: item.insertTextFormat === 2 ? language.CompletionItemInsertTextRule?.InsertAsSnippet : undefined,
          range: range(item.textEdit?.range || item.textEdit?.replace || result?.itemDefaults?.editRange?.replace || result?.itemDefaults?.editRange) || defaultRange,
          sortText: item.sortText, filterText: item.filterText, preselect: item.preselect,
          additionalTextEdits: (item.additionalTextEdits || []).map(edit => ({ range: range(edit.range), text: edit.newText })),
        })) };
      },
    }));
    if (language?.registerHoverProvider) registrations.push(language.registerHoverProvider('python', {
      async provideHover(model, position, token) { const result = await query(model, 'hover', position, token); return result?.contents ? { contents: (Array.isArray(result.contents) ? result.contents : [result.contents]).map(markdown), range: range(result.range) } : null; },
    }));
    if (language?.registerDefinitionProvider) registrations.push(language.registerDefinitionProvider('python', {
      async provideDefinition(model, position, token) { return locations(await query(model, 'definition', position, token)); },
    }));
    if (language?.registerReferenceProvider) registrations.push(language.registerReferenceProvider('python', {
      async provideReferences(model, position, context, token) { return locations(await query(model, 'references', position, token, { includeDeclaration: !!context.includeDeclaration })); },
    }));
    if (monaco.editor.registerEditorOpener && options.openFile) registrations.push(monaco.editor.registerEditorOpener({
      async openCodeEditor(_source, resource, selection) {
        const prefix = `iexa-ide://${encodeURIComponent(workspaceId)}/`, value = resource.toString();
        if (!workspaceId || !value.startsWith(prefix)) return false;
        let path; try { path = value.slice(prefix.length).split('/').map(decodeURIComponent).join('/'); } catch { return false; }
        if (!safePath(path)) return false;
        await options.openFile(path, selection); return true;
      },
    }));
    const unsubscribe = bridge()?.onEvent?.(event);
    return Object.freeze({ attach, detach, switchProject, setEnabled, diagnostics, status: () => status,
      dispose() {
        if (disposed) return; const previous = enabled ? workspaceId : ''; disposed = true; epoch++; workspaceId = '';
        unsubscribe?.(); registrations.forEach(item => item?.dispose());
        docs.forEach(doc => { clearTimeout(doc.timer); doc.change?.dispose(); doc.dispose?.dispose(); clear(doc); }); docs.clear();
        if (previous) void request({ workspaceId: previous, method: 'release' }).catch(() => {});
      },
    });
  }
  root.IexaIDELanguageService = Object.freeze({ create });
})(window);
