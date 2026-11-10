// Keep per-project drafts, while the visible IDE follows the main project.
(function (root) {
  'use strict';
  const WORDS = {
    title: ['IDE', 'IDE', 'IDE'], open: ['打开项目', 'Open project', 'プロジェクトを開く'],
    expand: ['展开工作台', 'Expand workbench', 'ワークベンチを展開'], collapse: ['收起工作台', 'Collapse workbench', 'ワークベンチを縮小'],
    explorer: ['资源管理器', 'Explorer', 'エクスプローラー'], file: ['新建文件', 'New file', '新規ファイル'], folder: ['新建文件夹', 'New folder', '新規フォルダー'],
    refresh: ['刷新', 'Refresh', '更新'], search: ['搜索文件名…', 'Search files…', 'ファイルを検索…'], recent: ['最近打开', 'Recent files', '最近開いたファイル'],
    save: ['保存', 'Save', '保存'], saveAll: ['全部保存', 'Save all', 'すべて保存'], find: ['查找 / 替换', 'Find / replace', '検索 / 置換'],
    format: ['格式化文档', 'Format document', 'ドキュメントの整形'], formatting: ['正在格式化…', 'Formatting…', '整形中…'], formatted: ['已格式化；Ctrl+Z 可撤销，保存后写入磁盘', 'Formatted; undo with Ctrl+Z, save to write to disk', '整形済み。Ctrl+Z で元に戻す、保存で書き込む'], formatUnchanged: ['格式已符合规范', 'Formatting is already consistent', '整形の変更はありません'], formatStale: ['格式化期间代码已变化，已保留当前编辑，请重试', 'Code changed during formatting. Your edits are preserved; retry.', '整形中にコードが変更されました。編集は保持されています。再試行してください。'],
    gitChanges: ['源代码管理', 'Source control', 'ソース管理'], aiChanges: ['审阅 AI 改动', 'Review AI changes', 'AI の変更を確認'], nextChange: ['下一处改动', 'Next change', '次の変更'], previousChange: ['上一处改动', 'Previous change', '前の変更'],
    ai: ['交给 AI', 'Ask AI', 'AI に相談'], terminal: ['终端', 'Terminal', 'ターミナル'], preview: ['网页预览', 'Web preview', 'Web プレビュー'],
    run: ['启动网页预览', 'Start web preview', 'Web プレビューを起動'], stop: ['停止预览', 'Stop preview', 'プレビューを停止'], restart: ['重启预览服务', 'Restart preview server', 'プレビューを再起動'],
    runFile: ['运行文件', 'Run file', 'ファイルを実行'], task: ['运行任务', 'Run task', 'タスクを実行'], runProject: ['运行项目', 'Run project', 'プロジェクトを実行'], build: ['构建', 'Build', 'ビルド'], test: ['测试', 'Test', 'テスト'],
    runActions: ['运行', 'Run', '実行'], editorActions: ['编辑器操作', 'Editor actions', 'エディター操作'], webActions: ['网页预览', 'Web preview', 'Web プレビュー'], taskActions: ['项目任务', 'Project tasks', 'プロジェクトタスク'], more: ['更多操作', 'More actions', 'その他の操作'],
    taskEmpty: ['运行文件或项目任务后，终端输出会显示在这里。', 'Run a file or project task to see terminal output here.', 'ファイルまたはタスクを実行すると出力がここに表示されます。'],
    taskRunning: ['任务运行中', 'Task running', 'タスクを実行中'], taskInterrupting: ['已发送 Ctrl+C，等待退出码', 'Ctrl+C sent; waiting for exit code', 'Ctrl+C を送信、終了コード待機中'], taskStopping: ['正在停止任务', 'Stopping task', 'タスクを停止中'], taskStopped: ['任务已停止', 'Task stopped', 'タスクを停止しました'],
    taskExit: ['结束代码 {code}', 'Exit code {code}', '終了コード {code}'], taskStop: ['停止任务', 'Stop task', 'タスクを停止'], interrupt: ['Ctrl+C', 'Ctrl+C', 'Ctrl+C'],
    back: ['后退', 'Back', '戻る'], forward: ['前进', 'Forward', '進む'], copy: ['复制地址', 'Copy URL', 'URL をコピー'],
    hidePreview: ['显示 / 隐藏预览', 'Toggle preview', 'プレビューを切り替え'], hideExplorer: ['显示 / 隐藏资源管理器', 'Toggle explorer', 'エクスプローラーを切り替え'],
    logs: ['运行日志与网页错误', 'Server logs & web errors', '実行ログと Web エラー'], clear: ['清空', 'Clear', 'クリア'],
    ready: ['就绪', 'Ready', '準備完了'], stopped: ['已停止', 'Stopped', '停止中'], starting: ['启动中', 'Starting', '起動中'], running: ['运行中', 'Running', '実行中'], error: ['错误', 'Error', 'エラー'],
    welcome: ['从项目开始', 'Start with a project', 'プロジェクトから始める'], welcomeHint: ['打开本地文件夹，浏览和编辑代码，运行文件、构建或测试项目；网页项目还可启动独立预览。', 'Open a local folder to edit code, run files, build or test projects, and start an isolated preview for web projects.', 'ローカルフォルダーでコードを編集し、ファイルの実行やビルド・テストを行えます。Web プロジェクトは独立したプレビューも利用できます。'],
    desktop: ['请在 IEXA-WIN 桌面应用中打开 IDE，以访问本地项目、终端任务和网页预览。', 'Open IDE in the IEXA-WIN desktop app for local projects, terminal tasks and web previews.', 'ローカルプロジェクト、ターミナルタスク、Web プレビューには IEXA-WIN デスクトップアプリをご利用ください。'],
    selectFile: ['从资源管理器打开一个文件', 'Open a file from the explorer', 'エクスプローラーからファイルを開く'],
    previewHint: ['打开 HTML 文件后，切到“网页预览”即可加载；编辑后保存以刷新页面。需要开发服务的项目使用“启动网页预览”。', 'Open an HTML file and switch to Web preview to load it. Save edits to refresh. For projects requiring a development server, choose Start web preview.', 'HTML ファイルを開いて「Web プレビュー」に切り替えると表示されます。保存すると更新されます。開発サーバーが必要なプロジェクトは「Web プレビューを起動」を選択してください。'],
    noFiles: ['没有匹配的文件', 'No matching files', '一致するファイルはありません'], empty: ['空文件夹', 'Empty folder', '空のフォルダー'],
    loading: ['正在加载…', 'Loading…', '読み込み中…'], saved: ['已保存', 'Saved', '保存しました'], modified: ['未保存', 'Unsaved', '未保存'],
    rename: ['重命名', 'Rename', '名前を変更'], remove: ['删除', 'Delete', '削除'], close: ['关闭', 'Close', '閉じる'],
    filename: ['输入相对项目路径', 'Enter a project-relative path', 'プロジェクト内の相対パスを入力'], newName: ['输入新的相对路径', 'Enter the new relative path', '新しい相対パスを入力'],
    removeConfirm: ['确认永久删除此项目？文件夹中的子目录及文件也会被删除。', 'Permanently delete this item? All files and subfolders inside it will also be deleted.', '完全に削除しますか？フォルダー内のすべてのファイルとサブフォルダーも削除されます。'],
    discard: ['此文件有未保存修改。关闭并丢弃这些修改？', 'This file has unsaved changes. Close and discard them?', '未保存の変更があります。変更を破棄して閉じますか？'],
    conflict: ['磁盘文件已被外部修改；你的编辑已保留。请选择重载，或保留编辑后再次保存。', 'The disk file changed externally. Your edits are preserved. Reload it or keep your edits before saving again.', 'ディスク上のファイルが変更されました。編集中の内容は保持されています。再読み込みするか、編集を保持して保存してください。'],
    reload: ['重载磁盘版本', 'Reload disk version', 'ディスクの内容を読み込む'], keep: ['保留我的编辑', 'Keep my edits', '自分の編集を保持'],
    removed: ['文件已删除或移动；编辑内容已保留。可复制代码或重新创建同名文件。', 'The file was removed or moved. Your edits are preserved. Copy the code or recreate the file.', 'ファイルが削除または移動されました。編集内容は保持されています。コードをコピーするか再作成してください。'],
    command: ['命令面板', 'Command palette', 'コマンドパレット'], commandHint: ['搜索命令…', 'Search commands…', 'コマンドを検索…'],
    editorCommands: ['编辑器全部命令', 'All editor commands', 'エディターのすべてのコマンド'],
    scriptConfirm: ['运行以下项目脚本？它会在项目目录内执行本地代码。', 'Run this project script? It will execute local code inside the project directory.', 'このプロジェクトスクリプトを実行しますか？プロジェクト内でローカルコードが実行されます。'],
    noScript: ['请先打开要预览的 HTML 文件，或添加 index.html / package.json 开发脚本后刷新。', 'Open the HTML file to preview, or add index.html / a package.json development script and refresh.', 'プレビューする HTML ファイルを開くか、index.html / package.json の開発用スクリプトを追加して更新してください。'],
    static: ['静态网页', 'Static website', '静的 Web サイト'], project: ['选择项目', 'Choose a project', 'プロジェクトを選択'],
    path: ['项目路径', 'Project path', 'プロジェクトのパス'], cursor: ['行 {line}/{total}，列 {column}', 'Ln {line}/{total}, Col {column}', '{line}/{total} 行、{column} 列'],
    cursorHint: ['光标：第 {line} 行，第 {column} 列；共 {total} 行（按当前编辑内容计算，不含自动折行）', 'Cursor: line {line}, column {column}; {total} lines in the current buffer (excluding soft wraps)', 'カーソル：{line} 行、{column} 列。編集中の全 {total} 行（折り返しを除く）'],
    resize: ['拖动调整面板宽度', 'Drag to resize panel', 'ドラッグして幅を変更'], unknownError: ['操作失败', 'Operation failed', '操作に失敗しました'],
    files: ['文件', 'Files', 'ファイル'], chooseFile: ['选择文件', 'Choose file', 'ファイルを選択'],
    code: ['代码', 'Code', 'コード'], split: ['并排', 'Split', '分割'], output: ['输出', 'Output', '出力'], problems: ['错误', 'Errors', 'エラー'],
  };
  const $ = id => document.getElementById(id);
  const api = () => root.iexaDesktop?.ide;
  const states = new Map();
  let current = null, initialized = false, active = false, expanded = false, editor = null, monacoPromise = null, monacoCancellationBound = false, projectEpoch = 0;
  let contextTimer = 0, searchTimer = 0, syncTimer = 0, layoutFrame = 0, unsubscribe = null, unsubscribeTask = null, poll = 0;
  let modalDepth = 0, resizeDetachPending = 0, endResize = null, previewAttached = '', previewLastBounds = '', paletteOpen = false, openMenu = '', destroyed = false;
  let changes = null, changesOverlay = false, pythonFormatter = null, formatRequestSequence = 0, languageService = null;
  let explorerShown = true, previewShown = true, logsShown = true, lastError = '', closeAllowed = false, restoring = false, readyPromise = Promise.resolve(), narrowExplorer = false, paneMode = 'code', logMode = 'output';
  function t(key, params = {}) {
    const locale = root.IexaI18n?.getLocale() || 'zh-CN';
    const index = locale.startsWith('en') ? 1 : locale.startsWith('ja') ? 2 : 0;
    return String(WORDS[key]?.[index] || key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  }
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ui-icon'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#ui-' + name); svg.append(use); return svg;
  }
  function button(id, label, iconName, action, text = false) {
    const el = node('button', 'ide-toolbar-button'); el.type = 'button'; el.id = id;
    el.dataset.ideLabel = label; el.title = t(label); el.setAttribute('aria-label', t(label));
    if (iconName) el.append(icon(iconName)); if (text) el.append(node('span', '', t(label)));
    if (action) el.addEventListener('click', () => { if (el.closest('.ide-menu-popup')) closeMenus(); safely(action); }); return el;
  }
  function menu(id, label, iconName, text = false) {
    const host = node('div', 'ide-menu');
    const trigger = button(id, label, iconName, () => toggleMenu(id), text); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    const popup = node('div', 'ide-menu-popup'); popup.id = id + 'Popup'; popup.hidden = true; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-modal', 'false'); popup.setAttribute('aria-label', t(label)); trigger.setAttribute('aria-controls', popup.id);
    host.append(trigger, popup);
    const items = () => [...popup.querySelectorAll(':is(button, select):not(:disabled)')];
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenus(); trigger.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (event.target.tagName === 'SELECT') return;
        event.preventDefault(); if (openMenu !== id) toggleMenu(id);
        const all = items(), index = all.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
        const next = index < 0 ? (step > 0 ? 0 : all.length - 1) : (index + step + all.length) % all.length;
        all[next]?.focus();
      }
    });
    return { host, popup };
  }
  function closeMenus() {
    if (!openMenu) return;
    $(openMenu + 'Popup').hidden = true; $(openMenu).setAttribute('aria-expanded', 'false'); openMenu = ''; scheduleLayout();
  }
  function toggleMenu(id) {
    const same = openMenu === id; closeMenus(); if (same) return;
    closeContext(); paletteOpen = false; $('idePalette')?.remove(); openMenu = id;
    $(id + 'Popup').hidden = false; $(id).setAttribute('aria-expanded', 'true'); safely(hideNative); scheduleLayout();
  }
  function message(text, error = false) {
    lastError = error ? String(text) : '';
    const el = $('ideStatus'); if (!el) return;
    el.textContent = text; el.title = text; el.classList.toggle('is-error', error);
  }
  async function safely(fn) {
    try { return await fn(); } catch (error) { message(error?.message || String(error), true); return undefined; }
  }
  async function call(method, data) {
    const bridge = api(); if (!bridge?.[method]) throw new Error(t('desktop'));
    const result = await bridge[method](data);
    if (result?.__ideError) { const error = new Error(result.__ideError.message); error.code = result.__ideError.code; error.diagnostics = result.__ideError.diagnostics || []; throw error; }
    if (result?.ok === false) { const error = new Error(result.error?.message || result.error || t('unknownError')); error.code = result.code || result.error?.code; throw error; }
    return result;
  }
  async function dialog(kind, text, initial) {
    modalDepth++;
    try { await hideNative(); return await root.IexaDialogs[kind](text, initial); }
    finally { modalDepth--; scheduleLayout(); }
  }
  function stateFor(project) {
    if (!states.has(project.id)) {
      const state = { ...project, files: new Map(), expanded: new Set(['']), tree: new Map(), selected: '', activePath: '', recent: [], server: { status: 'stopped', logs: [] }, webErrors: [], inspection: null, inspecting: false, searchEpoch: 0, openEpoch: 0, searchResults: null, attachedURL: '', checking: false };
      states.set(project.id, state);
    }
    return states.get(project.id);
  }
  function persist() {
    if (restoring || destroyed) return;
    try { localStorage.setItem('iexa-ide-layout', JSON.stringify({ expanded, explorerShown, previewShown, logsShown, paneMode, logMode, chatWidth: document.querySelector('#view-chat .chat-layout')?.style.getPropertyValue('--ide-chat-width'), projectId: current?.id, explorerWidth: $('idePanel')?.style.getPropertyValue('--ide-explorer-width'), previewWidth: $('idePanel')?.style.getPropertyValue('--ide-preview-width'), previewHeight: $('idePanel')?.style.getPropertyValue('--ide-preview-height'), logHeight: $('idePanel')?.style.getPropertyValue('--ide-log-height'), open: [...states.values()].map(s => ({ id: s.id, paths: [...s.files.keys()], activePath: s.activePath })) })); } catch {}
  }
  function build() {
    const panel = $('idePanel'); if (!panel) return;
    const top = node('header', 'ide-topbar');
    const brand = node('div', 'ide-brand'); brand.append(icon('code')); brand.title = t('title'); top.append(brand);
    const select = node('select', 'ide-project-select'); select.id = 'ideProjectSelect'; select.setAttribute('aria-label', t('project'));
    select.addEventListener('change', () => safely(async () => {
      const project = states.get(select.value);
      if (api()?.currentProject && typeof root.openProjectPath === 'function' && project) { await root.openProjectPath(project.root); await root.syncIDEProject?.(); renderProjects(); }
      else if (!api()?.currentProject) await openProject(project);
      else renderProjects();
    })); top.append(select);
    top.append(button('ideOpenFolder', 'open', 'folder', chooseFolder));
    const runMenu = menu('ideRunMenu', 'runActions', 'chevron-down', true);
    const runControls = node('div', 'ide-run-controls');
    const runSelect = node('select', 'ide-run-select'); runSelect.id = 'ideScript'; runSelect.setAttribute('aria-label', t('run'));
    const run = node('span', 'ide-run-status', t('stopped')); run.id = 'ideServerStatus'; run.dataset.state = 'stopped';
    runControls.append(node('strong', 'ide-menu-label', t('webActions')), runSelect, button('ideRun', 'run', 'monitor', () => runServer(false), true), button('ideStop', 'stop', 'pause', stopServer, true), button('ideRestart', 'restart', 'refresh', () => runServer(true), true), run); runMenu.popup.append(runControls);
    const taskControls = node('div', 'ide-task-controls');
    const tasks = node('select', 'ide-task-select'); tasks.id = 'ideTasks'; tasks.setAttribute('aria-label', t('task'));
    for (const [value, label] of [['project', 'runProject'], ['build', 'build'], ['test', 'test']]) { const option = node('option', '', t(label)); option.value = value; option.dataset.ideTaskLabel = label; tasks.append(option); }
    taskControls.append(node('strong', 'ide-menu-label', t('taskActions')), tasks, button('ideRunTask', 'task', 'play', () => runTask(tasks.value), true));
    runMenu.popup.prepend(taskControls);
    top.append(button('ideRunFile', 'runFile', 'play', () => runTask('file'), true), runMenu.host);
    const moreMenu = menu('ideMoreMenu', 'more', 'more');
    const topActions = node('div', 'ide-top-actions');
    moreMenu.popup.append(node('strong', 'ide-menu-label', t('editorActions')), button('ideSave', 'save', 'check', save, true), button('ideFormat', 'format', 'code', formatDocument, true), button('ideFind', 'find', 'search', () => editor?.getAction('editor.action.startFindReplaceAction')?.run(), true), button('ideExplorerToggle', 'hideExplorer', 'panel-left', () => { if (isSinglePane()) narrowExplorer = !narrowExplorer; else explorerShown = !explorerShown; applyLayout(); }, true), button('ideTerminal', 'terminal', 'terminal', openTerminal, true), button('ideCommands', 'command', 'search', () => togglePalette(), true), button('ideEditorCommands', 'editorCommands', 'code', editorCommands, true));
    topActions.append(button('ideAI', 'ai', 'ide-spark', openAI), button('ideExpand', 'expand', 'external', toggleExpand), moreMenu.host); top.append(topActions);
    const layout = node('div', 'ide-layout'); layout.id = 'ideLayout';
    const explorer = node('aside', 'ide-explorer'); explorer.id = 'ideExplorer';
    const explorerHead = node('div', 'ide-section-head'); explorerHead.append(node('strong', '', t('explorer')), button('ideNewFile', 'file', 'plus', () => createEntry(false)), button('ideNewFolder', 'folder', 'folder-plus', () => createEntry(true)), button('ideRefresh', 'refresh', 'refresh', refresh));
    const search = node('input', 'ide-search'); search.id = 'ideFileSearch'; search.type = 'search'; search.placeholder = t('search'); search.setAttribute('aria-label', t('search'));
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => safely(searchFiles), 200); });
    const tree = node('div', 'ide-tree'); tree.id = 'ideTree'; tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', t('explorer'));
    const recent = node('div', 'ide-recent'); recent.id = 'ideRecent'; explorer.append(explorerHead, search, tree, recent);
    const main = node('section', 'ide-main'); main.id = 'ideMain';
    const viewBar = node('div', 'ide-view-bar'); viewBar.id = 'ideViewBar';
    const viewSwitch = node('div', 'ide-view-switch'); viewSwitch.setAttribute('role', 'tablist'); viewSwitch.setAttribute('aria-label', t('title'));
    viewSwitch.append(button('ideViewFiles', 'files', 'folder', showFiles, true), button('ideViewCode', 'code', 'code', () => setPane('code'), true), button('ideViewPreview', 'preview', 'monitor', () => setPane('preview'), true), button('ideViewSplit', 'split', 'panel-right', () => setPane('split'), true));
    moreMenu.popup.append(button('ideGitChanges', 'gitChanges', 'branch', showGitChanges, true), button('ideAIChanges', 'aiChanges', 'ide-spark', reviewAIChanges, true), button('ideNextChange', 'nextChange', 'arrow-right', () => changes?.navigate(1), true), button('idePreviousChange', 'previousChange', 'arrow-left', () => changes?.navigate(-1), true));
    viewSwitch.querySelectorAll('button').forEach(tab => tab.setAttribute('role', 'tab'));
    const pathLabel = node('span', 'ide-editor-path'); pathLabel.id = 'ideEditorPath';
    viewBar.append(pathLabel, viewSwitch, button('idePreviewToggle', 'hidePreview', 'monitor', () => { if (isSinglePane()) setPane(paneMode === 'preview' ? 'code' : 'preview'); else setPane(previewShown ? 'code' : 'split'); }));
    const canvas = node('div', 'ide-canvas'); canvas.id = 'ideCanvas';
    const center = node('section', 'ide-editor-column'); center.id = 'ideEditorColumn';
    const tabs = node('div', 'ide-editor-tabs'); tabs.id = 'ideEditorTabs'; tabs.setAttribute('role', 'tablist');
    const conflict = node('div', 'ide-conflict'); conflict.id = 'ideConflict'; conflict.hidden = true; conflict.setAttribute('role', 'status');
    const conflictText = node('span'); conflictText.id = 'ideConflictText';
    conflict.append(conflictText, button('ideReloadDisk', 'reload', null, reloadDisk, true), button('ideKeepEdits', 'keep', null, keepEdits, true));
    const host = node('div', 'ide-editor'); host.id = 'ideEditor';
    const welcome = node('div', 'ide-editor-welcome'); welcome.id = 'ideEditorWelcome';
    const welcomeTitle = node('strong'); welcomeTitle.id = 'ideWelcomeTitle'; const welcomeHint = node('p'); welcomeHint.id = 'ideWelcomeHint';
    welcome.append(icon('code'), welcomeTitle, welcomeHint, button('ideWelcomeOpen', 'open', 'folder', chooseFolder, true), button('ideWelcomeSelect', 'chooseFile', 'folder', showFiles, true)); host.append(welcome);
    center.append(tabs, conflict, host);
    const preview = node('section', 'ide-preview-column'); preview.id = 'idePreviewColumn';
    const browserTools = node('div', 'ide-preview-toolbar');
    browserTools.append(button('idePreviewBack', 'back', 'arrow-left', () => previewAction('back')), button('idePreviewForward', 'forward', 'arrow-right', () => previewAction('forward')), button('idePreviewRefresh', 'refresh', 'refresh', () => previewAction('reload')));
    const address = node('form', 'ide-preview-address'); const url = node('input'); url.id = 'idePreviewURL'; url.type = 'url'; url.placeholder = 'http://127.0.0.1:…'; url.setAttribute('aria-label', t('preview'));
    address.append(url); address.addEventListener('submit', event => { event.preventDefault(); safely(() => previewAction('navigate', { url: url.value })); }); browserTools.append(address, button('idePreviewCopy', 'copy', 'copy', () => navigator.clipboard.writeText($('idePreviewURL').value)));
    const viewport = node('div', 'ide-preview-viewport'); viewport.id = 'idePreviewViewport';
    const placeholder = node('div', 'ide-preview-placeholder', t('previewHint')); placeholder.id = 'idePreviewPlaceholder'; viewport.append(placeholder);
    const bottom = node('section', 'ide-bottom-panel'); bottom.id = 'ideBottomPanel';
    const logHead = node('div', 'ide-log-head');
    const logTabs = node('div', 'ide-log-tabs'); logTabs.setAttribute('role', 'tablist');
    const selectLog = mode => { logsShown = logMode === mode ? !logsShown : true; logMode = mode; renderLogs(); renderTask(); applyLayout(); };
    logTabs.append(button('ideLogTab', 'output', null, () => selectLog('output'), true), button('ideErrorsTab', 'problems', null, () => selectLog('errors'), true), button('ideTerminalTab', 'terminal', null, () => selectLog('terminal'), true));
    logHead.append(logTabs, button('ideLogsClear', 'clear', 'trash', () => { if (current) { current.server.logs = []; current.webErrors = []; renderLogs(); } }), button('ideLogsToggle', 'close', 'chevron-down', () => { logsShown = !logsShown; applyLayout(); }));
    const logs = node('div', 'ide-logs'); logs.id = 'ideLogs'; logs.setAttribute('role', 'log'); logs.setAttribute('aria-live', 'polite');
    const terminal = node('div', 'ide-task-terminal'); terminal.id = 'ideTaskTerminal'; terminal.hidden = true;
    const terminalHead = node('div', 'ide-task-head'); const taskStatus = node('span'); taskStatus.id = 'ideTaskStatus'; taskStatus.setAttribute('role', 'status');
    terminalHead.append(taskStatus, button('ideTaskInterrupt', 'interrupt', null, interruptTask, true), button('ideTaskStop', 'taskStop', 'pause', stopTask, true));
    const taskCommand = node('div', 'ide-task-command'); taskCommand.id = 'ideTaskCommand';
    const taskOutput = node('pre', 'ide-logs ide-task-output'); taskOutput.id = 'ideTaskOutput'; taskOutput.setAttribute('role', 'log'); taskOutput.setAttribute('aria-live', 'polite');
    terminal.append(terminalHead, taskCommand, taskOutput);
    preview.append(browserTools, viewport); bottom.append(logHead, logs, terminal);
    canvas.append(center, resizer('idePreviewResizer', 'preview'), preview);
    main.append(canvas, verticalResizer(), bottom);
    layout.append(explorer, resizer('ideExplorerResizer', 'explorer'), main);
    const status = node('footer', 'ide-statusbar'); const state = node('span', 'ide-status-message', t('ready')); state.id = 'ideStatus';
    const position = node('span'); position.id = 'ideCursor';
    const encoding = node('span'); encoding.id = 'ideEncoding';
    const language = node('span', 'ide-language-status'); language.id = 'ideLanguageStatus'; language.setAttribute('role', 'status'); language.hidden = true;
    status.append(state, language, button('ideGitStatus', 'gitChanges', 'branch', showGitChanges, true), button('ideReviewStatus', 'aiChanges', 'ide-spark', reviewAIChanges, true), position, encoding);
    // The navigation must remain visible when the narrow file page hides main.
    panel.append(top, viewBar, layout, status); renderProjects(); renderTree(); renderWelcome(); renderTask();
    setupChanges();
  }
  function setupChanges() {
    if (changes || !root.IexaIDEChanges) return;
    changes = root.IexaIDEChanges.create({
      project: () => current, files: () => current?.files, editor: () => editor, monaco: () => root.monaco, bridge: api,
      fileFor: (workspaceId, path) => states.get(workspaceId)?.files.get(path),
      openFile, hideNative, scheduleLayout, message,
      overlayChanged: value => { changesOverlay = value; if (value) safely(hideNative); scheduleLayout(); },
      syncFile: async (path, workspaceId) => { const state = states.get(workspaceId), file = state?.files.get(path); if (file) await checkFile(state, file); if (state === current) { renderTabs(); renderConflict(); } },
      applyReviewDecision: (record, request) => call('reviewAction', { workspaceId: record.workspaceId, reviewId: record.id, ...request }),
      onReviewChange: async record => { const state = states.get(record.workspaceId); if (state) { await loadReviews(state); await changes.refresh(); } },
      onRender: value => {
        const git = $('ideGitStatus'), review = $('ideReviewStatus');
        if (git) { const count = value.git?.files.length || 0; git.querySelector('span').textContent = (value.git?.branch || 'Git') + (count ? ` · ${count}` : ''); git.title = value.error || t('gitChanges'); }
        if (review) { const count = value.reviews.reduce((total, record) => total + record.hunks.filter(hunk => hunk.decision === 'pending').length, 0); review.hidden = !count; review.querySelector('span').textContent = `AI · ${count}`; }
      },
    });
  }
  async function loadReviews(state = current) {
    if (!state || !changes || !api()?.reviewList) return;
    const epoch = state.reviewEpoch = (state.reviewEpoch || 0) + 1;
    const list = await call('reviewList', { workspaceId: state.id });
    const records = await Promise.all((list.records || []).map(record => call('reviewRead', { workspaceId: state.id, reviewId: record.id }).catch(error => { if (error.code === 'IDE_REVIEW_MISSING') return null; throw error; })));
    if (epoch === state.reviewEpoch && !destroyed) changes.setReviewRecords(records.filter(Boolean), state.id);
  }
  async function reviewAIChanges() {
    await ensureEditor();
    await loadReviews();
    const snapshot = changes?.snapshot(), selected = snapshot?.reviews.find(record => record.path === current?.activePath && record.hunks.some(hunk => hunk.decision === 'pending')) || snapshot?.reviews.find(record => record.hunks.some(hunk => hunk.decision === 'pending'));
    if (selected) await changes.showDiff(selected.path, 'ai'); else await changes?.showChanges();
  }
  async function showGitChanges() { if (!current) return; await ensureEditor(); await changes?.showChanges(); }
  function beginResize(event, move, cursor = 'col-resize') {
    endResize?.();
    if (destroyed) return;
    const shield = node('div', 'ide-drag-shield'); shield.style.cursor = cursor;
    let ended = false;
    const ownsPointer = next => event.pointerId == null || next.pointerId == null || next.pointerId === event.pointerId;
    const onMove = next => { if (ownsPointer(next)) move(next); };
    const end = next => {
      if (ended || (next?.type?.startsWith('pointer') && !ownsPointer(next))) return;
      ended = true; shield.remove(); modalDepth--;
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', end, true); document.removeEventListener('pointercancel', end, true);
      window.removeEventListener('blur', end); window.removeEventListener('pagehide', end, true);
      if (endResize === end) endResize = null;
      persist(); if (!destroyed) scheduleLayout();
    };
    modalDepth++; resizeDetachPending++; endResize = end;
    // The pointer can be released while the native surface is still hiding.
    // Register cleanup synchronously, including teardown and window defocus.
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', end, true); document.addEventListener('pointercancel', end, true);
    window.addEventListener('blur', end); window.addEventListener('pagehide', end, true);
    document.body.append(shield);
    safely(async () => {
      try { await hideNative(); }
      catch (error) { end(); throw error; }
      finally { resizeDetachPending--; if (!destroyed) scheduleLayout(); }
    });
  }
  function resizer(id, side) {
    const el = node('div', 'ide-resizer'); el.id = id; el.tabIndex = 0; el.setAttribute('role', 'separator'); el.setAttribute('aria-orientation', 'vertical'); el.setAttribute('aria-label', t('resize'));
    const vertical = () => false;
    const resize = value => { const total = vertical() ? $('ideLayout').clientHeight : $('ideLayout').clientWidth; const max = Math.max(130, total * (side === 'explorer' ? .35 : .65)); $('idePanel').style.setProperty(vertical() ? '--ide-preview-height' : side === 'explorer' ? '--ide-explorer-width' : '--ide-preview-width', `${Math.round(Math.min(max, Math.max(side === 'explorer' ? 128 : 200, value)))}px`); editor?.layout(); scheduleLayout(); };
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0) return; event.preventDefault();
      const isVertical = vertical(), start = isVertical ? event.clientY : event.clientX, rect = $(side === 'explorer' ? 'ideExplorer' : 'idePreviewColumn').getBoundingClientRect(), width = isVertical ? rect.height : rect.width;
      beginResize(event, e => resize(width + ((isVertical ? e.clientY : e.clientX) - start) * (side === 'explorer' ? 1 : -1)), isVertical ? 'row-resize' : 'col-resize');
    });
    el.addEventListener('keydown', event => { const isVertical = vertical(); if (!(isVertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']).includes(event.key)) return; event.preventDefault(); const panel = $(side === 'explorer' ? 'ideExplorer' : 'idePreviewColumn'); resize((isVertical ? panel.clientHeight : panel.clientWidth) + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 16 : -16) * (side === 'explorer' ? 1 : -1)); persist(); }); return el;
  }
  function verticalResizer() {
    const el = node('div', 'ide-resizer ide-row-resizer'); el.id = 'ideLogsResizer'; el.tabIndex = 0; el.setAttribute('role', 'separator'); el.setAttribute('aria-orientation', 'horizontal'); el.setAttribute('aria-label', t('resize'));
    const resize = value => { const max = Math.max(50, $('ideMain').clientHeight - 180); $('idePanel').style.setProperty('--ide-log-height', `${Math.round(Math.min(max, Math.max(40, value)))}px`); scheduleLayout(); };
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0) return; event.preventDefault();
      const start = event.clientY, size = $(logMode === 'terminal' ? 'ideTaskOutput' : 'ideLogs').getBoundingClientRect().height; logsShown = true; renderLogs();
      beginResize(event, e => resize(size + start - e.clientY), 'row-resize');
    });
    el.addEventListener('keydown', event => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); resize($(logMode === 'terminal' ? 'ideTaskOutput' : 'ideLogs').clientHeight + (event.key === 'ArrowUp' ? 16 : -16)); persist(); }); return el;
  }
  function bindChatResizer() {
    const handle = $('filesResizer'), layout = document.querySelector('#view-chat .chat-layout'); if (!handle || !layout) return;
    const resize = width => { const max = Math.max(280, Math.min(620, layout.clientWidth - 400)); layout.style.setProperty('--ide-chat-width', `${Math.round(Math.max(280, Math.min(max, width)))}px`); editor?.layout(); scheduleLayout(); };
    handle.addEventListener('pointerdown', event => {
      if (!active || !expanded || event.button !== 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const start = event.clientX, width = layout.querySelector('.chat-container').getBoundingClientRect().width;
      beginResize(event, e => resize(width + e.clientX - start));
    }, true);
    handle.addEventListener('keydown', event => { if (!active || !expanded || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); event.stopImmediatePropagation(); resize(layout.querySelector('.chat-container').clientWidth + (event.key === 'ArrowRight' ? 16 : -16)); persist(); }, true);
  }
  function renderProjects() {
    const select = $('ideProjectSelect'); if (!select) return; select.replaceChildren();
    if (!current) { const option = node('option', '', t('project')); option.value = ''; select.append(option); }
    states.forEach(state => { const option = node('option', '', state.name); option.value = state.id; option.title = state.root; select.append(option); });
    select.value = current?.id || ''; select.title = current?.root || t('path');
  }
  async function chooseFolder() {
    if (api()?.currentProject) { if (typeof root.openProjectPicker === 'function') { await root.openProjectPicker(); await root.syncIDEProject?.(); } return; }
    const project = await call('chooseFolder'); if (project?.id) await openProject(project);
  }
  function ownsEditorModel(file) { return !!(editor && file?.model && editor.getModel() === file.model); }
  function renderWelcome() {
    if (!$('ideEditorWelcome')) return;
    $('ideWelcomeTitle').textContent = t(current ? 'chooseFile' : 'welcome');
    $('ideWelcomeHint').textContent = api() ? t(current ? 'selectFile' : 'welcomeHint') : t('desktop');
    $('ideWelcomeOpen').hidden = !!current; $('ideWelcomeSelect').hidden = !current;
  }
  async function openProject(project) {
    if (!project?.id) return; init();
    const epoch = ++projectEpoch;
    languageService?.switchProject(project);
    if (current) { const file = current.files.get(current.activePath); if (ownsEditorModel(file)) file.view = editor.saveViewState(); await hideNative(); }
    if (epoch !== projectEpoch) return;
    current = stateFor(project); renderLanguageStatus(); narrowExplorer = !current.activePath; $('ideFileSearch').value = ''; current.searchResults = null;
    changes?.closeDiff(false);
    editor?.setModel(null); if ($('ideMonaco')) $('ideMonaco').hidden = true; $('ideEditorWelcome').hidden = false;
    renderProjects(); renderTree(); renderTabs(); renderServer(); renderLogs(); renderWelcome(); renderTask(); applyLayout();
    const state = current; await loadDirectory(state, '', false); if (state !== current || epoch !== projectEpoch) return; renderTree(); await inspectProject(state); await checkFiles(state); if (state !== current || epoch !== projectEpoch) return;
    await loadReviews(state); await changes?.refresh();
    if (current.activePath && current.files.has(current.activePath)) await showFile(current, current.files.get(current.activePath));
    else { editor?.setModel(null); if ($('ideMonaco')) $('ideMonaco').hidden = true; $('ideEditorWelcome').hidden = false; $('ideEditorPath').textContent = current.root; applyLayout(); }
    message(t('ready')); persist(); syncContext(); scheduleLayout();
  }
  async function bindProject(project) {
    if (project?.id) { if (current?.id === project.id) return; return openProject(project); }
    init(); const epoch = ++projectEpoch;
    const file = current?.files.get(current.activePath); if (ownsEditorModel(file)) file.view = editor.saveViewState();
    // Stop the old LS immediately, preserving its Monaco models and drafts.
    languageService?.switchProject(null); current = null; root.IexaIDEAgent?.contextChanged?.(null); changes?.closeDiff(false); editor?.setModel(null);
    await hideNative(); if (epoch !== projectEpoch) return;
    if ($('ideMonaco')) $('ideMonaco').hidden = true; $('ideEditorWelcome').hidden = false; $('ideEditorPath').textContent = ''; $('ideConflict').hidden = true;
    renderProjects(); renderTree(); renderTabs(); renderServer(); renderLogs(); renderWelcome(); renderTask(); renderLanguageStatus(); applyLayout(); persist();
  }
  async function loadDirectory(state, path, render = true) {
    const result = await call('list', { workspaceId: state.id, path }); state.tree.set(path, result.entries || []);
    if (state === current && render) renderTree();
    return result.entries || [];
  }
  function renderTree() {
    const tree = $('ideTree'); if (!tree) return; tree.replaceChildren();
    if (!current) { tree.append(node('div', 'ide-empty', api() ? t('welcomeHint') : t('desktop'))); return; }
    const state = current;
    const append = (entry, depth) => {
      const row = node('button', 'ide-tree-row'); row.type = 'button'; row.dataset.path = entry.path; row.dataset.directory = String(entry.directory); row.title = entry.path; row.style.paddingLeft = `${8 + depth * 14}px`; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', String(state.selected === entry.path));
      const twist = node('span', 'ide-tree-twist');
      if (entry.directory) { twist.textContent = state.expanded.has(entry.path) ? '⌄' : '›'; row.setAttribute('aria-expanded', String(state.expanded.has(entry.path))); }
      row.append(twist);
      if (entry.directory) row.append(icon('folder')); else { const ext = entry.name.split('.').pop().toLowerCase(); const type = node('span', 'ide-tree-type', ({ js: 'JS', ts: 'TS', jsx: 'JSX', tsx: 'TSX', html: '◇', css: '#', json: '{}', md: 'M↓', py: 'PY' })[ext] || '·'); type.dataset.type = ext; row.append(type); }
      row.append(node('span', 'ide-tree-name', entry.name));
      row.addEventListener('click', () => safely(async () => { state.selected = entry.path; if (entry.directory) { if (state.expanded.has(entry.path)) state.expanded.delete(entry.path); else { state.expanded.add(entry.path); await loadDirectory(state, entry.path, false); } renderTree(); } else await openFile(entry.path); }));
      row.addEventListener('contextmenu', event => { event.preventDefault(); state.selected = entry.path; renderTree(); showContext(entry, event.clientX, event.clientY); });
      row.addEventListener('keydown', event => { if (event.key === 'F2') { event.preventDefault(); safely(() => renameEntry(entry)); } if (event.key === 'Delete') { event.preventDefault(); safely(() => removeEntry(entry)); } });
      tree.append(row);
      if (entry.directory && state.expanded.has(entry.path) && !state.searchResults) (state.tree.get(entry.path) || []).forEach(child => append(child, depth + 1));
    };
    const entries = state.searchResults || state.tree.get('') || [];
    entries.forEach(entry => append(entry, 0));
    if (!entries.length) tree.append(node('div', 'ide-empty', state.searchResults ? t('noFiles') : t('empty')));
    renderRecent();
    changes?.decorate();
  }
  function renderRecent() {
    const host = $('ideRecent'); if (!host) return; host.replaceChildren(node('span', 'ide-recent-title', t('recent')));
    (current?.recent || []).slice(0, 6).forEach(path => { const item = node('button', '', path); item.type = 'button'; item.title = path; item.addEventListener('click', () => safely(() => openFile(path))); host.append(item); });
  }
  async function searchFiles() {
    if (!current) return; const state = current, query = $('ideFileSearch').value.trim(), epoch = ++state.searchEpoch;
    if (!query) { state.searchResults = null; renderTree(); return; }
    const result = await call('search', { workspaceId: state.id, query });
    if (state !== current || epoch !== state.searchEpoch) return;
    state.searchResults = result.entries || []; renderTree();
  }
  function selectedEntry() { return [...(current?.tree.values() || [])].flat().find(entry => entry.path === current.selected); }
  function parentPath(path) { return String(path || '').split('/').slice(0, -1).join('/'); }
  async function createEntry(directory) {
    if (!current) return; const state = current, entry = selectedEntry(); const parent = entry?.directory ? entry.path : parentPath(state.selected);
    const path = await dialog('prompt', t('filename'), parent ? parent + '/' : ''); if (!path?.trim()) return;
    await call('create', { workspaceId: state.id, path: path.trim(), directory });
    state.expanded.add(parentPath(path)); await refresh(state); if (!directory && state === current) await openFile(path.trim());
  }
  async function renameEntry(entry) {
    if (!current || !entry) return; const state = current;
    const newPath = await dialog('prompt', t('newName'), entry.path); if (!newPath || newPath === entry.path) return;
    const affected = [...state.files.values()].filter(file => file.path === entry.path || file.path.startsWith(entry.path + '/'));
    for (const file of affected) if (file.dirty) { await saveFile(state, file); if (file.dirty || file.conflict) throw new Error(t('conflict')); }
    await call('rename', { workspaceId: state.id, path: entry.path, newPath });
    for (const file of affected) {
      const oldPath = file.path, renamed = newPath + oldPath.slice(entry.path.length);
      const result = await call('read', { workspaceId: state.id, path: renamed }); const replacement = makeFile(state, result);
      const wasActive = state.activePath === oldPath;
      // Editing can continue while rename/read IPC is pending. Carry the latest
      // buffer into the new URI rather than replacing it with an older disk read.
      if (file.dirty) replacement.model.setValue(file.model.getValue());
      replacement.view = file.view;
      if (ownsEditorModel(file)) { replacement.view = editor.saveViewState(); editor.setModel(null); }
      state.files.delete(oldPath); state.files.set(renamed, replacement); if (wasActive) state.activePath = renamed; languageService?.detach(file.model); file.model?.dispose();
    }
    state.recent = state.recent.map(path => path === entry.path || path.startsWith(entry.path + '/') ? newPath + path.slice(entry.path.length) : path);
    state.tree.clear(); state.expanded = new Set(['']); await refresh(state); if (state === current && state.activePath && state.files.has(state.activePath)) await showFile(state, state.files.get(state.activePath)); renderTabs();
  }
  async function removeEntry(entry) {
    if (!current || !entry) return; const state = current;
    if (!(await dialog('confirm', `${entry.path}\n\n${t('removeConfirm')}`))) return;
    const affected = [...state.files.values()].filter(file => file.path === entry.path || file.path.startsWith(entry.path + '/'));
    if (affected.some(file => file.dirty) && !(await dialog('confirm', t('discard')))) return;
    const confirmed = new Map(affected.map(file => [file, file.model?.getValue()]));
    await call('remove', { workspaceId: state.id, path: entry.path });
    for (const file of affected) {
      if (file.model?.getValue() !== confirmed.get(file)) { file.missing = true; continue; }
      if (ownsEditorModel(file)) editor.setModel(null);
      languageService?.detach(file.model); file.model?.dispose(); state.files.delete(file.path);
    }
    if (!state.files.has(state.activePath)) state.activePath = state.files.keys().next().value || '';
    await refresh(state); if (state === current) { if (state.activePath) await showFile(state, state.files.get(state.activePath)); else { editor?.setModel(null); if ($('ideMonaco')) $('ideMonaco').hidden = true; $('ideEditorWelcome').hidden = false; } } renderTabs();
  }
  function showContext(entry, x, y) {
    closeContext(); hideNative(); const menu = node('div', 'ide-context-menu'); menu.id = 'ideContextMenu'; menu.setAttribute('role', 'menu');
    const actions = [['file', () => createEntry(false)], ['folder', () => createEntry(true)], ['rename', () => renameEntry(entry)], ['remove', () => removeEntry(entry)]];
    actions.forEach(([key, fn]) => { const item = button('', key, null, async () => { closeContext(); await fn(); }, true); item.removeAttribute('id'); item.setAttribute('role', 'menuitem'); menu.append(item); });
    $('idePanel').append(menu); menu.style.left = `${Math.min(x, innerWidth - 170)}px`; menu.style.top = `${Math.min(y, innerHeight - 170)}px`; menu.querySelector('button')?.focus();
  }
  function closeContext() { $('ideContextMenu')?.remove(); scheduleLayout(); }
  function bindMonacoCancellation() {
    if (monacoCancellationBound) return;
    monacoCancellationBound = true;
    const source = new URL('vendor/monaco/vs/', document.baseURI).href;
    root.addEventListener('unhandledrejection', event => {
      const error = event.reason;
      // Monaco cancels internal language/worker promises when a model changes
      // or is disposed. Those promises are not returned by setModel/dispose.
      // Match its CancellationError and our own local Monaco source exactly;
      // unrelated cancellations and all other failures keep normal reporting.
      if (error instanceof Error && error.name === 'Canceled' && error.message === 'Canceled' && typeof error.stack === 'string' && error.stack.includes(source)) event.preventDefault();
    });
  }
  function loadMonaco() {
    bindMonacoCancellation();
    if (root.monaco?.editor) return Promise.resolve(root.monaco);
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
      const vs = new URL('vendor/monaco/vs', document.baseURI).href;
      root.MonacoEnvironment = { getWorkerUrl: () => vs + '/base/worker/workerMain.js' };
      const start = () => { root.require.config({ paths: { vs } }); root.require(['vs/editor/editor.main'], () => resolve(root.monaco), reject); };
      if (root.require?.config) { start(); return; }
      const script = document.createElement('script'); script.src = vs + '/loader.js'; script.onload = start; script.onerror = () => reject(new Error('Monaco Editor: local resources failed to load')); document.head.append(script);
    }).catch(error => { monacoPromise = null; throw error; });
    return monacoPromise;
  }
  async function ensureEditor() {
    if (editor) return; await loadMonaco(); if (editor || destroyed) return;
    const host = node('div'); host.id = 'ideMonaco'; host.hidden = true; host.style.cssText = 'position:absolute;inset:0;'; $('ideEditor').append(host);
    editor = root.monaco.editor.create(host, { model: null, theme: themeName(), automaticLayout: true, fontSize: 13, fontFamily: 'Consolas, "Cascadia Code", monospace', lineNumbers: 'on', folding: true, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 10 }, tabSize: 2, insertSpaces: true, wordWrap: 'off', quickSuggestions: true, fixedOverflowWidgets: true });
    if (!pythonFormatter && root.monaco.languages?.registerDocumentFormattingEditProvider) pythonFormatter = root.monaco.languages.registerDocumentFormattingEditProvider('python', { provideDocumentFormattingEdits: pythonFormatEdits });
    if (!languageService && root.IexaIDELanguageService) {
      languageService = root.IexaIDELanguageService.create({ monaco: root.monaco, bridge: api, enabled: active,
        onStatus: renderLanguageStatus, onDiagnostics: () => { renderLanguageStatus(); syncContext(); },
        openFile: async (path, selection) => { await openFile(path); if (selection?.startLineNumber) { editor?.setSelection?.(selection); editor?.revealRangeInCenter?.(selection); } else if (selection?.lineNumber) { editor?.setPosition?.(selection); editor?.revealLineInCenter?.(selection.lineNumber); } },
      });
      languageService.switchProject(current);
      states.forEach(state => state.files.forEach(file => { if (file.model) languageService.attach(file.model, { workspaceId: state.id, path: file.path }); }));
    }
    editor.addCommand(root.monaco.KeyMod.CtrlCmd | root.monaco.KeyCode.KeyS, () => safely(save));
    editor.onDidChangeCursorPosition(() => { renderCursor(); syncContext(); });
    editor.onDidChangeCursorSelection(syncContext);
    changes?.decorate();
    changes?.queueDecorations();
  }
  async function pythonFormatEdits(model, _options, token) {
    const state = [...states.values()].find(state => [...state.files.values()].some(file => file.model === model));
    const file = state && [...state.files.values()].find(file => file.model === model);
    if (!file || model.isDisposed?.()) return [];
    const version = model.getVersionId(), content = model.getValue(), requestId = ++formatRequestSequence, input = { workspaceId: state.id, path: file.path, modelVersion: version, requestId };
    let cancelled = !!token?.isCancellationRequested;
    const cancel = () => { cancelled = true; if (api()?.formatCancel) void call('formatCancel', input).catch(() => {}); };
    const subscription = token?.onCancellationRequested?.(cancel);
    file.formattingVersion = version; file.formatRequestId = requestId; file.formatError = null; message(t('formatting'));
    try {
      if (cancelled) return [];
      const result = await call('format', { ...input, content });
      if (cancelled || file.formatRequestId !== requestId || model.isDisposed?.() || model.getVersionId() !== version || model.getValue() !== content || result.modelVersion !== version || result.path !== file.path) { if (file.formatRequestId === requestId) message(t('formatStale'), true); return []; }
      root.monaco.editor.setModelMarkers(model, 'iexa-python-format', []);
      file.lastFormatter = result.formatter;
      message((result.changed ? t('formatted') : t('formatUnchanged')) + ` · ${result.formatter.name} ${result.formatter.version}`);
      return result.changed ? [{ range: model.getFullModelRange(), text: result.content }] : [];
    } catch (error) {
      if (file.formatRequestId === requestId) file.formatError = error;
      if (!cancelled && file.formatRequestId === requestId && !model.isDisposed?.() && model.getVersionId() === version) {
        const markers = (error.diagnostics || []).map(item => ({ message: item.message, severity: root.monaco.MarkerSeverity.Error, startLineNumber: item.line, startColumn: item.column, endLineNumber: item.endLine || item.line, endColumn: Math.max(item.column + 1, item.endColumn || item.column + 1) }));
        root.monaco.editor.setModelMarkers(model, 'iexa-python-format', markers);
        message(error.message, true);
        if (markers[0] && ownsEditorModel(file)) editor.revealLineInCenter(markers[0].startLineNumber);
      }
      return [];
    } finally { subscription?.dispose(); if (file.formatRequestId === requestId) { file.formattingVersion = null; file.formatRequestId = null; } }
  }
  async function formatDocument() {
    const file = current?.files.get(current.activePath); if (!file || !editor) return;
    const action = editor.getAction('editor.action.formatDocument');
    if (!action || action.isSupported?.() === false) { message('此语言尚未配置格式化器。Python 使用随包 Ruff；JS/TS/JSON/HTML/CSS 使用编辑器格式化器。', true); return; }
    const control = $('ideFormat'); if (control) { control.disabled = true; control.setAttribute('aria-busy', 'true'); }
    editor.focus();
    try { await action.run(); }
    finally { if (control) { control.disabled = false; control.removeAttribute('aria-busy'); } }
  }
  function themeName() { return document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs'; }
  function renderLanguageStatus() {
    const el = $('ideLanguageStatus'); if (!el) return;
    const state = languageService?.status(), file = current?.files.get(current.activePath), python = /\.(py|pyi|pyw)$/i.test(file?.path || '');
    el.hidden = !python; if (!python) return;
    const labels = { idle: 'Python', starting: 'Python · 启动中', ready: 'Python · 语言服务就绪', unavailable: 'Python · 语言服务未安装', error: 'Python · 语言服务错误', cooldown: 'Python · 等待重试' };
    const count = languageService?.diagnostics().length || 0;
    el.textContent = (labels[state?.status] || 'Python') + (count ? ` · ${count} 个问题` : ''); el.dataset.state = state?.status || 'idle'; el.title = state?.reason || el.textContent;
  }
  function makeFile(state, result) {
    const file = { path: result.path, content: result.content, revision: result.revision, encoding: result.encoding || 'utf-8', dirty: false, conflict: null, missing: false, model: null, view: null, saving: false };
    if (root.monaco) {
      const uri = root.monaco.Uri.parse(`iexa-ide://${encodeURIComponent(state.id)}/${result.path.split('/').map(encodeURIComponent).join('/')}`);
      file.model = root.monaco.editor.createModel(result.content, undefined, uri);
      file.model.detectIndentation?.(true, /\.(py|pyi|pyw)$/i.test(file.path) ? 4 : 2);
      file.model.onDidChangeContent(() => { if (file.formattingVersion && file.model.getVersionId() !== file.formattingVersion && api()?.formatCancel) void call('formatCancel', { workspaceId: state.id, path: file.path, modelVersion: file.formattingVersion, requestId: file.formatRequestId }).catch(() => {}); file.dirty = file.model.getValue() !== file.content; if (state === current) { renderTabs(); renderConflict(); } syncContext(); if (state === current) changes?.onModelChange(); });
      languageService?.attach(file.model, { workspaceId: state.id, path: file.path });
    }
    return file;
  }
  async function openFile(path) {
    if (!current) return; const state = current, epoch = ++state.openEpoch; await ensureEditor();
    let file = state.files.get(path);
    if (!file) {
      let result;
      try { result = await call('read', { workspaceId: state.id, path }); }
      catch (error) { if (state !== current || epoch !== state.openEpoch) return; throw error; }
      file = state.files.get(result.path) || makeFile(state, result); state.files.set(file.path, file);
    }
    if (state !== current || epoch !== state.openEpoch) { if (state === current) renderTabs(); return; }
    await showFile(state, file); state.selected = path; state.recent = [path, ...state.recent.filter(item => item !== path)].slice(0, 20); renderRecent(); renderTree(); persist();
  }
  async function showFile(state, file) {
    await ensureEditor(); if (state !== current || !file || !editor) return;
    const previous = state.files.get(state.activePath); if (ownsEditorModel(previous)) previous.view = editor.saveViewState();
    state.activePath = file.path; editor.setModel(file.model); if (file.view) editor.restoreViewState(file.view);
    $('ideEditorWelcome').hidden = true; $('ideMonaco').hidden = false; $('ideEditorPath').textContent = file.path; $('ideEditorPath').title = state.root + '/' + file.path;
    narrowExplorer = false; if (paneMode === 'preview' && !/\.html?$/i.test(file.path)) paneMode = !isSinglePane() && state.server.status === 'running' ? 'split' : 'code'; applyLayout();
    $('ideEncoding').textContent = file.encoding; renderTabs(); renderConflict(); renderLanguageStatus(); editor.layout(); editor.focus(); syncContext();
    message(t('ready') + ' · ' + file.path);
    if (paneMode !== 'code' && /\.html?$/i.test(file.path)) await ensureWebPreview(state);
    void changes?.refresh();
  }
  function renderTabs() {
    renderCursor();
    const tabs = $('ideEditorTabs'); if (!tabs) return; tabs.replaceChildren();
    (current?.files || new Map()).forEach(file => {
      const tab = node('div', 'ide-editor-tab' + (file.path === current.activePath ? ' is-active' : '')); tab.dataset.path = file.path; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(file.path === current.activePath)); tab.title = file.path + (file.dirty ? ' • ' + t('modified') : '');
      const open = node('button', '', file.path.split('/').pop()); open.type = 'button'; open.addEventListener('click', () => safely(() => showFile(current, file))); tab.append(open);
      if (file.dirty) { const dirty = node('span', 'ide-dirty-dot'); dirty.setAttribute('aria-label', t('modified')); tab.append(dirty); }
      const close = button('', 'close', 'close', () => closeFile(file)); close.removeAttribute('id'); tab.append(close); tabs.append(tab);
    });
    tabs.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const selected = current?.files.get(current.activePath);
    $('ideSave').disabled = !selected || selected.saving;
    $('ideRunFile').disabled = !selected;
    $('ideRunFile').title = t('runFile') + (selected ? ' · ' + selected.path : '');
    changes?.decorate();
    changes?.queueDecorations();
  }
  function renderCursor() {
    const el = $('ideCursor'); if (!el) return;
    const file = current?.files.get(current.activePath), model = editor?.getModel();
    const position = model && model === file?.model ? editor.getPosition() : null;
    if (!position) { el.textContent = ''; el.title = ''; el.removeAttribute('aria-label'); return; }
    const params = { line: position.lineNumber, column: position.column, total: model.getLineCount() };
    el.textContent = t('cursor', params); el.title = t('cursorHint', params); el.setAttribute('aria-label', el.title);
  }
  async function closeFile(file) {
    const state = current; if (!state || !file) return;
    if (file.dirty && !(await dialog('confirm', t('discard')))) return;
    state.files.delete(file.path); if (ownsEditorModel(file)) editor.setModel(null); languageService?.detach(file.model); file.model?.dispose();
    if (state.activePath === file.path) { state.activePath = state.files.keys().next().value || ''; if (state === current) { if (state.activePath) await showFile(state, state.files.get(state.activePath)); else { if ($('ideMonaco')) $('ideMonaco').hidden = true; $('ideEditorWelcome').hidden = false; $('ideEditorPath').textContent = ''; $('ideConflict').hidden = true; } } }
    renderTabs(); renderWelcome(); persist(); syncContext();
  }
  async function save() { if (current) return saveFile(current, current.files.get(current.activePath)); }
  function hasUnsavedChanges() { return [...states.values()].some(state => [...state.files.values()].some(file => file.dirty)); }
  function allowClose() { closeAllowed = true; }
  async function saveAll() {
    for (const state of states.values()) await saveProject(state.id);
    return !hasUnsavedChanges();
  }
  async function saveProject(workspaceId) {
    const state = states.get(workspaceId); if (!state) throw new Error(t('project'));
    for (const file of state.files.values()) if (file.dirty) {
      await saveFile(state, file);
      if (file.dirty || file.conflict || file.missing) throw new Error(t('conflict'));
    }
    if ([...state.files.values()].some(file => file.dirty)) throw new Error(t('conflict'));
    return true;
  }
  async function saveFile(state, file) {
    if (!file || file.saving) return; if (file.conflict || file.missing) { renderConflict(); return; }
    const content = file.model.getValue(); file.saving = true; renderTabs();
    try {
      const result = await call('write', { workspaceId: state.id, path: file.path, content, revision: file.revision });
      file.content = content; file.revision = result.revision; file.encoding = result.encoding || file.encoding; file.dirty = file.model.getValue() !== content;
      message(t('saved') + ' · ' + file.path); syncContext();
      if (state.server.status === 'running' && !state.server.script) await previewAction('reload', {}, state);
    } catch (error) {
      if (error.code === 'IDE_CONFLICT' || /conflict|外部|修改|changed|冲突/i.test(error.message || '')) { await checkFile(state, file); if (!file.conflict) file.conflict = true; renderConflict(); }
      throw error;
    } finally { file.saving = false; renderTabs(); await checkFile(state, file); }
  }
  function renderConflict() {
    const file = current?.files.get(current.activePath), box = $('ideConflict'); if (!box) return;
    box.hidden = !file?.conflict && !file?.missing;
    $('ideConflictText').textContent = file?.missing ? t('removed') : t('conflict');
    $('ideReloadDisk').hidden = !!file?.missing; $('ideKeepEdits').hidden = !!file?.missing;
  }
  async function reloadDisk() {
    const state = current, file = state?.files.get(state.activePath); if (!file) return;
    if (file.dirty && !(await dialog('confirm', t('discard')))) return;
    const disk = await call('read', { workspaceId: state.id, path: file.path });
    file.content = disk.content; file.revision = disk.revision; file.conflict = null; file.missing = false; file.model.setValue(disk.content); file.dirty = false; renderTabs(); renderConflict(); syncContext();
  }
  async function keepEdits() {
    const state = current, file = state?.files.get(state.activePath); if (!file) return;
    const disk = await call('read', { workspaceId: state.id, path: file.path });
    file.revision = disk.revision; file.content = disk.content; file.conflict = null; file.missing = false; file.dirty = file.model.getValue() !== disk.content; renderTabs(); renderConflict();
  }
  async function checkFile(state, file) {
    if (file.saving || state.files.get(file.path) !== file) return;
    const revision = file.revision;
    try {
      const disk = await call('read', { workspaceId: state.id, path: file.path });
      if (file.saving || file.revision !== revision || state.files.get(file.path) !== file) return;
      if (disk.revision === file.revision) return;
      if (file.dirty) file.conflict = disk;
      else { file.content = disk.content; file.revision = disk.revision; const view = ownsEditorModel(file) ? editor.saveViewState() : null; file.model.setValue(disk.content); if (view && ownsEditorModel(file)) editor.restoreViewState(view); file.dirty = false; file.conflict = null; }
      file.missing = false;
    } catch (error) { if (/ENOENT|not found|不存在|找不到|已删除/i.test(error.message || '')) { file.missing = true; } }
    if (state === current) { renderTabs(); renderConflict(); syncContext(); }
  }
  async function checkFiles(state = current) {
    if (!state) return;
    if (state.checking) { state.checkAgain = true; return; }
    state.checking = true;
    try { await Promise.all([...state.files.values()].map(file => checkFile(state, file))); }
    finally { state.checking = false; if (state.checkAgain) { state.checkAgain = false; await checkFiles(state); } }
  }
  async function refresh(state = current) {
    if (!state) return;
    await Promise.all([...state.expanded].map(path => loadDirectory(state, path, false).catch(() => state.tree.delete(path))));
    if (state === current) { renderTree(); await inspectProject(state); }
    await checkFiles(state);
    if (state === current) { await loadReviews(state); await changes?.refresh(); }
  }
  async function inspectProject(state) {
    if (state.inspecting) return; state.inspecting = true;
    try { state.inspection = await call('inspect', { workspaceId: state.id }); const server = await call('status', { workspaceId: state.id }); state.server = server; if (state === current) renderServer(); }
    finally { state.inspecting = false; }
  }
  function renderServer() {
    const state = current, server = state?.server || { status: 'stopped' };
    const status = $('ideServerStatus'); if (!status) return; status.textContent = t(server.status || 'stopped'); status.dataset.state = server.status || 'stopped';
    const script = $('ideScript'), old = script.value; script.replaceChildren();
    if (state?.inspection?.type === 'static') { const option = node('option', '', t('static')); option.value = ''; script.append(option); }
    (state?.inspection?.scripts || []).forEach(item => { const option = node('option', '', item.name); option.value = item.name; option.title = item.command; script.append(option); });
    if ([...script.options].some(item => item.value === old)) script.value = old;
    else if ([...script.options].some(item => item.value === 'dev')) script.value = 'dev';
    $('ideRun').disabled = !state || server.status === 'starting' || server.status === 'running'; $('ideStop').disabled = !state || !['starting', 'running'].includes(server.status);
    $('ideRestart').disabled = !state || server.status === 'starting';
    for (const id of ['idePreviewRefresh', 'idePreviewURL', 'idePreviewCopy']) $(id).disabled = server.status !== 'running';
    if (server.status !== 'running') { $('idePreviewBack').disabled = true; $('idePreviewForward').disabled = true; }
    if (server.url && document.activeElement !== $('idePreviewURL')) $('idePreviewURL').value = server.url;
    if (!server.url) $('idePreviewURL').value = '';
    $('idePreviewPlaceholder').textContent = server.error || (server.status === 'starting' ? t('starting') : t('previewHint'));
    renderLogs(); syncContext(); scheduleLayout();
  }
  async function runServer(restart) {
    if (!current) return; const state = current; if (!state.inspection) await inspectProject(state);
    if (/\.html?$/i.test(state.activePath) && !state.server.script) return ensureWebPreview(state, restart);
    const script = $('ideScript').value; const item = state.inspection?.scripts?.find(candidate => candidate.name === script);
    if (state.inspection?.type !== 'static' && !item) { message(t('noScript'), true); return; }
    if (item && !(await dialog('confirm', `${t('scriptConfirm')}\n\n${state.root}\n${item.name}: ${item.command}`))) return;
    state.server = { ...state.server, status: 'starting', error: '' }; renderServer();
    try { state.server = await call(restart ? 'restart' : 'start', { workspaceId: state.id, ...(item ? { script, confirmed: true } : {}) }); }
    catch (error) { state.server = { ...state.server, status: 'error', error: error.message }; throw error; }
    finally { if (state === current) renderServer(); }
  }
  async function stopServer() { if (!current) return; const state = current; state.server = await call('stop', { workspaceId: state.id }); if (state === current) renderServer(); }
  function renderLogs() {
    const host = $('ideLogs'); if (!host || !current) return;
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 35;
    const all = [...(current.server.logs || []), ...current.webErrors].slice(-160);
    const errors = all.filter(entry => /error|stderr/i.test(entry.level || ''));
    const entries = logMode === 'errors' ? errors : all; host.replaceChildren();
    $('ideLogTab').classList.toggle('is-active', logsShown && logMode === 'output'); $('ideLogTab').setAttribute('aria-selected', String(logsShown && logMode === 'output'));
    $('ideErrorsTab').classList.toggle('is-active', logsShown && logMode === 'errors'); $('ideErrorsTab').setAttribute('aria-selected', String(logsShown && logMode === 'errors'));
    $('ideTerminalTab').classList.toggle('is-active', logsShown && logMode === 'terminal'); $('ideTerminalTab').setAttribute('aria-selected', String(logsShown && logMode === 'terminal'));
    $('ideLogsClear').disabled = logMode === 'terminal'; $('ideLogs').hidden = !logsShown || logMode === 'terminal'; $('ideTaskTerminal').hidden = !logsShown || logMode !== 'terminal';
    const label = $('ideErrorsTab').querySelector('span'); if (label) label.textContent = t('problems') + (errors.length ? ` ${errors.length}` : '');
    entries.forEach(entry => { const line = node('div', /error|stderr/i.test(entry.level || '') ? 'ide-log-error' : '', String(entry.message ?? entry.text ?? '')); host.append(line); });
    if (atBottom) host.scrollTop = host.scrollHeight;
  }
  function renderTask() {
    if (!$('ideTaskOutput')) return;
    const task = current && root.IexaIDEAgent?.taskState?.(current.id), output = $('ideTaskOutput');
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 35;
    output.textContent = task ? [task.output, task.error, task.connectionError].filter(Boolean).join('\n') : t('taskEmpty');
    const label = task?.exitCode !== null && task?.exitCode !== undefined ? t('taskExit', { code: task.exitCode }) : task ? t(({ running: 'taskRunning', interrupting: 'taskInterrupting', stopping: 'taskStopping', stopped: 'taskStopped', failed: 'error' })[task.status] || 'ready') : t('ready');
    $('ideTaskStatus').textContent = label; $('ideTaskStatus').dataset.state = task?.status || 'idle';
    $('ideTaskCommand').textContent = task ? `${task.label} · ${task.cwd}` : ''; $('ideTaskCommand').title = task?.command || '';
    $('ideTaskInterrupt').disabled = !task || !['running', 'interrupting'].includes(task.status);
    $('ideTaskStop').disabled = !task?.sessionRunning || task.status === 'stopping';
    if (atBottom) output.scrollTop = output.scrollHeight;
  }
  async function runTask(kind) {
    if (!root.IexaIDEAgent?.runTask) throw new Error(t('desktop'));
    const value = context(); if (!value) return;
    modalDepth++;
    try {
      await hideNative();
      const task = await root.IexaIDEAgent.runTask(value, kind, kind === 'project' ? $('ideScript').value || undefined : undefined);
      if (task && current?.id === value.workspaceId) { logMode = 'terminal'; logsShown = true; setPane('code'); renderLogs(); renderTask(); }
    } finally { modalDepth--; scheduleLayout(); }
  }
  async function interruptTask() { if (current) await root.IexaIDEAgent?.interruptTask?.(current.id); renderTask(); }
  async function stopTask() { if (current) await root.IexaIDEAgent?.stopTask?.(current.id); renderTask(); }
  async function previewAction(action, data = {}, state = current) {
    if (!state) return;
    const show = nativePreviewVisible(state);
    const result = await call('preview', { workspaceId: state.id, action, visible: show, ...data });
    if (result?.url && state === current) $('idePreviewURL').value = result.url;
    if (!show || !nativePreviewVisible(state)) await call('preview', { workspaceId: state.id, action: 'hide' }).catch(() => {});
    syncContext(); return result;
  }
  async function hideNative() {
    previewLastBounds = '';
    if (!previewAttached || !api()) return;
    const id = previewAttached; previewAttached = '';
    await call('preview', { workspaceId: id, action: 'hide' }).catch(() => {});
  }
  function visible() {
    const panel = $('idePanel'); return !!(active && panel && panel.getBoundingClientRect().width > 0 && getComputedStyle(panel).display !== 'none' && $('view-chat')?.classList.contains('active') && !document.body.classList.contains('right-panel-hidden') && !document.body.classList.contains('chat-focus-mode'));
  }
  function nativePreviewVisible(state = current) {
    const rect = $('idePreviewViewport')?.getBoundingClientRect();
    return !!(state && state === current && !destroyed && visible() && previewShown && !$('idePreviewColumn').hidden && !$('ideMain').hidden && rect && rect.width >= 40 && rect.height >= 40 && !modalDepth && !resizeDetachPending && !changesOverlay && !paletteOpen && !openMenu && !$('ideContextMenu') && !document.querySelector('dialog[open], .html-preview-overlay:not([hidden]), .image-preview-overlay[style*="flex"], .command-palette:not([hidden])'));
  }
  async function syncNative() {
    if (destroyed) return;
    const viewport = $('idePreviewViewport'); const rect = viewport?.getBoundingClientRect();
    const allowed = nativePreviewVisible() && current?.server.status === 'running' && current.server.url;
    if (!allowed || !rect || rect.width < 40 || rect.height < 40) { await hideNative(); return; }
    const clip = $('ideCanvas').getBoundingClientRect();
    const left = Math.max(0, rect.left, clip.left), top = Math.max(0, rect.top, clip.top), right = Math.min(rect.right, clip.right, innerWidth), bottom = Math.min(rect.bottom, clip.bottom, innerHeight);
    if (right - left < 40 || bottom - top < 40) { await hideNative(); return; }
    const bounds = { x: Math.round(left), y: Math.round(top), width: Math.max(1, Math.round(right - left)), height: Math.max(1, Math.round(bottom - top)) };
    const state = current, signature = state.id + JSON.stringify(bounds);
    if (signature === previewLastBounds && previewAttached === state.id && state.attachedURL === state.server.url) return;
    if (previewAttached && previewAttached !== state.id) await hideNative();
    const changedURL = state.attachedURL !== state.server.url;
    const attach = previewAttached !== state.id || changedURL;
    previewAttached = state.id; previewLastBounds = signature; state.attachedURL = state.server.url;
    await call('preview', { workspaceId: state.id, action: attach ? 'attach' : 'bounds', ...(changedURL ? { url: state.server.url } : {}), bounds, visible: true }).catch(error => { previewLastBounds = ''; message(error.message, true); });
    // Loading a native page can outlive a tab switch or a newly opened dialog.
    // Hide the completed request as well, so a late attach cannot cover chat.
    if (!nativePreviewVisible(state)) {
      if (previewAttached === state.id) previewAttached = '';
      previewLastBounds = ''; await call('preview', { workspaceId: state.id, action: 'hide' }).catch(() => {});
    }
  }
  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; positionExpanded(); safely(syncNative); });
  }
  function positionExpanded() {
    const panel = $('idePanel'); if (!panel) return;
    const sideBySide = expanded && active;
    if (document.body.classList.contains('ide-side-by-side') !== sideBySide) document.body.classList.toggle('ide-side-by-side', sideBySide);
    if (document.body.classList.contains('ide-active') !== active) document.body.classList.toggle('ide-active', active);
    const width = panel.clientWidth || 940, narrow = sideBySide && width < 760;
    panel.classList.toggle('is-narrow', narrow);
    $('idePreviewResizer').setAttribute('aria-orientation', 'vertical');
    const single = isSinglePane(), filesOnly = single && narrowExplorer;
    $('ideExplorer').hidden = single ? !narrowExplorer : !explorerShown;
    $('ideExplorerResizer').hidden = single || !explorerShown;
    $('ideExplorerToggle').setAttribute('aria-pressed', String(single ? narrowExplorer : explorerShown));
    const mode = single && paneMode === 'split' ? 'code' : paneMode;
    $('ideMain').hidden = filesOnly;
    $('ideEditorColumn').hidden = mode === 'preview';
    $('idePreviewColumn').hidden = !previewShown || mode === 'code';
    $('idePreviewResizer').hidden = single || mode !== 'split' || !previewShown;
    panel.classList.toggle('is-preview-only', mode === 'preview');
    $('ideViewSplit').hidden = single;
    for (const [id, value] of [['ideViewFiles', 'files'], ['ideViewCode', 'code'], ['ideViewPreview', 'preview'], ['ideViewSplit', 'split']]) { const selected = filesOnly ? value === 'files' : value === mode; $(id).classList.toggle('is-active', selected); $(id).setAttribute('aria-selected', String(selected)); }
    $('ideLogsResizer').hidden = !logsShown;
    $('ideCanvas').classList.toggle('is-single', mode !== 'split' || single);
  }
  function isSinglePane() { return !expanded || $('idePanel')?.classList.contains('is-narrow'); }
  function showFiles() { explorerShown = true; narrowExplorer = true; applyLayout(); $('ideFileSearch')?.focus(); }
  async function ensureWebPreview(state = current, restart = false) {
    if (!state || !/\.html?$/i.test(state.activePath)) return;
    if (state.previewStarting) { await state.previewStarting; if (state !== current || paneMode === 'code') return; }
    const entryPath = state.activePath;
    if (!restart && state.server.status === 'running' && (state.server.script || state.previewEntry === entryPath)) return;
    state.previewStarting = (async () => {
      state.server = { ...state.server, status: 'starting', error: '' }; if (state === current) renderServer();
      try {
        state.server = await call(restart ? 'restart' : 'start', { workspaceId: state.id, entryPath });
        if (state.server.status === 'running') state.previewEntry = entryPath;
        if (state.server.status === 'error') throw new Error(state.server.error || t('error'));
      } catch (error) { state.server = { ...state.server, status: 'error', error: error.message }; throw error; }
      finally { if (state === current) renderServer(); }
    })();
    try { await state.previewStarting; } finally { state.previewStarting = null; }
  }
  function setPane(mode) { paneMode = mode; previewShown = mode !== 'code'; narrowExplorer = false; applyLayout(); if (mode !== 'code') void safely(() => ensureWebPreview()); }
  function applyLayout() {
    const panel = $('idePanel'); if (!panel) return;
    panel.classList.toggle('is-expanded', expanded && active);
    ['left', 'top', 'width', 'height'].forEach(key => panel.style.removeProperty(key));
    $('ideExpand').title = t(expanded ? 'collapse' : 'expand'); $('ideExpand').setAttribute('aria-label', $('ideExpand').title);
    $('ideExpand').setAttribute('aria-expanded', String(expanded));
    $('ideLogs').hidden = !logsShown || logMode === 'terminal'; $('ideTaskTerminal').hidden = !logsShown || logMode !== 'terminal';
    $('ideExplorerToggle').setAttribute('aria-pressed', String(explorerShown)); $('idePreviewToggle').setAttribute('aria-pressed', String(previewShown));
    positionExpanded(); editor?.layout(); persist(); scheduleLayout();
  }
  function toggleExpand() { expanded = !expanded; applyLayout(); }
  function context() {
    const file = current?.files.get(current.activePath), model = editor?.getModel(), selection = model && model === file?.model ? editor?.getSelection() : null;
    if (!current) return null;
    const content = file?.model?.getValue() || '', selectedCode = model && selection ? model.getValueInRange(selection) : '';
    return { workspaceId: current.id, root: current.root, name: current.name, activeFile: file?.path || '', content: content.slice(0, 16000), selectedCode: selectedCode.slice(0, 10000), contentTruncated: content.length > 16000, selectionTruncated: selectedCode.length > 10000, cursor: model && model === file?.model ? editor?.getPosition() || null : null, previewUrl: $('idePreviewURL')?.value || current.server.url || '', serverStatus: current.server.status, recentLogs: (current.server.logs || []).slice(-40), webErrors: current.webErrors.slice(-30), dirty: !!file?.dirty,
      openFiles: [...current.files.values()].slice(0, 32).map(item => ({ path: item.path, dirty: item.dirty })),
      dirtyFiles: [...current.files.values()].filter(item => item.dirty).map(item => ({ workspaceId: current.id, path: item.path })),
      languageStatus: languageService?.status()?.status || 'idle', languageDiagnostics: (languageService?.diagnostics() || []).slice(0, 32) };
  }
  function syncContext() { clearTimeout(contextTimer); contextTimer = setTimeout(() => { void flushContext().catch(() => {}); }, 180); }
  async function flushContext() { clearTimeout(contextTimer); const value = context(), epoch = projectEpoch; if (!value || !api()?.context) return null; await call('context', value); if (epoch === projectEpoch) root.IexaIDEAgent?.contextChanged?.(value); return value; }
  async function openAI() { const value = context(); if (!value) return; if (root.IexaIDEAgent?.openAI) await root.IexaIDEAgent.openAI(value); else await call('context', value); scheduleLayout(); }
  async function openTerminal() { const value = context(); if (!value) return; await hideNative(); if (root.IexaIDEAgent?.openTerminal) await root.IexaIDEAgent.openTerminal(value); }
  function editorCommands() { editor?.focus(); return editor?.getAction('editor.action.quickCommand')?.run(); }
  function commands() { return [['editorCommands', editorCommands], ['open', chooseFolder], ['save', save], ['saveAll', saveAll], ['format', formatDocument], ['find', () => editor?.getAction('editor.action.startFindReplaceAction')?.run()], ['gitChanges', showGitChanges], ['aiChanges', reviewAIChanges], ['nextChange', () => changes?.navigate(1)], ['previousChange', () => changes?.navigate(-1)], ['refresh', () => refresh()], ['run', () => runServer(false)], ['stop', stopServer], ['ai', openAI], ['terminal', openTerminal], [expanded ? 'collapse' : 'expand', toggleExpand]]; }
  function togglePalette(force) {
    paletteOpen = force === undefined ? !paletteOpen : force; $('idePalette')?.remove();
    if (!paletteOpen) { scheduleLayout(); return; } hideNative();
    const palette = node('div', 'ide-command-palette'); palette.id = 'idePalette'; palette.setAttribute('role', 'dialog'); palette.setAttribute('aria-label', t('command'));
    const input = node('input'); input.placeholder = t('commandHint'); input.setAttribute('aria-label', t('commandHint')); const results = node('div');
    const render = () => { results.replaceChildren(); commands().filter(([key]) => t(key).toLowerCase().includes(input.value.toLowerCase())).forEach(([key, action]) => { const item = button('', key, null, () => { togglePalette(false); return action(); }, true); item.removeAttribute('id'); results.append(item); }); };
    input.addEventListener('input', render); input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); results.querySelector('button')?.click(); } });
    palette.append(input, results); $('idePanel').append(palette); render(); input.focus();
  }
  function onEvent(event) {
    if (event.type === 'review-storage') { message(event.message, true); return; }
    const state = states.get(event.workspaceId); if (!state) return;
    if (event.type === 'review') { if (event.message) message(event.message, true); safely(() => loadReviews(state)); return; }
    if (event.type === 'server') { state.server = event.server || event.state || { ...state.server, ...event }; if (state === current) renderServer(); }
    else if (event.type === 'preview') {
      if (event.message || event.error) { state.webErrors.push({ level: event.level || 'error', message: String(event.message || event.error), time: event.time || Date.now() }); state.webErrors = state.webErrors.slice(-100); if (state === current && /error/i.test(event.level || 'error')) { logsShown = true; applyLayout(); } }
      if (event.url && state === current && document.activeElement !== $('idePreviewURL')) $('idePreviewURL').value = event.url;
      if (state === current) { $('idePreviewBack').disabled = !event.canGoBack; $('idePreviewForward').disabled = !event.canGoForward; }
      if (state === current) { renderLogs(); syncContext(); }
    } else if (event.type === 'files') {
      clearTimeout(state.syncTimer); state.syncTimer = setTimeout(() => safely(async () => { await checkFiles(state); if (state === current) { await refresh(state); if (state.server.status === 'running' && state.inspection?.type === 'static') await previewAction('reload', {}, state); } }), 220);
    }
  }
  function init() {
    if (initialized || !$('idePanel')) return; initialized = true;
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('iexa-ide-layout') || '{}'); } catch {}
    build();
    expanded = !!saved.expanded; explorerShown = saved.explorerShown !== false; previewShown = saved.previewShown !== false; logsShown = saved.logsShown === true;
    paneMode = ['code', 'preview', 'split'].includes(saved.paneMode) ? saved.paneMode : 'code'; logMode = ['errors', 'terminal'].includes(saved.logMode) ? saved.logMode : 'output';
    unsubscribeTask = root.IexaIDEAgent?.onTask?.(task => { if (task.workspaceId === current?.id) { renderTask(); renderLogs(); } });
    if (/^\d+px$/.test(saved.explorerWidth || '')) $('idePanel').style.setProperty('--ide-explorer-width', saved.explorerWidth);
    if (/^\d+px$/.test(saved.previewWidth || '')) $('idePanel').style.setProperty('--ide-preview-width', saved.previewWidth);
    if (/^\d+px$/.test(saved.previewHeight || '')) $('idePanel').style.setProperty('--ide-preview-height', saved.previewHeight);
    if (/^\d+px$/.test(saved.logHeight || '')) $('idePanel').style.setProperty('--ide-log-height', saved.logHeight);
    if (/^\d+px$/.test(saved.chatWidth || '')) document.querySelector('#view-chat .chat-layout')?.style.setProperty('--ide-chat-width', saved.chatWidth);
    if (api()) {
      unsubscribe = api().onEvent?.(onEvent);
      restoring = true;
      const initialEpoch = projectEpoch;
      readyPromise = safely(async () => {
        const primaryProject = api()?.currentProject ? await call('currentProject') : undefined;
        const result = await call('projects');
        const authorized = (result.projects || []).filter(project => project && typeof project.id === 'string' && project.id && typeof project.root === 'string' && project.root);
        authorized.forEach(stateFor); renderProjects();
        // Match only projects already authorized by the native picker/registry.
        // The conversation root helps choose among them; it grants no access.
        let chatRoot; try { chatRoot = typeof projectRoot === 'string' ? projectRoot : root.projectRoot; } catch { chatRoot = root.projectRoot; }
        const normalized = path => String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const restoreProject = api()?.currentProject ? primaryProject : authorized.find(project => chatRoot && normalized(project.root) === normalized(chatRoot)) || authorized.find(project => project.id === saved.projectId) || authorized[0];
        const restore = restoreProject?.id ? stateFor(restoreProject) : null;
        // Read each cached tab from disk into its own project. The saved state
        // contains paths only; unsaved code never gets silently persisted.
        if ((saved.open || []).some(item => item.paths?.length)) await ensureEditor();
        for (const cached of saved.open || []) {
          const state = states.get(cached.id); if (!state) continue;
          for (const path of cached.paths || []) {
            if (state.files.has(path)) continue;
            try { const disk = await call('read', { workspaceId: state.id, path }); if (!state.files.has(disk.path)) state.files.set(disk.path, makeFile(state, disk)); } catch { /* a file may have moved while the app was closed */ }
          }
          if (!state.activePath) state.activePath = state.files.has(cached.activePath) ? cached.activePath : state.files.keys().next().value || '';
          state.recent = [...state.files.keys()].slice(-20).reverse();
        }
        if (restore && !current && projectEpoch === initialEpoch) await openProject(restore);
        else if (current) { renderTabs(); renderRecent(); }
      }).finally(() => { restoring = false; persist(); });
      poll = setInterval(() => { if (active && current) safely(() => checkFiles()); }, 2200);
    }
    const observer = new MutationObserver(() => { if (root.monaco) root.monaco.editor.setTheme(themeName()); scheduleLayout(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); observer.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true });
    document.querySelectorAll('.view').forEach(view => observer.observe(view, { attributes: true, attributeFilter: ['class'] }));
    document.querySelectorAll('#htmlPreviewOverlay, #imagePreviewOverlay, #commandPalette').forEach(overlay => observer.observe(overlay, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] }));
    new ResizeObserver(scheduleLayout).observe($('idePreviewViewport'));
    new ResizeObserver(scheduleLayout).observe($('idePanel'));
    $('ideLayout').addEventListener('scroll', scheduleLayout, { passive: true });
    bindChatResizer();
    window.addEventListener('resize', scheduleLayout); window.addEventListener('focus', scheduleLayout);
    document.addEventListener('click', event => { if (!event.target.closest('#ideContextMenu')) closeContext(); if (!event.target.closest('.ide-menu')) closeMenus(); scheduleLayout(); }, true);
    document.addEventListener('keydown', event => {
      if (!active || !visible() || event.isComposing) return;
      if (event.key === 'Escape') { closeContext(); closeMenus(); if (paletteOpen) { event.preventDefault(); togglePalette(false); } }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); safely(event.shiftKey ? saveAll : save); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); event.stopImmediatePropagation(); togglePalette(); }
      else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'p') { event.preventDefault(); event.stopImmediatePropagation(); showFiles(); $('ideFileSearch')?.select(); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f' && typeof root.switchWorkbenchView === 'function') { event.preventDefault(); event.stopImmediatePropagation(); root.switchWorkbenchView('search'); }
      if (event.shiftKey && event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopImmediatePropagation(); safely(formatDocument); }
    }, true);
    window.addEventListener('beforeunload', event => { if (!closeAllowed && hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('pagehide', () => { destroyed = true; clearInterval(poll); clearTimeout(contextTimer); clearTimeout(searchTimer); clearTimeout(syncTimer); unsubscribe?.(); unsubscribeTask?.(); observer.disconnect(); hideNative(); changes?.destroy(); pythonFormatter?.dispose(); languageService?.dispose(); editor?.dispose(); states.forEach(state => { clearTimeout(state.syncTimer); state.files.forEach(file => file.model?.dispose()); }); }, { once: true });
    root.IexaI18n?.onLocaleChange(() => { $('idePanel').querySelectorAll('[data-ide-label]').forEach(el => { el.title = t(el.dataset.ideLabel); el.setAttribute('aria-label', el.title); const label = el.querySelector('span'); if (label) label.textContent = t(el.dataset.ideLabel); }); $('ideTasks').querySelectorAll('option').forEach(option => { option.textContent = t(option.dataset.ideTaskLabel); }); $('ideFileSearch').placeholder = t('search'); renderProjects(); renderTree(); renderServer(); renderWelcome(); renderTask(); applyLayout(); });
    applyLayout();
  }
  function activate(value) { init(); active = !!value; languageService?.setEnabled(active); applyLayout(); if (active) { editor?.layout(); safely(async () => { await loadReviews(); await changes?.refresh(); }); scheduleLayout(); } else { changes?.closeDiff(false); togglePalette(false); closeContext(); safely(hideNative); } }
  function ready() { init(); return readyPromise; }
  function snapshot() { return { active, expanded, paneMode, logMode, workspaceId: current?.id || '', project: current ? { id: current.id, root: current.root, name: current.name } : null, activeFile: current?.activePath || '', files: [...(current?.files.values() || [])].map(file => ({ path: file.path, dirty: file.dirty, conflict: !!file.conflict, revision: file.revision })), server: current?.server, previewAttached, error: lastError }; }
  function onFileChange() { clearTimeout(syncTimer); syncTimer = setTimeout(() => safely(async () => { await Promise.all([...states.values()].map(state => checkFiles(state))); if (current) await refresh(current); }), 180); }
  root.IexaIDE = Object.freeze({ init, ready, activate, openProject, bindProject, openFile, save, saveAll, saveProject, hasUnsavedChanges, allowClose, refresh, context, flushContext, snapshot, toggleExpand, onFileChange, formatDocument, changes: () => changes, loadReviews });
})(window);
