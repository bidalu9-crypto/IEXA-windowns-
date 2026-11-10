'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/services/IDEChanges.js'), 'utf8');
function fixture(t, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="idePanel"><button id="open">Changes</button><div id="ideTree"><button data-path="src" data-directory="true"></button><button data-path="src/app.js"></button><button data-path="new.js"></button></div><div id="ideEditorTabs"><div data-path="src/app.js"></div></div></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window, before = 'user existing edit\nold one\nunchanged middle\nold two\n', after = 'user existing edit\nAI one\nunchanged middle\nAI two\n';
  const project = { id: 'a', name: 'Project', activePath: 'src/app.js' }, disks = new Map([['src/app.js', { path: 'src/app.js', content: after, revision: 'r1' }]]), writes = [], calls = [], messages = [], overlay = [], decorations = [], positions = [];
  const model = { value: after, getValue() { return this.value; }, setValue(value) { this.value = value; }, deltaDecorations(old, next) { decorations.push(next); return next.map((_, i) => 'd' + i); }, getLanguageId: () => 'javascript', isDisposed: () => false };
  const file = { path: 'src/app.js', content: after, revision: 'r1', dirty: false, conflict: null, model }, files = new Map([[file.path, file]]);
  const editor = { getModel: () => model, getPosition: () => ({ lineNumber: positions.at(-1) || 1 }), revealLineInCenter(line) { positions.push(line); }, setPosition() {} };
  const gitState = { available: true, repository: true, branch: 'main', files: [{ path: 'src/app.js', index: 'M', workTree: 'M', status: 'M', staged: true }, { path: 'new.js', index: '?', workTree: '?', status: 'U', untracked: true }] };
  const bridge = {
    async gitStatus(input) { calls.push(['gitStatus', input]); return options.status || gitState; },
    async gitDiff(input) { calls.push(['gitDiff', input]); if (options.gitError) throw Error('not repository'); return { path: input.path, original: { exists: true, content: before }, modified: { exists: true, content: disks.get(input.path)?.content || '', revision: disks.get(input.path)?.revision } }; },
    async read(input) { calls.push(['read', input]); const disk = disks.get(input.path); if (!disk) { const error = Error('ENOENT'); error.code = 'ENOENT'; throw error; } return { ...disk }; },
    async write(input) { calls.push(['write', input]); const disk = disks.get(input.path); if (input.revision !== disk.revision) throw Error('IDE_CONFLICT'); if (options.pendingWrite) await options.pendingWrite; writes.push(input); const result = { ...disk, content: input.content, revision: 'r' + (writes.length + 1) }; disks.set(input.path, result); return result; },
  };
  const notifications = [], models = [], diffEditors = [];
  const monaco = options.monaco ? { editor: {
    createModel(content) { const value = { content, setValue(text) { this.content = text; }, dispose() { this.disposed = true; } }; models.push(value); return value; },
    createDiffEditor(_el, opts) { const diff = { options: opts, setModel(value) { this.model = value; }, dispose() { this.disposed = true; }, getModifiedEditor: () => editor }; diffEditors.push(diff); return diff; },
  } } : null;
  w.eval(source);
  const hooks = { project: () => project, files: () => files, editor: () => editor, monaco: () => monaco, bridge: () => bridge, overlayChanged: value => overlay.push(value), hideNative: async () => calls.push(['hideNative']), message: (text, error) => messages.push({ text, error }), syncFile: async (name, _id, result) => { const disk = disks.get(name); if (!file.dirty && disk) { model.value = disk.content; file.content = disk.content; file.revision = disk.revision; } else if (file.dirty) file.conflict = true; }, onReviewChange: (record, change) => notifications.push({ record, change }), ...options.hooks };
  const api = w.IexaIDEChanges.create(hooks);
  t.after(() => { api.destroy(); w.close(); });
  const addReview = extra => api.applyReviewRecord({ id: 'review-1', workspaceId: 'a', path: 'src/app.js', before, after, revision: 'r1', beforeExists: true, ...extra });
  return { w, api, before, after, project, file, files, model, disks, writes, calls, messages, overlay, decorations, positions, gitState, addReview, notifications, models, diffEditors, bridge };
}
test('bounded line diff reconstructs multiple additions, deletions, CRLF and terminal newline changes', t => {
  const f = fixture(t), diff = f.w.IexaIDEChanges.diffHunks;
  const pairs = [['a\nb\nc\nd\n', 'a\nB\nc\nD\n'], ['', 'new\n'], ['gone\n', ''], ['a\r\nb\r\n', 'a\r\nx\r\nb\r\n'], ['a\n', 'a'], ['a\na\na\n', 'a\nb\na\n']];
  let seed = 197; const random = n => { seed = (seed * 48271) % 2147483647; return seed % n; };
  for (let i = 0; i < 100; i++) { const a = Array.from({ length: random(12) }, () => String(random(4)) + '\n'), b = [...a]; b.splice(random(b.length + 1), random(3), ...Array.from({ length: random(3) }, () => 'x' + random(4) + '\n')); pairs.push([a.join(''), b.join('')]); }
  for (const [before, after] of pairs) {
    const hunks = diff(before, after), original = before.match(/[^\n]*\n|[^\n]+$/g) || []; let result = '', cursor = 0;
    for (const hunk of hunks) { result += original.slice(cursor, hunk.oldStart - 1).join('') + hunk.newLines.join(''); cursor = hunk.oldStart - 1 + hunk.oldCount; }
    result += original.slice(cursor).join(''); assert.equal(result, after, JSON.stringify({ before, after, hunks }));
  }
});
test('real porcelain status decorates file tree, parent folders and editor tabs with independent AI badges', async t => {
  const f = fixture(t); f.addReview(); await f.api.refresh(); const d = f.w.document;
  assert.equal(d.querySelector('#ideTree [data-path="src/app.js"] .ide-git-badge').textContent, 'M·');
  assert.equal(d.querySelector('#ideTree [data-path="new.js"] .ide-git-badge').textContent, 'U');
  assert.equal(d.querySelector('#ideTree [data-path="src"] .ide-git-badge').textContent, '●·');
  assert.equal(d.querySelector('#ideEditorTabs [data-path="src/app.js"] .ide-ai-review-badge').textContent, 'AI');
  assert.equal(f.api.snapshot().git.branch, 'main'); assert.equal(f.decorations.at(-1).filter(item => item.options.linesDecorationsClassName.includes('ide-change-ai')).length, 2);
  f.api.decorate(); assert.equal(d.querySelectorAll('#ideEditorTabs .ide-git-badge').length, 1, 'redraw never duplicates badges');
});
test('Git diff uses native Monaco read-only models, supports rename/deletion/HEAD and restores preview/focus on Escape', async t => {
  const f = fixture(t, { monaco: true }); f.gitState.files = [{ path: 'src/app.js', originalPath: 'old.js', index: 'R', workTree: ' ', status: 'R', staged: true }];
  await f.api.refresh(); assert.ok(f.calls.some(([name, input]) => name === 'gitDiff' && input.ref === 'HEAD'), 'staged-only changes decorate against HEAD');
  const trigger = f.w.document.getElementById('open'); trigger.focus(); await f.api.showChanges();
  assert.match(f.w.document.querySelector('.ide-changes-file').textContent, /old.js → src\/app.js/);
  await f.api.showDiff('src/app.js', 'git', { ref: 'HEAD' }); assert.equal(f.diffEditors[0].options.readOnly, true); assert.equal(f.diffEditors[0].model.original.content, f.before);
  await f.api.navigate(); assert.equal(f.positions.at(-1), 2); await f.api.navigate(); assert.equal(f.positions.at(-1), 4);
  f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(f.api.isOpen(), false); assert.equal(f.diffEditors[0].disposed, true); assert.ok(f.models.every(model => model.disposed)); assert.equal(f.overlay.at(-1), false);
});
test('accepting one AI block only records review; rejecting another preserves the user preexisting edit and accepted block', async t => {
  const f = fixture(t); const record = f.addReview(); assert.equal(record.hunks.length, 2);
  await f.api.review(record.id, 'h1', 'accept'); assert.equal(f.writes.length, 0, 'accept never stages, commits or rewrites disk');
  assert.equal(f.notifications[0].change.baseline, 'user existing edit\nAI one\nunchanged middle\nold two\n');
  await f.api.review(record.id, 'h2', 'reject');
  assert.equal(f.disks.get('src/app.js').content, 'user existing edit\nAI one\nunchanged middle\nold two\n');
  assert.equal(f.writes[0].revision, 'r1'); assert.equal(f.notifications[1].change.complete, true); assert.equal(f.api.snapshot().reviews[0].currentRevision, 'r2');
  assert.deepEqual(f.calls.filter(([name]) => /stage|commit|reset/.test(name)), []);
});
test('dirty or externally changed files block accept and reject without touching the disk', async t => {
  const f = fixture(t); f.addReview(); f.file.dirty = true; f.model.value += 'user typing\n';
  await assert.rejects(f.api.review('review-1', 'h1', 'reject'), /保存|Save/); assert.equal(f.writes.length, 0);
  f.file.dirty = false; f.model.value = f.after; f.disks.get('src/app.js').revision = 'external';
  await assert.rejects(f.api.review('review-1', 'h1', 'accept'), /再次更改|changed again/); assert.equal(f.notifications.length, 0); assert.equal(f.api.snapshot().reviews[0].hunks[0].decision, 'pending');
});
test('typing while a rejected block is saved keeps the newer buffer and reports normal external conflict', async t => {
  let resolve; const pending = new Promise(done => { resolve = done; }); const f = fixture(t, { pendingWrite: pending }); f.addReview();
  const task = f.api.review('review-1', 'h1', 'reject');
  await new Promise(done => setImmediate(done)); f.file.dirty = true; f.model.value += 'new user draft\n'; resolve(); await task;
  assert.match(f.model.value, /new user draft/); assert.equal(f.file.conflict, true); assert.match(f.disks.get('src/app.js').content, /old one/);
});
test('AI creation/deletion uses the atomic host decision with complete/remove flags', async t => {
  const requests = [], f = fixture(t, { hooks: { applyReviewDecision: async (_record, request) => { requests.push(request); return { revision: 'gone', removed: true, record: null }; }, syncFile: async () => {} } });
  f.files.delete('src/app.js'); f.addReview({ before: '', after: f.after, beforeExists: false });
  await f.api.reviewAll('reject'); assert.equal(requests.length, 1); assert.equal(requests[0].remove, true); assert.equal(requests[0].complete, true); assert.equal(requests[0].content, ''); assert.equal(f.writes.length, 0);
});
test('review popover shows per-block and all controls, localizes plain text and keeps file HTML inert', async t => {
  const f = fixture(t); f.addReview(); await f.api.showDiff('src/app.js', 'ai'); const d = f.w.document;
  assert.equal(d.querySelectorAll('.ide-review-hunk').length, 2); assert.equal(d.querySelectorAll('[data-review-action="accept"]').length, 3);
  assert.match(d.getElementById('ideChangesNotice').textContent, /Git 暂存/); assert.equal(d.querySelector('#ideChangesOverlay').getAttribute('role'), 'dialog'); assert.ok(f.calls.some(([name]) => name === 'hideNative'));
  d.querySelector('.ide-review-hunk [data-review-action="accept"]').click(); await new Promise(done => setImmediate(done)); assert.equal(f.api.snapshot().reviews[0].hunks[0].decision, 'accepted');
});
test('non-repositories, unavailable Git and empty repositories have different honest states', async t => {
  for (const [status, expected] of [[{ available: true, repository: false, files: [] }, /不是 Git 仓库/], [{ available: false, repository: false, files: [] }, /暂不可用/], [{ available: true, repository: true, files: [] }, /没有 Git 更改/]]) {
    const f = fixture(t, { status }); await f.api.showChanges(); assert.match(f.w.document.querySelector('#ideChangesOverlay > p').textContent, expected);
  }
});
test('new workspace and authoritative review restoration cannot mix another project status or stale records', async t => {
  const f = fixture(t); f.addReview(); await f.api.refresh(); f.project.id = 'b'; f.api.decorate(); assert.equal(f.w.document.querySelectorAll('.ide-ai-review-badge').length, 0); assert.equal(f.api.snapshot().reviews.length, 0);
  f.project.id = 'a'; f.api.setReviewRecords([], 'a'); assert.equal(f.api.snapshot().reviews.length, 0); assert.equal(f.w.document.querySelectorAll('.ide-ai-review-badge').length, 0);
});
test('review-all follows host baseline rebasing and new hunk IDs without skipping pending edits', async t => {
  let f; const requests = [];
  f = fixture(t, { hooks: { applyReviewDecision: async (record, request) => {
    requests.push(request);
    const next = { ...record, before: request.baseline, after: request.content, decisions: undefined };
    f.api.applyReviewRecord(next);
    return { revision: record.revision, record: next };
  } } });
  f.addReview(); assert.equal(await f.api.reviewAll('accept'), 2); assert.equal(requests.length, 2);
  assert.equal(f.api.snapshot().reviews[0].hunks.filter(hunk => hunk.decision === 'pending').length, 0);
  assert.equal(f.writes.length, 0); assert.equal(f.disks.get('src/app.js').content, f.after);
});
test('rejecting the last edit before an AI deletion restores content with a missing-file revision through host CAS', async t => {
  let request; const f = fixture(t, { hooks: { applyReviewDecision: async (_record, next) => { request = next; return { revision: 'restored' }; }, syncFile: async () => {} } });
  f.files.clear(); f.disks.delete('src/app.js');
  f.addReview({ after: '', afterExists: false, revision: 'missing' });
  await f.api.reviewAll('reject'); assert.equal(request.exists, true); assert.equal(request.remove, false); assert.equal(request.content, f.before); assert.equal(request.revision, 'missing');
});
test('Git-only diff exposes no AI accept controls and conflict, deletion, rename statuses stay distinct', async t => {
  const f = fixture(t); f.gitState.files = [{ path: 'src/app.js', index: 'U', workTree: 'U', conflict: true }, { path: 'gone.js', index: ' ', workTree: 'D', status: 'D' }, { path: 'new.js', originalPath: 'old.js', index: 'R', workTree: ' ', status: 'R', staged: true }];
  await f.api.refresh(); assert.equal(f.w.document.querySelector('#ideTree [data-path="src/app.js"] .ide-git-badge').textContent, '!');
  await f.api.showChanges(); assert.match(f.w.document.querySelector('.ide-changes-file[title*="old.js"]').textContent, /old.js → new.js/);
  await f.api.showDiff('gone.js'); assert.equal(f.w.document.querySelectorAll('[data-review-action]').length, 0);
});
test('editor inline review widgets are added, act on one block and are disposed with their old model', async t => {
  const f = fixture(t), inline = [], removed = [];
  const editor = { getModel: () => f.model, addContentWidget: widget => inline.push(widget), removeContentWidget: widget => removed.push(widget) };
  f.api.destroy(); const api = f.w.IexaIDEChanges.create({ project: () => f.project, files: () => f.files, editor: () => editor, bridge: () => f.bridge, syncFile: async () => {} });
  t.after(() => api.destroy()); api.applyReviewRecord({ id: 'r', workspaceId: 'a', path: 'src/app.js', before: f.before, after: f.after, revision: 'r1' }); await api.updateDecorations();
  assert.equal(inline.at(-1).getPosition().position.lineNumber, 4); assert.equal(inline.at(-1).getDomNode().querySelectorAll('button').length, 3);
  inline.at(-1).getDomNode().querySelector('button').click(); await new Promise(done => setImmediate(done)); assert.equal(api.snapshot().reviews[0].hunks[1].decision, 'accepted');
  api.destroy(); assert.ok(removed.length >= inline.length);
});
test('ignored entries are excluded, and rapid typing updates cached decorations without Git IPC per keystroke', async t => {
  const f = fixture(t); f.gitState.files.push({ path: 'secret.log', index: '!', workTree: '!', status: '!', ignored: true });
  await f.api.refresh(); const count = f.calls.filter(([name]) => name === 'gitDiff').length;
  assert.equal(f.api.snapshot().git.files.some(entry => entry.ignored), false);
  for (let i = 0; i < 20; i++) { f.model.value = f.after + '// typed ' + i + '\n'; f.file.dirty = true; f.api.onModelChange(); }
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(f.calls.filter(([name]) => name === 'gitDiff').length, count, 'model debounce only uses the cached original');
  assert.ok(f.decorations.at(-1).some(item => item.range.startLineNumber <= 5 && item.range.endLineNumber >= 5), 'the newly typed line gets a Git gutter mark');
});
test('late diff responses and preview hide completion never reopen or crash a closed review', async t => {
  let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(t);
  const prior = f.bridge.gitDiff; f.bridge.gitDiff = async input => { await pending; return prior(input); };
  const task = f.api.showDiff('src/app.js'); f.api.closeDiff(); resolve(); await task; assert.equal(f.api.isOpen(), false);
  let resume; const wait = new Promise(done => { resume = done; }); f.api.destroy();
  const api = f.w.IexaIDEChanges.create({ project: () => f.project, files: () => f.files, bridge: () => f.bridge, hideNative: () => wait }); t.after(() => api.destroy());
  const opening = api.showDiff('src/app.js'); await new Promise(done => setImmediate(done)); api.closeDiff(); resume(); await opening; assert.equal(api.isOpen(), false);
});
