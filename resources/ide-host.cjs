'use strict';

const { FileWorkspace, IDEError } = require('../dist/main/ide/FileWorkspace');
const { PreviewServerManager } = require('../dist/main/ide/PreviewServerManager');
const { ProjectRunPlanner } = require('../dist/main/ide/ProjectRunPlanner');
const { CodeFormatter } = require('../dist/main/ide/CodeFormatter');
const { GitWorkspace } = require('../dist/main/ide/GitWorkspace');
const { IDEReviewStore } = require('../dist/main/ide/IDEReviewStore');
const { PythonLanguageService } = require('../dist/main/ide/PythonLanguageService');
const { setIDEContext, getIDEContextForRoot, clearIDEContext, appendIDEDiagnostic, updateIDERuntime } = require('../dist/main/ide/IDEContext');

/** Electron-only host. The browser renderer never receives a filesystem or Node capability. */
function installIDEHost({ ipcMain, dialog, WebContentsView, session, app, getWindow, workspaceFile, appOrigin, getProjectRoot }) {
  const files = new FileWorkspace(workspaceFile('.iexa-ide-projects.json'));
  const servers = new PreviewServerManager(files);
  const runPlanner = new ProjectRunPlanner(files);
  const formatter = new CodeFormatter(files);
  const git = new GitWorkspace(files);
  const reviews = new IDEReviewStore(files, workspaceFile('.iexa-ide-reviews.json'));
  const languages = new PythonLanguageService(files, { nodePath: process.execPath, electronRunAsNode: !!process.versions.electron });
  const formatting = new Map();
  const previews = new Map();
  const channels = [];
  let shutdownComplete = false;
  let quitTask;
  let disposed = false;
  let intendedWorkspace = '';
  let shutdownTask;
  let beforeQuitListener;
  const onProcessExit = () => servers.shutdownSync();
  const currentWindow = () => { const win = getWindow(); if (!win || win.isDestroyed()) throw new IDEError('IDE_WINDOW', '主窗口尚未就绪。'); return win; };
  const send = (event) => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('iexa:ide:event', event); };
  const error = (err) => ({ __ideError: { code: err.code || 'IDE_ERROR', message: err.message || '工作台操作失败。', ...(Array.isArray(err.diagnostics) ? { diagnostics: err.diagnostics } : {}) } });
  const handle = (name, callback) => {
    const channel = `iexa:ide:${name}`; channels.push(channel);
    ipcMain.handle(channel, async (event, raw) => {
      try {
        if (disposed) throw new IDEError('IDE_CLOSED', '工作台正在关闭。');
        const win = currentWindow();
        if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new IDEError('IDE_SENDER', '工作台请求来源无效。');
        const protectedOrigin = typeof appOrigin === 'function' ? appOrigin() : appOrigin;
        const senderURL = new URL(event.senderFrame.url);
        if ((protectedOrigin && senderURL.origin !== protectedOrigin) || !['/', '/index.html'].includes(senderURL.pathname)) throw new IDEError('IDE_SENDER', '工作台请求页面无效。');
        const input = raw === undefined ? {} : raw;
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IDEError('IDE_ARGUMENT', '工作台请求参数无效。');
        return await callback(input);
      } catch (err) { return error(err); }
    });
  };
  const workspace = (input, verifyRoot = true) => files.project(input.workspaceId, verifyRoot);
  const onFiles = (event) => send(event);
  const onServer = (event) => {
    send(event);
    try { updateIDERuntime(files.project(event.workspaceId, false).root, { url: event.url, status: event.status, logs: event.logs }); } catch { /* a removed root must not block process cleanup */ }
    const preview = previews.get(event.workspaceId);
    if (preview && !preview.view.webContents.isDestroyed() && event.status === 'running' && event.url && (preview.serviceURL !== event.url || preview.needsReload)) {
      loadService(preview, event.url);
    }
    if (preview && ['starting', 'stopped', 'error'].includes(event.status)) {
      hideRecord(event.workspaceId, preview); preview.needsReload = true;
    }
  };
  files.on('change', onFiles); servers.on('change', onServer);
  reviews.on('change', send);
  languages.on('change', send);

  handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog(currentWindow(), { title: '打开 IDE 项目', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths?.[0]) return null;
    return files.authorize(result.filePaths[0]);
  });
  handle('projects', () => ({ projects: files.projects() }));
  handle('current-project', () => {
    // The server's selected project is authoritative; this IPC never accepts
    // a renderer-supplied root or changes any running conversation's cwd.
    let root;
    if (getProjectRoot) root = getProjectRoot();
    else {
      try { root = JSON.parse(require('node:fs').readFileSync(workspaceFile('.iexa-project.json'), 'utf8')).root; } catch {}
    }
    if (!root) return null;
    const project = files.authorize(root);
    if (!getIDEContextForRoot(project.root)) setIDEContext(project.root, {});
    return project;
  });
  handle('list', input => files.list(workspace(input).id, input.path || ''));
  handle('search', input => files.search(workspace(input).id, input.query));
  handle('read', input => files.read(workspace(input).id, input.path));
  handle('write', input => files.write(workspace(input).id, input.path, input.content, input.revision));
  handle('create', input => files.create(workspace(input).id, input.path, input.directory === true));
  handle('rename', input => files.rename(workspace(input).id, input.path, input.newPath));
  handle('remove', input => files.remove(workspace(input).id, input.path));
  handle('inspect', input => servers.inspect(workspace(input).id));
  handle('run-plan', input => runPlanner.plan(workspace(input).id, { kind: input.kind, path: input.path, script: input.script }));
  handle('format', async input => {
    const id = workspace(input).id, key = id + ':' + input.path;
    formatting.get(key)?.controller.abort();
    const task = { controller: new AbortController(), modelVersion: input.modelVersion, requestId: input.requestId };
    formatting.set(key, task);
    try { return await formatter.format(id, input.path, input.content, { modelVersion: input.modelVersion, signal: task.controller.signal, timeoutMs: 10000 }); }
    finally { if (formatting.get(key) === task) formatting.delete(key); }
  });
  handle('format-cancel', input => {
    const key = workspace(input).id + ':' + input.path, task = formatting.get(key);
    if (task && task.modelVersion === input.modelVersion && (input.requestId === undefined || task.requestId === input.requestId)) task.controller.abort();
    return { ok: true };
  });
  handle('language-request', input => languages.request(input));
  handle('language-status', input => languages.getStatus(input.workspaceId));
  handle('git-status', input => git.status(workspace(input).id));
  handle('git-diff', input => git.diff(workspace(input).id, input.path, input.ref || 'index'));
  handle('review-list', input => reviews.list(workspace(input).id));
  handle('review-read', input => reviews.read(workspace(input).id, input.reviewId));
  handle('review-action', input => reviews.action(workspace(input).id, input));
  handle('start', input => servers.start(workspace(input).id, input.script, input.confirmed, input.entryPath));
  handle('stop', input => servers.stop(workspace(input, false).id));
  handle('restart', input => servers.restart(workspace(input).id, input.script, input.confirmed, input.entryPath));
  handle('status', input => servers.status(workspace(input, false).id));
  handle('context', input => {
    const project = workspace(input); const { workspaceId, ...payload } = input;
    setIDEContext(project.root, payload); return { ok: true };
  });

  function previewState(id, record) {
    const contents = record.view.webContents;
    return { workspaceId: id, url: contents.getURL(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), visible: record.visible };
  }
  function publishPreview(id, record, extra = {}) {
    if (!record.view.webContents.isDestroyed()) {
      send({ type: 'preview', ...previewState(id, record), ...extra });
      if (extra.message) { try { appendIDEDiagnostic(files.project(id, false).root, extra); } catch { /* diagnostic context is best effort */ } }
    }
  }
  function allowedURL(record, raw) {
    try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === record.origin; } catch { return false; }
  }
  function hideRecord(id, record) {
    record.visibilityVersion++;
    record.visible = false;
    if (intendedWorkspace === id) intendedWorkspace = '';
    if (!record.view.webContents.isDestroyed()) record.view.setVisible(false);
  }
  function loadService(record, url) {
    record.origin = new URL(url).origin; record.serviceURL = url; record.needsReload = false;
    const loading = record.view.webContents.loadURL(url).catch(() => {});
    record.loading = loading;
    loading.finally(() => { if (record.loading === loading) record.loading = null; });
    return loading;
  }
  function makePreview(id, url) {
    const win = currentWindow();
    const partition = session.fromPartition(`iexa-ide-${id}`, { cache: false });
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    const record = { view: null, origin: new URL(url).origin, serviceURL: '', needsReload: false, loading: null, visible: false, visibilityVersion: 0, parent: win };
    partition.webRequest.onBeforeRequest((details, callback) => {
      try {
        const target = new URL(details.url);
        const protectedOrigin = typeof appOrigin === 'function' ? appOrigin() : appOrigin;
        const loopback = ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(target.hostname.toLowerCase());
        const transportOrigin = target.origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
        const blocked = transportOrigin === protectedOrigin || (loopback && transportOrigin !== record.origin) || ['file:', 'ftp:'].includes(target.protocol);
        callback({ cancel: blocked });
      } catch { callback({ cancel: true }); }
    });
    record.view = new WebContentsView({ webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
    const contents = record.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigation = (event, target) => {
      const raw = typeof target === 'string' ? target : target?.url;
      if (!allowedURL(record, raw)) { event.preventDefault(); publishPreview(id, record, { level: 'warning', message: '预览只允许在当前服务地址内导航。' }); }
    };
    contents.on('will-navigate', navigation); contents.on('will-redirect', navigation);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('did-navigate', () => publishPreview(id, record));
    contents.on('did-navigate-in-page', () => publishPreview(id, record));
    contents.on('did-finish-load', () => publishPreview(id, record, { loading: false }));
    contents.on('did-start-loading', () => publishPreview(id, record, { loading: true }));
    contents.on('did-fail-load', (_event, code, description, failedURL, mainFrame) => {
      if (code !== -3 && mainFrame) publishPreview(id, record, { loading: false, level: 'error', message: `${description} (${failedURL})`, error: description });
    });
    contents.on('console-message', (event, ...args) => {
      const details = event?.message !== undefined ? event : args[0] && typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1], lineNumber: args[2], sourceId: args[3] };
      const level = details.level === 3 || details.level === 'error' ? 'error' : details.level === 2 || details.level === 'warning' ? 'warning' : 'console';
      // Electron's own development CSP notice is not a project diagnostic.
      // Keep every project warning/error, including messages with this text.
      if (level === 'warning' && ['node:electron/js2c/renderer_init', 'node:electron/js2c/sandbox_bundle'].includes(details.sourceId) && /^(?:%c)?Electron Security Warning(?:\s|\()/.test(String(details.message || ''))) return;
      publishPreview(id, record, { level, message: String(details.message || '').slice(0, 8000), source: details.sourceId, line: details.lineNumber });
    });
    contents.on('render-process-gone', (_event, details) => publishPreview(id, record, { level: 'error', message: `预览进程退出：${details.reason}` }));
    win.contentView.addChildView(record.view); record.view.setBounds({ x: 0, y: 0, width: 1, height: 1 }); record.view.setVisible(false);
    win.once('closed', () => {
      if (previews.get(id) !== record) return;
      hideRecord(id, record);
      previews.delete(id);
      if (!contents.isDestroyed()) contents.close();
    });
    previews.set(id, record); return record;
  }
  handle('preview', async input => {
    const action = input.action || 'attach';
    const project = workspace(input, action !== 'hide'); const id = project.id;
    let record = previews.get(id);
    if (record?.view.webContents.isDestroyed()) { previews.delete(id); record = undefined; }
    if (action === 'hide') { if (record) hideRecord(id, record); return record ? previewState(id, record) : { workspaceId: id, visible: false }; }
    const state = servers.status(id);
    if (state.status !== 'running' || !state.url) throw new IDEError('IDE_PREVIEW', '请先启动项目预览服务。');
    if (!record) record = makePreview(id, state.url);
    const changesVisibility = ['attach', 'bounds', 'show'].includes(action) || input.visible !== undefined;
    let visibilityVersion = record.visibilityVersion;
    if (changesVisibility) {
      visibilityVersion = ++record.visibilityVersion;
      if (input.visible === false) hideRecord(id, record);
      else {
        intendedWorkspace = id;
        for (const [otherId, other] of previews) if (otherId !== id) hideRecord(otherId, other);
      }
    }
    if (record.serviceURL !== state.url || record.needsReload) await loadService(record, state.url);
    else if (record.loading) await record.loading;
    const contents = record.view.webContents;
    if (disposed || contents.isDestroyed() || record.parent.isDestroyed()) return { workspaceId: id, visible: false };
    if (action === 'navigate') {
      if (!allowedURL(record, input.url)) throw new IDEError('IDE_NAVIGATION', '只允许当前项目服务内的预览地址。');
      await contents.loadURL(input.url).catch(error => { throw new IDEError('IDE_LOAD', error.message); });
    } else if (action === 'reload') contents.reload();
    else if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (!['attach', 'bounds', 'show', 'back', 'forward'].includes(action)) throw new IDEError('IDE_ACTION', '预览操作无效。');
    if (input.bounds) {
      const bounds = input.bounds; const scale = currentWindow().webContents.getZoomFactor();
      if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw new IDEError('IDE_BOUNDS', '预览区域尺寸无效。');
      const size = currentWindow().getContentBounds();
      const x = Math.min(size.width, Math.max(0, Math.round(bounds.x * scale))); const y = Math.min(size.height, Math.max(0, Math.round(bounds.y * scale)));
      const width = Math.max(1, Math.min(size.width - x, Math.round(bounds.width * scale))); const height = Math.max(1, Math.min(size.height - y, Math.round(bounds.height * scale)));
      record.view.setBounds({ x, y, width, height });
    }
    if (changesVisibility && input.visible !== false && record.visibilityVersion === visibilityVersion && intendedWorkspace === id && servers.status(id).status === 'running') {
      record.visible = true; record.view.setVisible(true);
    }
    return previewState(id, record);
  });

  function shutdown() {
    if (shutdownTask) return shutdownTask;
    disposed = true;
    for (const task of formatting.values()) task.controller.abort();
    shutdownTask = (async () => {
      const closing = [];
      for (const [id, record] of previews) {
        hideRecord(id, record);
        try { if (!record.parent.isDestroyed()) record.parent.contentView.removeChildView(record.view); } catch {}
        const contents = record.view.webContents;
        if (!contents.isDestroyed()) closing.push(new Promise(resolve => {
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(timer); contents.removeListener('destroyed', finish); resolve(); };
          const timer = setTimeout(finish, 2000);
          contents.once('destroyed', finish);
          // Detaching and closing during an active native view resize must not
          // tear down the compositor surface in the same message-loop turn.
          setImmediate(() => {
            if (contents.isDestroyed()) { finish(); return; }
            try { contents.close({ waitForBeforeUnload: false }); } catch { finish(); }
            if (contents.isDestroyed()) finish();
          });
        }));
      }
      previews.clear();
      try { await Promise.all([servers.shutdown(), languages.dispose(), ...closing]); }
      finally { await reviews.dispose(); files.dispose(); clearIDEContext(); }
    })();
    return shutdownTask;
  }
  function dispose() {
    for (const channel of channels) ipcMain.removeHandler(channel);
    return shutdown().finally(() => { if (beforeQuitListener) app?.removeListener('before-quit', beforeQuitListener); process.removeListener('exit', onProcessExit); });
  }
  async function rendererHasUnsaved(win) {
    if (!win || win.isDestroyed()) return false;
    return Boolean(await win.webContents.executeJavaScript('Boolean(window.IexaIDE?.hasUnsavedChanges?.())'));
  }
  function requestQuit() {
    if (shutdownComplete) { app?.quit(); return Promise.resolve(true); }
    if (quitTask) return quitTask;
    quitTask = (async () => {
      const win = getWindow();
      let dirty;
      try { dirty = await rendererHasUnsaved(win); }
      catch {
        const choice = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
          type: 'warning', title: '退出 IEXA-WIN', message: '编辑器暂时没有响应。', detail: '退出可能丢失尚未保存的编辑。',
          buttons: ['退出', '取消'], defaultId: 1, cancelId: 1, noLink: true,
        });
        if (choice.response !== 0) return false;
        dirty = false;
      }
      if (dirty) {
        const choice = await dialog.showMessageBox(win, {
          type: 'warning', title: '保存 IDE 编辑', message: '工作台中有尚未保存的修改。', detail: '保存全部文件后退出，或放弃这些修改。取消会继续保留当前编辑和运行服务。',
          buttons: ['保存并退出', '放弃更改并退出', '取消'], defaultId: 0, cancelId: 2, noLink: true,
        });
        if (choice.response === 2) return false;
        if (choice.response === 0) {
          try {
            const saved = await win.webContents.executeJavaScript('window.IexaIDE.saveAll()');
            if (saved === false || await rendererHasUnsaved(win)) throw new Error('仍有未保存的文件，请检查文件冲突。');
          } catch (error) {
            console.error('[IDE] Save before exit:', error.message);
            await dialog.showMessageBox(win, { type: 'error', title: '文件尚未保存', message: '保存未完成，应用将继续运行。', detail: error.message || '请检查编辑器中的文件冲突或写入错误。', buttons: ['返回工作台'] });
            return false;
          }
        } else if (choice.response !== 1) return false;
      }
      if (win && !win.isDestroyed()) await win.webContents.executeJavaScript('window.IexaIDE?.allowClose?.()').catch(() => {});
      await shutdown(); shutdownComplete = true; app?.quit(); return true;
    })().catch(error => { console.error('[IDE] Exit cleanup:', error.message); return false; }).finally(() => { quitTask = undefined; });
    return quitTask;
  }
  if (app) {
    beforeQuitListener = event => {
      if (shutdownComplete) return;
      event.preventDefault();
      void requestQuit();
    };
    app.on('before-quit', beforeQuitListener);
    process.once('exit', onProcessExit);
  }
  return { files, servers, shutdown, dispose, requestQuit, canQuit: () => shutdownComplete };
}
module.exports = { installIDEHost };
