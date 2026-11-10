'use strict';

// Actual application workbench scenarios. All UI changes go through the
// DesktopAgent methods supplied by the parent harness; CDP is an oracle only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runWorkbench(h) {
  const q = JSON.stringify;
  const project = h.report.fixture.project;
  assert.ok(project && path.resolve(project).startsWith(path.resolve(h.fixture) + path.sep), 'Owned fixture project');
  const token = 'COMPONENT_WORKBENCH_' + h.report.runId.slice(0, 8);
  let sessionId = '';
  const read = expression => h.read(expression);
  const text = selector => read(`document.querySelector(${q(selector)})?.textContent || ''`);
  const value = selector => read(`document.querySelector(${q(selector)})?.value ?? null`);
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return !e.hidden&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const shown = (selector, label = selector) => h.until(() => visible(selector), 'Visible ' + label, 10000);
  const gone = selector => h.until(async () => !(await visible(selector)), 'Closed ' + selector, 6000);
  const click = selector => h.clickSelector(selector);
  const type = (selector, contents) => h.typeSelector(selector, contents);
  const key = (selector, keys) => h.keySelector(selector, keys);
  const getSessions = () => read("fetch('/api/sessions',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('Session GET '+r.status);return r.json()})");
  const activeId = () => read("document.querySelector('.session-item.active')?.dataset.id || ''");
  const session = async id => (await getSessions()).sessions.find(s => s.id === id);
  const waitText = (selector, expected, timeout = 12000) => h.until(async () => (await text(selector)).includes(expected), 'Text ' + expected, timeout);
  async function conversation() {
    if (await visible('dialog[open] .archive-close')) await click('dialog[open] .archive-close');
    if (await visible('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)')) await click('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)');
    if (!(await visible('#chatInput')) && await visible('.nav-btn[data-view="chat"]')) await click('.nav-btn[data-view="chat"]');
    if (await visible('[data-chat-view="conversation"]')) await click('[data-chat-view="conversation"]');
    await shown('#chatInput');
  }
  async function chat(prompt, expected = 'COMPONENT_REPLY_OK') {
    await conversation();
    await type('#chatInput', prompt);
    await click('#sendBtn');
    await waitText('#chatMessages', expected, 22000);
    await h.until(async () => !(await visible('#stopBtn')) && await visible('#sendBtn'), 'Chat finishes', 22000);
  }
  async function workbench(view) {
    await conversation();
    await click(`[data-workbench-view="${view}"]`);
    await shown(view === 'files' ? '#filesList' : '#' + view + 'Panel');
  }
  async function more(button) {
    if (!(await visible('#' + button))) {
      if (['ideRun', 'ideStop', 'ideRestart', 'ideTasks', 'ideRunTask'].includes(button)) await click('#ideRunMenu');
      else await click('#ideMoreMenu');
    }
    await shown('#' + button);
    await click('#' + button);
  }
  async function ideFile(file) {
    await workbench('ide');
    if (!(await visible('#ideTree'))) await click('#ideViewFiles');
    const selector = '#ideTree [data-path=' + q(file) + ']';
    await shown(selector);
    await click(selector);
    await shown('#ideMonaco');
    await waitText('#ideEditorPath', file);
  }
  const attempt = async (name, fn) => {
    await h.check('Workbench / ' + name, fn);
    // A failed assertion must not leave a fixture modal masking the next
    // independent check. Dismiss only visible product controls, via the same
    // desktop path used by every other action.
    try {
      if (await visible('#composerEditStrip .composer-edit-cancel')) await click('#composerEditStrip .composer-edit-cancel');
      if (await visible('#archiveManagerDialog .archive-close')) await click('#archiveManagerDialog .archive-close');
      if (await visible('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)')) await click('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)');
      if (await visible('#codePreviewClose')) await click('#codePreviewClose');
      if (await visible('#ideMoreMenuPopup')) await click('#ideMoreMenu');
      if (await visible('#ideRunMenuPopup')) await click('#ideRunMenu');
      if (await visible('#textContextMenu')) await key('#chatInput', 'ESC');
      if (await visible('.share-menu')) await click('#chatInput');
    } catch (error) {
      (h.report.workbenchRecoveryErrors ||= []).push({ after: name, error: error.message }); h.save();
    }
  };

  await attempt('new conversation creates a real persisted session', async () => {
    await conversation();
    const before = new Set((await getSessions()).sessions.map(s => s.id));
    await click('#newSessionBtn');
    sessionId = await h.until(async () => { const id = await activeId(); return id && !before.has(id) && id; }, 'New persisted active session');
    const saved = await session(sessionId);
    assert.ok(saved);
    return { id: sessionId, projectRoot: saved.projectRoot, previousSessions: before.size };
  });
  await attempt('rename via title input saves exact new title', async () => {
    sessionId ||= await activeId();
    await click('.session-item.active .session-item-title');
    await shown('.session-item-rename-input');
    await type('.session-item-rename-input', token);
    await key('.session-item-rename-input', 'ENTER');
    await h.until(async () => (await session(sessionId))?.title === token, 'Persisted renamed title');
    assert.equal(await text('.session-item.active .session-item-title'), token);
    return { id: sessionId, title: token };
  });
  await attempt('session search and clear return actual matching conversation', async () => {
    await type('#searchInput', token);
    await waitText('#searchResults', token);
    const hits = await read("Array.from(document.querySelectorAll('#searchResults .search-result-item')).map(e=>({id:e.dataset.uiArg,text:e.textContent}))");
    assert.ok(hits.some(item => item.id === sessionId));
    await click('#searchClear');
    assert.equal(await value('#searchInput'), '');
    await shown('.session-item.active');
    return { hits };
  });
  await attempt('session menu pins and unpins through actual metadata', async () => {
    const trigger = '.session-item.active .session-item-more';
    await click(trigger); await shown('.session-menu');
    await click('.session-menu [data-ui-action="toggleSessionPin"]');
    await h.until(async () => (await session(sessionId))?.pinned === true, 'Session pinned');
    await click(trigger); await click('.session-menu [data-ui-action="toggleSessionPin"]');
    await h.until(async () => (await session(sessionId))?.pinned !== true, 'Session unpinned');
    return { id: sessionId, pinned: false };
  });
  await attempt('archive and restore through archive manager', async () => {
    await click('.session-item.active .session-item-more');
    await click('.session-menu [data-ui-action="archiveSession"]');
    await h.until(async () => (await session(sessionId))?.archived === true, 'Archived metadata');
    await click('#archiveManagerBtn'); await shown('#archiveManagerDialog');
    const rows = await read("Array.from(document.querySelectorAll('#archiveManagerDialog .archive-manager-row')).map(e=>e.textContent)");
    assert.ok(rows.some(t => t.includes(token)));
    const restoreIndex = await read(`Array.from(document.querySelectorAll('#archiveManagerDialog .archive-manager-row')).findIndex(e=>e.textContent.includes(${q(token)}))`);
    await click(`#archiveManagerDialog .archive-manager-row:nth-child(${restoreIndex + 1}) button:nth-child(2)`);
    await h.until(async () => (await session(sessionId))?.archived === false, 'Restored metadata');
    await click('#archiveManagerDialog .archive-close');
    await click(`.session-item[data-id=${q(sessionId)}] .session-item-info`);
    await h.until(async () => await activeId() === sessionId, 'Restored conversation active');
    return { id: sessionId, archived: false };
  });
  await attempt('chat Send streams actual local provider result and persists both messages', async () => {
    await chat(token + ' 请返回本地组件回执。');
    const saved = await read(`fetch('/api/sessions/'+encodeURIComponent(${q(sessionId)}),{cache:'no-store'}).then(r=>r.json())`);
    const messages = saved.messages || saved.session?.messages || [];
    assert.ok(messages.some(m => m.role === 'user' && m.content.includes(token)));
    assert.ok(messages.some(m => m.role === 'assistant' && m.content.includes('COMPONENT_REPLY_OK')));
    await h.screenshot('workbench-chat-result');
    return { sessionId, messageCount: messages.length, providerRequests: h.report.providerRequests.length };
  });
  await attempt('message edit and cancel preserve original persisted user turn', async () => {
    await conversation();
    const id = await activeId();
    const history = () => read(`fetch('/api/sessions/'+encodeURIComponent(${q(id)}),{cache:'no-store'}).then(r=>r.json())`);
    const originalHistory = await history();
    const before = await text('#chatMessages .message.user:last-of-type .message-content');
    const buttons = await read("Array.from(document.querySelectorAll('#chatMessages .user-message-edit')).length");
    assert.ok(buttons > 0);
    await click('#chatMessages .message.user .user-message-edit');
    await shown('#composerEditStrip');
    assert.ok((await value('#chatInput')).includes(token));
    const cancel = await read("(()=>{const buttons=[...document.querySelectorAll('#composerEditStrip button')];return buttons.map(e=>({id:e.id,text:e.textContent,title:e.title,action:e.dataset.action,ui:e.dataset.uiAction}))})()");
    const selector = '#composerEditStrip button';
    await click(selector);
    await gone('#composerEditStrip');
    assert.deepEqual(await history(), originalHistory, 'Cancel preserves the actual persisted record');
    await click('#chatMessages .message.user .user-message-edit'); await shown('#composerEditStrip');
    const edited = token + '_EDIT_SUBMITTED';
    await type('#chatInput', edited); await click('#sendBtn');
    await h.until(() => h.report.providerRequests.some(r => r.stream && r.userTexts?.includes(edited)), 'Provider receives exact edited user text part');
    await gone('#composerEditStrip');
    await h.until(async () => !await visible('#stopBtn'), 'Edited response finished');
    const saved = await h.until(async () => {
      const record = await history(), messages = record.messages || record.session?.messages || [];
      return messages.some(m => m.role === 'user' && m.content === edited) && messages.some(m => m.role === 'assistant' && m.content.includes('COMPONENT_REPLY_OK')) && record;
    }, 'Edited prompt and reply persisted');
    assert.ok((await text('#chatMessages')).includes(edited));
    return { originalText: before, cancelControls: cancel, cancelHistoryUnchanged: true, edited, providerReceivedEditedText: true, persisted: saved };
  });
  await attempt('assistant Share menu opens with actual reply actions', async () => {
    await conversation();
    await click('#chatMessages .message.assistant:last-child [data-action="share"]');
    await shown('.share-menu');
    const menu = await text('.share-menu');
    assert.ok(await visible('.share-menu [data-share="json"]'));
    assert.ok(await visible('.share-menu [data-share="text"]'));
    const downloads = h.report.fixture.downloads, artifacts = [];
    for (const [format, suffix] of [['json', '.json'], ['text', '.txt']]) {
      if (!await visible('.share-menu')) await click('#chatMessages .message.assistant:last-child [data-action="share"]');
      await shown('.share-menu');
      const beforeFiles = new Set(fs.readdirSync(downloads));
      await click('.share-menu [data-download=' + q(format) + ']');
      const file = await h.until(() => fs.readdirSync(downloads).find(name => !beforeFiles.has(name) && name.endsWith(suffix)), 'Actual share download ' + suffix);
      const contents = fs.readFileSync(path.join(downloads, file), 'utf8');
      assert.ok(contents.includes(token + '_EDIT_SUBMITTED'));
      assert.ok(contents.includes('COMPONENT_REPLY_OK'));
      if (format === 'json') {
        const payload = JSON.parse(contents);
        assert.equal(payload.schema, 'iexa.conversation.share/1');
        assert.equal(payload.session.id, await activeId());
        assert.equal(payload.exchange.prompt, token + '_EDIT_SUBMITTED');
      }
      const artifact = path.join(h.out, 'actual-share-export' + suffix); fs.copyFileSync(path.join(downloads, file), artifact);
      artifacts.push({ format, artifact, bytes: Buffer.byteLength(contents) });
    }
    await click('#chatInput'); await gone('.share-menu');
    return { menu, actualDownloads: artifacts, clipboardUsed: false };
  });
  await attempt('assistant Regenerate reaches real provider and completes next reply', async () => {
    await conversation();
    const before = h.report.providerRequests.length;
    await click('#chatMessages .message.assistant:last-child [data-action="retry"]');
    if (await visible('dialog.iexa-app-dialog[open] .btn-primary')) await click('dialog.iexa-app-dialog[open] .btn-primary');
    await h.until(() => h.report.providerRequests.length > before, 'Regenerate provider request', 16000);
    await h.until(async () => !(await visible('#stopBtn')) && await visible('#sendBtn'), 'Regenerated chat finishes', 22000);
    await waitText('#chatMessages', 'COMPONENT_REPLY_OK');
    return { requestsBefore: before, requestsAfter: h.report.providerRequests.length };
  });
  await attempt('composer text context menu opens with selected fixture text and dismisses', async () => {
    await conversation(); await type('#chatInput', token + ' CONTEXT_MENU');
    await key('#chatInput', ['CTRL', 'A']);
    await h.selectorAction('click', '#chatInput', { button: 'right' });
    await shown('#textContextMenu');
    assert.ok(await visible('#textContextMenu [data-text-action="copy"]'));
    assert.ok(await visible('#textContextMenu [data-text-action="paste"]'));
    const menu = await text('#textContextMenu');
    await key('#chatInput', 'ESC'); await gone('#textContextMenu');
    await type('#chatInput', '');
    return { menu, selectedFixture: token };
  });
  await attempt('local model menu refresh and selection retain the local provider', async () => {
    await conversation(); await click('#modelSelector'); await shown('#modelSelectorMenu');
    await click('#modelSelectorRefresh');
    await shown('#modelSelectorList .model-selector-option');
    const label = await text('#modelSelectorList');
    assert.ok(label.includes('Component Local Fixture') || label.includes('component-model'));
    await click('#modelSelectorList .model-selector-option');
    await gone('#modelSelectorMenu');
    return { options: label, selected: await text('#modelSelectorLabel') };
  });
  await attempt('permission menu changes mode and restores full fixture mode', async () => {
    for (const mode of ['plan', 'ask', 'risk', 'full']) {
      await click('#permissionModeBtn'); await shown('#permissionModeMenu');
      await click(`[data-permission-menu-mode="${mode}"]`);
      await h.until(() => read(`document.querySelector('[data-permission-menu-mode="${mode}"]')?.getAttribute('aria-checked')==='true'`), 'Selected permission ' + mode);
      if (await visible('dialog.iexa-app-dialog[open]')) await click('dialog.iexa-app-dialog[open] .btn-primary');
    }
    return { label: await text('#permissionModeLabel') };
  });
  await attempt('context capacity menu chooses 128K and restores Auto', async () => {
    await click('#contextCompactionBtn'); await shown('#contextCompactionMenu');
    await click('#contextCompactionMenu [data-limit="128000"]');
    await h.until(() => read("document.getElementById('contextCompactionBtn').dataset.limit==='128000'"), 'Capacity 128K');
    if (!(await visible('#contextCompactionMenu'))) await click('#contextCompactionBtn');
    await click('#contextCompactionMenu [data-limit="auto"]');
    await h.until(() => read("document.getElementById('contextCompactionBtn').dataset.limit==='auto'"), 'Capacity Auto');
    if (await visible('#contextCompactionMenu')) await click('#contextCompactionBtn');
    return { label: await text('#contextCompactionLabel') };
  });
  await attempt('thinking capability state and checkpoints open and dismiss through actual controls', async () => {
    await conversation();
    const capability = await read("(()=>{const b=document.getElementById('thinkingLevelBtn'),s=document.getElementById('thinkingLevelSlider');return {disabled:b.disabled,level:b.dataset.level,label:document.getElementById('thinkingLevelLabel').textContent,sliderDisabled:s.disabled}})()");
    let thinking;
    if (capability.disabled) {
      const profile = await read("fetch('/api/profiles',{cache:'no-store'}).then(r=>r.json()).then(d=>{const p=d.profiles.find(p=>p.id==='component-local');return {model:p?.model,provider:p?.provider}})");
      assert.equal(profile.model, 'component-model', 'Local fixture has no reasoning capability');
      assert.equal(capability.level, 'off');
      assert.equal(capability.sliderDisabled, true);
      assert.equal(await visible('#thinkingLevelMenu'), false);
      thinking = { verifiedBranch: 'Reasoning control correctly disabled for component-model', menuOpened: false, ...capability };
    } else {
      await click('#thinkingLevelBtn'); await shown('#thinkingLevelMenu');
      thinking = { menuOpened: true, contents: await text('#thinkingLevelMenu'), ...capability };
      await click('#thinkingLevelBtn'); await gone('#thinkingLevelMenu');
    }
    await click('#checkpointBtn'); await shown('#checkpointPopover');
    await click('#checkpointRefresh');
    const checkpointData = await read("fetch('/api/checkpoints?sessionId='+encodeURIComponent(currentSessionId),{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('Checkpoint GET '+r.status);return r.json()})");
    await h.until(() => read(`document.querySelectorAll('#checkpointList .checkpoint-row').length===${(checkpointData.checkpoints || []).length}&&!!document.querySelector('#checkpointList').textContent.trim()&&!/加载|loading|読み込み/i.test(document.querySelector('#checkpointList').textContent)`), 'Actual checkpoint list rendered');
    const checkpoints = await text('#checkpointList');
    await click('#checkpointBtn'); await gone('#checkpointPopover');
    return { thinking, checkpoints };
  });
  await attempt('file-read tool uses real project bytes and expandable tool details', async () => {
    await chat('COMPONENT_TOOL_READ ' + token + ' 读取 note.txt。', 'COMPONENT_TOOL_READ_OK');
    const message = await read("(()=>{const blocks=[...document.querySelectorAll('#chatMessages .tool-block')];const e=blocks.at(-1)?.closest('.message');if(!e)throw Error('Completed file-read tool message absent');const css=n=>n.id?'#'+CSS.escape(n.id):css(n.parentElement)+' > '+n.tagName.toLowerCase()+':nth-child('+(Array.from(n.parentElement.children).indexOf(n)+1)+')';return css(e)})()");
    const turnSummary = message + ' .turn-summary[aria-expanded="false"]';
    if (await visible(turnSummary)) await click(turnSummary);
    const taskSummary = message + ' .task-summary[aria-expanded="false"]';
    if (await visible(taskSummary)) await click(taskSummary);
    const block = message + ' .tool-block', header = block + ' .tool-header';
    await shown(header); await click(header);
    await shown(block + ' [data-tool-tab="output"]');
    await click(block + ' [data-tool-tab="output"]');
    await waitText(block + ' [data-pane="output"]', 'COMPONENT_FILE_ORIGINAL');
    const details = await text(block + ' [data-pane="output"]');
    assert.ok(details.includes('note.txt') || details.includes('COMPONENT_FILE_ORIGINAL'));
    await h.screenshot('workbench-tool-details');
    return { details: details.slice(0, 1500), disk: fs.readFileSync(path.join(project, 'note.txt'), 'utf8') };
  });
  await attempt('trajectory refresh filters and inspector use actual completed turn events', async () => {
    await click('[data-chat-view="trajectory"]'); await shown('#trajectoryView');
    await click('#trajectoryRefresh'); await shown('#trajectoryList .trajectory-row');
    const all = await read("document.querySelectorAll('#trajectoryList .trajectory-row').length");
    await click('[data-trajectory-filter="tool"]');
    await shown('#trajectoryList .trajectory-row');
    const kinds = await read("Array.from(document.querySelectorAll('#trajectoryList .trajectory-row')).map(e=>e.dataset.kind)");
    assert.ok(kinds.length && kinds.every(k => /tool/.test(k)));
    await click('#trajectoryList .trajectory-row'); await shown('#trajectoryInspector');
    const inspector = await text('#trajectoryInspector');
    assert.ok(inspector.length > 0);
    await click('[data-trajectory-filter="all"]');
    await click('[data-chat-view="conversation"]');
    return { all, toolKinds: kinds, inspector: inspector.slice(0, 1200) };
  });
  await attempt('native attachment picker cancellation keeps composer draft and zero attachment', async () => {
    await conversation(); await type('#chatInput', token + ' ATTACHMENT_CANCEL_DRAFT');
    assert.equal(typeof h.chooseNativePath, 'function', 'Harness exposes native owned dialog cancellation');
    const nativeReceipt = await h.chooseNativePath(() => h.nativeClickSelector('#attachBtn'), '', { cancel: true });
    assert.equal(await value('#chatInput'), token + ' ATTACHMENT_CANCEL_DRAFT');
    assert.equal(await read("document.querySelectorAll('#attachPreview .attach-chip').length"), 0);
    await type('#chatInput', '');
    return { nativeReceipt, attachments: 0 };
  });
  await attempt('Files tab reads project file and closes preview', async () => {
    await workbench('files'); await shown('#filesList [data-path="note.txt"]');
    await click('#filesList [data-path="note.txt"]');
    await shown('#filesPreview[data-open="true"] .code-preview-body');
    await waitText('#filesPreview .code-preview-body', 'COMPONENT_FILE_ORIGINAL');
    assert.equal(await text('#codePreviewName'), 'note.txt');
    const preview = await text('#filesPreview .code-preview-body');
    await click('#codePreviewClose'); await gone('#filesPreview');
    await click('#filesRefreshBtn');
    return { preview, projectPath: await text('#filesPath') };
  });
  await attempt('file context menu exposes real file actions and closes', async () => {
    await workbench('files'); await shown('#filesList [data-path="note.txt"]');
    await h.selectorAction('click', '#filesList [data-path="note.txt"]', { button: 'right' });
    await shown('#filesContextMenu');
    const actions = await read("Array.from(document.querySelectorAll('#filesContextMenu [data-action]')).filter(e=>!e.hidden&&getComputedStyle(e).display!=='none').map(e=>({action:e.dataset.action,text:e.textContent}))");
    assert.ok(actions.length >= 3);
    await click('[data-workbench-view="files"]'); await gone('#filesContextMenu');
    return { file: 'note.txt', actions };
  });
  await attempt('project Search returns real file and line result', async () => {
    await workbench('search'); await type('#workspaceSearchInput', 'COMPONENT_FILE_ORIGINAL');
    await shown('#workspaceSearchResults .workspace-search-result');
    const results = await read("Array.from(document.querySelectorAll('#workspaceSearchResults .workspace-search-result')).map(e=>({path:e.dataset.path,text:e.textContent}))");
    assert.ok(results.some(r => r.path === 'note.txt' && r.text.includes('COMPONENT_FILE_ORIGINAL')));
    await click('#workspaceSearchResults .workspace-search-result');
    return { results };
  });
  await attempt('Git tab opens real diff, stages and unstages fixture change', async () => {
    await workbench('git');
    assert.ok(fs.existsSync(path.join(project, '.git')), 'Fixture has a real isolated Git repository');
    await shown('#gitBranchSelect'); await shown('#gitPanel .git-file');
    const status = await text('#gitPanel');
    const changed = await read("document.querySelector('#gitPanel .git-file')?.dataset.path");
    assert.ok(changed);
    const row = '#gitPanel .git-file[data-path=' + q(changed) + ']';
    await click(row + ' .git-file-path'); await shown('#gitDiffHost .git-diff');
    const diff = await text('#gitDiffHost'); assert.ok(diff.includes(changed));
    await click('#gitDiffHost .git-diff-close');
    await click(row + ' [data-git-action="stage"]');
    await shown(row + ' [data-git-action="unstage"]');
    await click(row + ' [data-git-action="unstage"]');
    await shown(row + ' [data-git-action="stage"]');
    return { repository: true, changed, status: status.slice(0, 1600), diff: diff.slice(0, 800) };
  });
  await attempt('Terminal creates real shell, runs receipt command and stops it', async () => {
    await workbench('terminal');
    await h.selectSelector('#terminalShell', 'cmd');
    await click('#terminalNewBtn'); await shown('#terminalTabs .terminal-tab');
    const command = `node -e "require('fs').writeFileSync('component-terminal-receipt.txt','${token}');console.log('COMPONENT_TERMINAL_OK')"`;
    await type('#terminalCommand', command); await click('#terminalRunBtn');
    await waitText('#terminalOutput', 'COMPONENT_TERMINAL_OK');
    await h.until(() => fs.existsSync(path.join(project, 'component-terminal-receipt.txt')), 'Independent terminal disk receipt');
    assert.equal(fs.readFileSync(path.join(project, 'component-terminal-receipt.txt'), 'utf8'), token);
    await click('#terminalInterruptBtn'); await click('#terminalStopBtn');
    await h.until(() => read("Array.from(document.querySelectorAll('#terminalTabs .terminal-tab')).every(e=>e.classList.contains('ended'))"), 'Terminal exited');
    return { command, receipt: token, output: (await text('#terminalOutput')).slice(-2000) };
  });
  await attempt('IDE opens real Monaco file with run/more menu controls', async () => {
    await ideFile('example.js');
    await click('#ideRunMenu'); await shown('#ideRunMenuPopup');
    const run = await text('#ideRunMenuPopup');
    await click('#ideRunMenu'); await click('#ideMoreMenu'); await shown('#ideMoreMenuPopup');
    const moreMenu = await text('#ideMoreMenuPopup');
    assert.ok(await visible('#ideSave'));
    await click('#ideMoreMenu');
    assert.ok((await text('#ideMonaco')).includes('COMPONENT_NODE_RUN'));
    return { run, more: moreMenu, editorPath: await text('#ideEditorPath') };
  });
  await attempt('IDE desktop typing and Save persist exact JavaScript bytes', async () => {
    await ideFile('example.js');
    const program = `console.log('COMPONENT_IDE_RUN_${token}');\nrequire('fs').writeFileSync('component-ide-receipt.txt','${token}');\n`;
    await click('#ideMonaco .monaco-editor');
    await key('#ideMonaco .monaco-editor', ['CTRL', 'A']);
    // Parent harness must type into the focused Monaco editor through the
    // DesktopAgent; this does not call Monaco.setValue or dispatch DOM events.
    await h.selectorAction('insert_text', '#ideMonaco .monaco-editor', { text: program, replace: false });
    await key('#ideMonaco .monaco-editor', ['CTRL', 'S']);
    await h.until(() => fs.readFileSync(path.join(project, 'example.js'), 'utf8').replace(/\r\n/g, '\n') === program, 'Exact Monaco disk save');
    assert.ok((await text('#ideMonaco')).includes('COMPONENT_IDE_RUN_'));
    return { file: 'example.js', bytes: Buffer.byteLength(program), disk: fs.readFileSync(path.join(project, 'example.js'), 'utf8') };
  });
  await attempt('IDE Run confirmation executes saved JavaScript and records disk output', async () => {
    await ideFile('example.js'); await click('#ideRunFile');
    await shown('dialog.iexa-app-dialog[open]');
    const confirmation = await text('dialog.iexa-app-dialog[open]');
    const confirmedDirectory = confirmation.match(/工作目录：[ \t]*([^\r\n]+)/)?.[1]?.trim();
    assert.ok(confirmedDirectory, 'Run confirmation exposes actual working directory');
    const canonical = directory => fs.realpathSync.native(directory).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    assert.equal(canonical(confirmedDirectory), canonical(project), 'Confirmed working directory resolves to the owned project');
    await click('dialog.iexa-app-dialog[open] .btn-primary');
    await waitText('#ideTaskOutput', 'COMPONENT_IDE_RUN_' + token, 22000);
    await h.until(() => fs.existsSync(path.join(project, 'component-ide-receipt.txt')), 'IDE disk receipt');
    assert.equal(fs.readFileSync(path.join(project, 'component-ide-receipt.txt'), 'utf8'), token);
    const status = await text('#ideTaskStatus'); assert.ok(status.includes('0'));
    await h.screenshot('workbench-ide-execution');
    if (await visible('#ideTaskStop')) await click('#ideTaskStop');
    return { confirmation, status, receipt: token };
  });
  await attempt('IDE expand, code search, Problems and output tabs remain interactive', async () => {
    await ideFile('example.js'); await click('#ideExpand');
    assert.equal(await read("document.getElementById('ideExpand').getAttribute('aria-expanded')"), 'true');
    await more('ideFind'); await shown('#ideMonaco .find-widget');
    await key('#ideMonaco .monaco-editor', 'ESC');
    await click('#ideErrorsTab');
    const problems = await text('#ideLogs');
    await click('#ideLogTab');
    await click('#ideLogsClear');
    await click('#ideExpand');
    assert.equal(await read("document.getElementById('ideExpand').getAttribute('aria-expanded')"), 'false');
    return { problems: problems.slice(0, 1000), collapsed: true };
  });
  await attempt('IDE static preview starts from real saved index and Stop releases server', async () => {
    await ideFile('index.html'); await more('ideRun');
    await h.until(() => read("document.getElementById('ideServerStatus')?.dataset.state==='running'"), 'Static preview running', 16000);
    const url = await value('#idePreviewURL');
    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    const loaded = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const response = { status: loaded.status, text: await loaded.text() };
    assert.equal(response.status, 200); assert.ok(response.text.includes('COMPONENT_PREVIEW_RECEIPT'));
    await click('#ideViewPreview'); await shown('#idePreviewViewport');
    await more('ideStop');
    await h.until(() => read("document.getElementById('ideServerStatus')?.dataset.state==='stopped'"), 'Static preview stopped');
    await click('#ideViewCode');
    return { url, httpStatus: response.status, marker: 'COMPONENT_PREVIEW_RECEIPT' };
  });
  await conversation();
  await h.screenshot('workbench-final');
  return { sessionId, title: token, checks: h.report.checks.filter(c => c.name.startsWith('Workbench / ')).length };
}

module.exports = { runWorkbench };
