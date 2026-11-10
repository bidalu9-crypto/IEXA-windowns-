'use strict';

// Product CRUD is driven only through the production DesktopAgent controls.
// Direct filesystem writes below prepare unique initial inputs before checks;
// DOM/GET/filesystem reads are independent result oracles, never mutation paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function runCrud(h) {
  const q = JSON.stringify;
  const fixture = fs.realpathSync.native(h.report.fixture.root || h.fixture);
  const project = fs.realpathSync.native(h.report.fixture.project);
  const token = String(h.report.runId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
  assert.ok(token.length >= 8, 'Unique owned CRUD run token');
  const projectRelative = path.relative(fixture, project);
  assert.ok(projectRelative && !projectRelative.startsWith('..') && !path.isAbsolute(projectRelative), 'CRUD project is inside this harness fixture');
  const prefix = 'component-crud-' + token;
  const names = {
    filesFile: prefix + '-files.txt', filesDirectory: prefix + '-files-dir',
    created: prefix + '-created', cancelled: prefix + '-cancelled.txt',
    rename: prefix + '-rename', renamed: prefix + '-renamed',
    remove: prefix + '-remove',
  };
  const receipt = 'COMPONENT_CRUD_DISK_RECEIPT ' + h.report.runId + '\n';
  function owned(relative) {
    assert.ok(typeof relative === 'string' && relative.split('/')[0].startsWith(prefix), 'Only this CRUD fixture entry may change: ' + relative);
    const absolute = path.resolve(project, relative);
    const inside = path.relative(project, absolute);
    assert.ok(inside && inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside), 'CRUD target stays inside owned project');
    return absolute;
  }
  const baseline = [];
  function inputFile(relative) {
    const absolute = owned(relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, receipt, { flag: 'wx' });
    baseline.push({ relative, sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'), bytes: Buffer.byteLength(receipt) });
  }
  // Initial data is deliberately separate for each independent scenario.
  inputFile(names.filesFile);
  inputFile(names.filesDirectory + '/nested/receipt.txt');
  inputFile(names.rename + '/original.txt');
  inputFile(names.remove + '/delete.txt');
  inputFile(names.remove + '/nested/retained.txt');
  assert.equal(fs.existsSync(owned(names.created)), false);
  assert.equal(fs.existsSync(owned(names.renamed)), false);
  h.report.crudCoverage = {
    fixtureProject: project, baseline,
    mutationRoute: 'Only h click/type/key/selectorAction product UI; fs writes prepared initial inputs before checks.',
    unavailableFeatures: [
      { surface: 'Files context menu', feature: 'Create file/folder', covered: false, reason: 'Current actual product menu only exposes delete/copy/copy-path.', evidence: ['src/renderer/index.html:581', 'src/renderer/services/FilesPanel.js:737'] },
      { surface: 'Files context menu', feature: 'Rename file/folder', covered: false, reason: 'No Files rename control or handler exists; actual create/rename coverage belongs to IDE.', evidence: ['src/renderer/index.html:581', 'src/renderer/services/FilesPanel.js:737'] },
    ],
    boundaries: ['No GUI or Node execution is implied by this source module existing.', 'Incomplete or failed checks remain failed in report.checks; no direct API mutation substitutes for product actions.'],
  };
  h.save();

  const read = expression => h.read(expression);
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const exists = selector => read(`!!document.querySelector(${q(selector)})`);
  const text = selector => read(`document.querySelector(${q(selector)})?.textContent || ''`);
  const shown = selector => h.until(() => visible(selector), 'Actual CRUD control visible: ' + selector, 14000);
  const gone = selector => h.until(async () => !(await visible(selector)), 'Actual CRUD control closed: ' + selector, 12000);
  const click = selector => h.clickSelector(selector);
  const type = (selector, value) => h.typeSelector(selector, value);
  const key = (selector, keys) => h.keySelector(selector, keys);
  const get = route => read(`fetch(${q(route)},{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw Error('GET '+r.status+' '+JSON.stringify(d));return d})`);
  const sessions = () => get('/api/sessions');
  const activeId = () => read("document.querySelector('.session-item.active')?.dataset.id || ''");
  const filesRow = relative => '#filesList .files-item[data-path=' + q(relative) + ']';
  const treeRow = relative => '#ideTree .ide-tree-row[data-path=' + q(relative) + ']';
  const tab = relative => '#ideEditorTabs .ide-editor-tab[data-path=' + q(relative) + ']';
  const list = relative => get('/api/fs/list?path=' + encodeURIComponent(relative || '.'));
  const normalized = value => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  async function assertProject() {
    const actual = await get('/api/project');
    assert.equal(normalized(actual.root || actual.project?.root || ''), normalized(project), 'Actual product route is the owned CRUD project');
  }
  async function confirm(accept) {
    const dialog = 'dialog.iexa-app-dialog[open]';
    await shown(dialog);
    await click(dialog + (accept ? ' .btn-primary' : ' .iexa-app-dialog-actions button:not(.btn-primary)'));
    await gone(dialog);
  }
  async function prompt(value, accept = true) {
    await shown('dialog.iexa-app-dialog[open] input');
    await type('dialog.iexa-app-dialog[open] input', value);
    await confirm(accept);
  }
  async function conversation() {
    await h.nav('chat');
    if (await visible('[data-chat-view="conversation"]')) await click('[data-chat-view="conversation"]');
    await shown('#chatInput');
    await h.until(async () => !(await visible('#stopBtn')) && await visible('#sendBtn'), 'CRUD starts with idle conversation', 20000);
  }
  async function projectSession() {
    await conversation();
    const target = h.report.fixture.sid;
    assert.ok((await sessions()).sessions.some(session => session.id === target), 'Owned seeded project session still exists');
    if (await activeId() !== target) {
      const row = '.session-item[data-id=' + q(target) + '] [data-ui-action="switchSession"]';
      await shown(row); await click(row);
      await h.until(async () => await activeId() === target, 'Owned project session selected');
    }
    await h.until(async () => {
      const state = await get('/api/project');
      return normalized(state.root || state.project?.root || '') === normalized(project);
    }, 'Owned project activation settled');
    await assertProject();
  }
  async function files() {
    await projectSession(); await click('[data-workbench-view="files"]'); await shown('#filesList');
    if (await visible('#filesCrumb button[data-path="."]')) await click('#filesCrumb button[data-path="."]');
    await click('#filesRefreshBtn');
    await h.until(async () => (await list('.')).root && (await text('#filesPath')).trim() && !(await visible('#filesList .files-empty')), 'Actual Files root refreshed');
  }
  async function showTree() {
    await shown('#idePanel');
    if (!(await visible('#ideTree'))) { await shown('#ideViewFiles'); await click('#ideViewFiles'); }
    await shown('#ideTree');
  }
  async function ide() {
    await projectSession(); await click('[data-workbench-view="ide"]'); await shown('#idePanel');
    await showTree();
    if (await read("document.querySelector('#ideFileSearch')?.value || ''")) await type('#ideFileSearch', '');
    await click('#ideRefresh');
  }
  async function tree(relative) {
    owned(relative); await showTree();
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      const row = treeRow(parent); await shown(row);
      if (await read(`document.querySelector(${q(row)}).getAttribute('aria-expanded')==='false'`)) await click(row);
    }
    const selector = treeRow(relative); await shown(selector); return selector;
  }
  async function editorTab(relative) {
    // The real Files button switches a narrow workbench to explorer-only mode.
    // Switch back through the Code control before requiring a visible tab.
    await shown('#ideViewCode'); await click('#ideViewCode');
    await shown('#ideMonaco .monaco-editor');
    await h.until(async () => (await text('#ideEditorPath')).trim() === relative && await exists(tab(relative)), 'Owned IDE editor and tab identity: ' + relative);
    await shown(tab(relative));
  }
  async function ideContext(relative, action) {
    owned(relative); await assertProject(); const row = await tree(relative);
    await h.selectorAction('click', row, { button: 'right' });
    const item = '#ideContextMenu [data-ide-label=' + q(action) + ']';
    await shown(item); await click(item);
  }
  async function writeEditor(relative, content) {
    owned(relative); await shown('#ideMonaco .monaco-editor');
    await h.until(async () => (await text('#ideEditorPath')).trim() === relative, 'Actual Monaco opens the owned created file');
    await click('#ideMonaco .monaco-editor');
    await key('#ideMonaco .monaco-editor', ['CTRL', 'A']);
    await h.selectorAction('insert_text', '#ideMonaco .monaco-editor', { text: content, replace: false });
    await key('#ideMonaco .monaco-editor', ['CTRL', 'S']);
    await h.until(() => fs.existsSync(owned(relative)) && fs.readFileSync(owned(relative), 'utf8').replace(/\r\n/g, '\n') === content, 'Actual Monaco saves exact CRUD bytes');
  }
  async function recovery(name) {
    try {
      if (await visible('dialog.iexa-app-dialog[open] .iexa-app-dialog-actions button:not(.btn-primary)')) await confirm(false);
      else if (await visible('dialog.iexa-app-dialog[open] .btn-primary')) await confirm(true);
      if (await visible('#ideContextMenu')) await key('#ideContextMenu button', 'ESC');
      if (await visible('#filesContextMenu')) await click('[data-workbench-view="files"]');
    } catch (error) { (h.report.crudRecoveryErrors ||= []).push({ after: name, error: error.message }); h.save(); }
  }
  async function check(name, fn) { await h.check('CRUD / ' + name, fn); await recovery(name); }

  await check('session deletion cancellation preserves and confirmation removes the owned session', async () => {
    await projectSession();
    const before = new Set((await sessions()).sessions.map(session => session.id));
    await click('#newSessionBtn');
    const id = await h.until(async () => { const current = await activeId(); return current && !before.has(current) && current; }, 'New isolated session created for deletion');
    assert.notEqual(id, h.report.fixture.sid);
    const row = '.session-item[data-id=' + q(id) + ']';
    const openDelete = async () => { await click(row + ' .session-item-more'); await shown('.session-menu [data-ui-action="deleteSession"]'); await click('.session-menu [data-ui-action="deleteSession"]'); };
    const original = (await get('/api/sessions/' + encodeURIComponent(id))).messages;
    await openDelete(); await confirm(false);
    assert.ok((await sessions()).sessions.some(session => session.id === id));
    assert.deepEqual((await get('/api/sessions/' + encodeURIComponent(id))).messages, original);
    await shown(row); assert.equal(await activeId(), id);
    await openDelete(); await confirm(true);
    await h.until(async () => !(await sessions()).sessions.some(session => session.id === id), 'Deleted session absent from persisted index');
    await h.until(async () => !(await exists(row)), 'Deleted session row removed');
    const detailStatus = await read(`fetch(${q('/api/sessions/' + encodeURIComponent(id))},{cache:'no-store'}).then(r=>r.status)`);
    assert.equal(detailStatus, 404);
    const replacement = await h.until(async () => {
      const selected = await activeId();
      return selected && selected !== id && (await sessions()).sessions.some(session => session.id === selected) && selected;
    }, 'Actual UI selects an existing replacement session');
    await projectSession(); await h.screenshot('crud-session-deleted');
    return { createdSession: id, cancelledDeletePreserved: true, confirmedDelete: true, detailStatus, replacement, restoredProjectSession: h.report.fixture.sid };
  });

  await check('Files actual context actions and file delete cancel/confirm match disk', async () => {
    await files(); const relative = names.filesFile, absolute = owned(relative), row = filesRow(relative);
    await shown(row); await h.selectorAction('click', row, { button: 'right' }); await shown('#filesContextMenu');
    const actions = await read("Array.from(document.querySelectorAll('#filesContextMenu [data-action]')).map(e=>e.dataset.action)");
    for (const action of ['delete', 'copy', 'copy-path']) assert.ok(actions.includes(action));
    await click('#filesContextMenu [data-action="delete"]'); await confirm(false);
    assert.equal(fs.readFileSync(absolute, 'utf8'), receipt);
    assert.ok((await list('.')).entries.some(entry => entry.path === relative)); await shown(row);
    await h.selectorAction('click', row, { button: 'right' }); await click('#filesContextMenu [data-action="delete"]'); await confirm(true);
    await h.until(() => !fs.existsSync(absolute), 'Files confirmation deletes actual fixture file');
    await h.until(async () => !(await list('.')).entries.some(entry => entry.path === relative) && !(await exists(row)), 'Deleted file absent from GET and visible list');
    return { file: relative, actualActions: actions, cancellationPreservedExactBytes: true, deleted: true, createAndRenameInFiles: 'No product controls; recorded uncovered in crudCoverage.unavailableFeatures.' };
  });

  await check('Files directory navigation breadcrumbs and recursive delete preserve cancellation', async () => {
    await files(); const directory = names.filesDirectory, nestedFile = directory + '/nested/receipt.txt';
    await shown(filesRow(directory)); await click(filesRow(directory));
    await shown(filesRow(directory + '/nested')); await click(filesRow(directory + '/nested'));
    await shown(filesRow(nestedFile));
    assert.ok((await list(directory + '/nested')).entries.some(entry => entry.path === nestedFile));
    await shown('#filesCrumb button[data-path="."]'); await click('#filesCrumb button[data-path="."]');
    await shown(filesRow(directory));
    await h.selectorAction('click', filesRow(directory), { button: 'right' }); await click('#filesContextMenu [data-action="delete"]'); await confirm(false);
    assert.equal(fs.readFileSync(owned(nestedFile), 'utf8'), receipt);
    await h.selectorAction('click', filesRow(directory), { button: 'right' }); await click('#filesContextMenu [data-action="delete"]'); await confirm(true);
    await h.until(() => !fs.existsSync(owned(directory)), 'Files recursive directory deletion removes nested disk receipt');
    await h.until(async () => !(await list('.')).entries.some(entry => entry.path === directory) && !(await exists(filesRow(directory))), 'Removed directory absent from GET and Files list');
    return { directory, navigatedNestedFile: nestedFile, rootBreadcrumb: true, cancellationPreservedNestedBytes: true, recursivelyDeleted: true };
  });

  await check('IDE creates directory and file through actual toolbar/context then saves exact bytes', async () => {
    await ide();
    await shown('#ideNewFile'); await click('#ideNewFile'); await prompt(names.cancelled, false);
    assert.equal(fs.existsSync(owned(names.cancelled)), false);
    assert.equal(await exists(treeRow(names.cancelled)), false);
    await click('#ideNewFolder'); await prompt(names.created);
    await h.until(() => fs.existsSync(owned(names.created)) && fs.statSync(owned(names.created)).isDirectory(), 'Actual IDE directory created');
    await shown(treeRow(names.created));
    const file = names.created + '/created.txt';
    await ideContext(names.created, 'file'); await prompt(file);
    await h.until(() => fs.existsSync(owned(file)), 'Actual IDE file created');
    await shown('#ideMonaco');
    const contents = 'COMPONENT_CRUD_UI_CREATED ' + h.report.runId + '\n';
    await writeEditor(file, contents);
    assert.ok((await list(names.created)).entries.some(entry => entry.path === file));
    await tree(file); await editorTab(file);
    await h.screenshot('crud-ide-created-saved');
    return { cancelledPath: names.cancelled, cancelledCreatePreservedAbsence: true, createdDirectory: names.created, createdFile: file, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(fs.readFileSync(owned(file))).digest('hex') };
  });

  await check('IDE file and parent directory rename retain bytes and open editor identity', async () => {
    await ide(); const original = names.rename + '/original.txt', renamedFile = names.rename + '/renamed.txt';
    await click(await tree(original)); await editorTab(original);
    assert.equal(fs.readFileSync(owned(original), 'utf8'), receipt);
    await ideContext(original, 'rename'); await prompt(renamedFile, false);
    assert.equal(fs.readFileSync(owned(original), 'utf8'), receipt); assert.equal(fs.existsSync(owned(renamedFile)), false);
    await ideContext(original, 'rename'); await prompt(renamedFile);
    await h.until(() => !fs.existsSync(owned(original)) && fs.existsSync(owned(renamedFile)), 'IDE file rename changes actual paths');
    assert.equal(fs.readFileSync(owned(renamedFile), 'utf8'), receipt);
    await h.until(async () => (await text('#ideEditorPath')).trim() === renamedFile && await exists(tab(renamedFile)) && !(await exists(tab(original))), 'Opened editor and tab follow file rename');
    await ideContext(names.rename, 'rename'); await prompt(names.renamed);
    const moved = names.renamed + '/renamed.txt';
    await h.until(() => !fs.existsSync(owned(names.rename)) && fs.existsSync(owned(moved)), 'IDE parent rename changes nested disk paths');
    assert.equal(fs.readFileSync(owned(moved), 'utf8'), receipt);
    await h.until(async () => (await text('#ideEditorPath')).trim() === moved && await exists(tab(moved)) && !(await exists(tab(renamedFile))), 'Opened child editor and tab follow directory rename');
    const directory = await tree(names.renamed);
    if (await read(`document.querySelector(${q(directory)}).getAttribute('aria-expanded')==='false'`)) await click(directory);
    await shown(treeRow(moved));
    await click(directory); await h.until(async () => !(await exists(treeRow(moved))), 'Collapsed directory removes child row');
    await click(directory); await shown(treeRow(moved));
    assert.ok((await list(names.renamed)).entries.some(entry => entry.path === moved));
    await h.screenshot('crud-ide-renamed');
    return { original, renamedFile, renamedDirectory: names.renamed, movedChild: moved, originalBytesPreserved: true, tabPathsUpdated: true, expandedCollapsedExpanded: true };
  });

  await check('IDE delete cancel/confirm removes opened file and populated directory from tree tabs and disk', async () => {
    await ide(); const file = names.remove + '/delete.txt', nested = names.remove + '/nested/retained.txt';
    await click(await tree(file)); await editorTab(file);
    await ideContext(file, 'remove'); await confirm(false);
    assert.equal(fs.readFileSync(owned(file), 'utf8'), receipt); await editorTab(file); await tree(file);
    await ideContext(file, 'remove'); await confirm(true);
    await h.until(() => !fs.existsSync(owned(file)), 'IDE remove deletes the actual open file');
    await h.until(async () => !(await exists(tab(file))) && !(await exists(treeRow(file))), 'Deleted file tab and tree row removed');
    assert.ok(!(await list(names.remove)).entries.some(entry => entry.path === file));
    await click(await tree(nested)); await editorTab(nested);
    await ideContext(names.remove, 'remove'); await confirm(false);
    assert.equal(fs.readFileSync(owned(nested), 'utf8'), receipt);
    await ideContext(names.remove, 'remove'); await confirm(true);
    await h.until(() => !fs.existsSync(owned(names.remove)), 'IDE remove recursively deletes populated directory');
    await h.until(async () => !(await exists(treeRow(names.remove))) && !(await exists(tab(nested))), 'Removed directory and opened child tabs disappear');
    assert.ok(!(await list('.')).entries.some(entry => entry.path === names.remove));
    await h.screenshot('crud-ide-deleted');
    return { file, directory: names.remove, nestedFile: nested, cancellationPreservedExactBytes: true, fileAndDirectoryDeleted: true, openedTabsRemoved: true };
  });

  const checks = h.report.checks.filter(item => item.name.startsWith('CRUD / '));
  h.report.crudCoverage.results = { recordedChecks: checks.length, passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length };
  h.save();
  return h.report.crudCoverage;
}

module.exports = { runCrud };
