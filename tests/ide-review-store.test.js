'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const iconv = require('iconv-lite');
const { make, remove } = require('./helpers/temp-dir');
const { FileWorkspace } = require('../dist/main/ide/FileWorkspace');
const { IDEReviewStore } = require('../dist/main/ide/IDEReviewStore');
const { FileTools } = require('../dist/main/tools/ToolExecutors');
const { withFileLocks } = require('../dist/main/tools/FileWriteLocks');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MiB = 1024 * 1024;

function fixture(t) {
  const directory = make('iexa-review-'), root = path.join(directory, "中文 project & user's"), otherRoot = path.join(directory, 'other project');
  fs.mkdirSync(root); fs.mkdirSync(otherRoot);
  const filesState = path.join(directory, 'projects.json'), state = path.join(directory, 'reviews.json');
  const files = new FileWorkspace(filesState), project = files.authorize(root), other = files.authorize(otherRoot);
  const store = new IDEReviewStore(files, state), tools = new FileTools();
  const owned = [{ files, store }];
  t.after(async () => { for (const instance of owned) { await instance.store.dispose(); instance.files.dispose(); } remove(directory); });
  const write = (relative, content) => { const target = path.join(project.root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return fs.realpathSync.native(target); };
  const aiWrite = async (relative, content) => { const result = await tools.writeFile(relative, content, root); assert.equal(result.success, true, result.output); return result; };
  const records = () => store.list(project.id).records;
  const latest = () => { const list = records(); assert.equal(list.length, 1); return store.read(project.id, list[0].id); };
  return { directory, root: project.root, otherRoot: other.root, files, project, other, store, tools, state, filesState, write, aiWrite, records, latest, owned };
}
function code(expected) { return error => { assert.equal(error.code, expected); return true; }; }
function action(f, record, extra) { return f.store.action(f.project.id, { reviewId: record.id, revision: record.revision, ...extra }); }

test('real FileTools journal keeps full >30000-character snapshots while SSE/tool previews stay truncated', async t => {
  const f = fixture(t), before = 'before original 中文\r\n'.repeat(4500), after = 'after changed 中文\r\n'.repeat(4500);
  f.write('long.py', before);
  const result = await f.aiWrite('long.py', after), record = f.latest();
  assert.equal(result.fileChange.previewTruncated, true);
  assert.equal(result.fileChange.before.length, 30000);
  assert.equal(result.fileChange.after.length, 30000);
  assert.equal(record.before, before);
  assert.equal(record.after, after);
  assert.equal(record.revision, hash(fs.readFileSync(path.join(f.root, 'long.py'))));
  assert.equal(Object.hasOwn(f.records()[0], 'before'), false, 'list metadata does not duplicate large bodies');
  assert.equal(Object.hasOwn(f.records()[0], 'after'), false);
});

test('real write/edit tool events merge consecutive AI modifications from the first baseline through the last result', async t => {
  const f = fixture(t), before = 'alpha\nkeep\nomega\n';
  f.write('a.py', before);
  await f.aiWrite('a.py', 'ALPHA\nkeep\nomega\n');
  const first = f.latest();
  const edited = await f.tools.editFile('a.py', 'omega', 'OMEGA', f.root);
  assert.equal(edited.success, true, edited.output);
  const last = f.latest();
  assert.equal(last.id, first.id);
  assert.equal(last.createdAt, first.createdAt);
  assert.equal(last.before, before);
  assert.equal(last.after, 'ALPHA\nkeep\nOMEGA\n');
  await action(f, last, { action: 'reject', content: last.before, complete: true });
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), before);
  assert.equal(f.records().length, 0);
});

test('a user disk edit between AI changes becomes the new baseline and survives rejection', async t => {
  const f = fixture(t); f.write('a.py', 'original\n');
  await f.aiWrite('a.py', 'first AI\n');
  f.write('a.py', 'USER EDIT must stay\n');
  await f.aiWrite('a.py', 'second AI\n');
  const record = f.latest();
  assert.equal(record.before, 'USER EDIT must stay\n');
  await action(f, record, { action: 'reject', content: record.before, complete: true });
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), 'USER EDIT must stay\n');
});

test('whole-file accept retires the review without rewriting disk or creating a new journal entry', async t => {
  const f = fixture(t); f.write('a.py', 'base\n'); await f.aiWrite('a.py', 'AI\n');
  const record = f.latest(), bytes = fs.readFileSync(path.join(f.root, 'a.py'));
  const result = await action(f, record, { action: 'accept', complete: true });
  assert.equal(result.record, null);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'a.py')), bytes);
  assert.equal(f.records().length, 0);
  await assert.rejects(() => action(f, record, { action: 'reject', content: record.before, complete: true }), code('IDE_REVIEW_MISSING'));
});

test('partial hunk accept followed by rejection of the remaining hunk preserves accepted code', async t => {
  const f = fixture(t), before = 'first = 1\nunchanged = True\nlast = 1\n', after = 'first = 2\nunchanged = True\nlast = 2\n', baseline = 'first = 2\nunchanged = True\nlast = 1\n';
  f.write('a.py', before); await f.aiWrite('a.py', after);
  const accepted = await action(f, f.latest(), { action: 'accept', baseline });
  assert.ok(accepted.record);
  assert.equal(accepted.record.before, baseline);
  assert.equal(accepted.record.after, after);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), after);
  const rejected = await action(f, accepted.record, { action: 'reject', content: baseline, complete: true });
  assert.equal(rejected.record, null);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), baseline);
});

test('partial hunk reject retains the remaining review and later complete accept keeps the selected content', async t => {
  const f = fixture(t), before = 'first=1\nlast=1\n', after = 'first=2\nlast=2\n', partiallyRejected = 'first=1\nlast=2\n';
  f.write('a.py', before); await f.aiWrite('a.py', after);
  const rejected = await action(f, f.latest(), { action: 'reject', content: partiallyRejected });
  assert.ok(rejected.record);
  assert.equal(rejected.record.before, before);
  assert.equal(rejected.record.after, partiallyRejected);
  assert.equal(rejected.record.revision, f.files.read(f.project.id, 'a.py').revision);
  const accepted = await action(f, rejected.record, { action: 'accept', complete: true });
  assert.equal(accepted.record, null);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), partiallyRejected);
});

test('stale review and later user disk revisions reject CAS without modifying files or retiring the journal', async t => {
  const f = fixture(t); f.write('a.py', 'base\n'); await f.aiWrite('a.py', 'AI1\n');
  const stale = f.latest(); await f.aiWrite('a.py', 'AI2\n');
  await assert.rejects(() => action(f, stale, { action: 'reject', content: stale.before, complete: true }), code('IDE_REVIEW_CONFLICT'));
  const record = f.latest(); f.write('a.py', 'LATER USER\n');
  for (const requestedAction of ['accept', 'reject']) {
    await assert.rejects(() => action(f, record, { action: requestedAction, content: record.before, complete: true }), code('IDE_REVIEW_CONFLICT'));
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), 'LATER USER\n');
  assert.equal(f.latest().revision, record.revision);
});

test('accept CAS waits for the same file lock as a queued user write and preserves its later disk version', async t => {
  const f = fixture(t); f.write('a.py', 'base\n'); await f.aiWrite('a.py', 'AI\n'); const record = f.latest();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), locked = new Promise(resolve => { entered = resolve; });
  const held = withFileLocks([path.join(f.root, 'a.py')], async () => { entered(); await gate; });
  await locked;
  const userWrite = f.files.write(f.project.id, 'a.py', 'USER concurrent\n', record.revision);
  const acceptance = action(f, record, { action: 'accept', complete: true });
  // Attach a handler before releasing the gate; a correct implementation will
  // reject after the earlier queued write, without an unhandled rejection.
  const rejected = assert.rejects(() => acceptance, code('IDE_REVIEW_CONFLICT'));
  release();
  await held; await userWrite; await rejected;
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), 'USER concurrent\n');
  assert.equal(f.latest().revision, record.revision, 'the unresolved review stays available');
});

test('reject commits its journal change inside FileWorkspace write before a subsequent AI tool acquires the lock', async t => {
  const f = fixture(t), before = 'first=1\nlast=1\n', after = 'first=2\nlast=2\n', partial = 'first=1\nlast=2\n';
  f.write('a.py', before); await f.aiWrite('a.py', after); const record = f.latest();
  const originalWrite = f.files.write.bind(f.files);
  f.files.write = async (...args) => {
    const committed = await originalWrite(...args);
    // The real writer can acquire the just-released lock before the caller
    // resumes. A lock-internal journal callback must already reflect partial.
    await f.aiWrite('a.py', 'LATER AI\n');
    return committed;
  };
  const result = await action(f, record, { action: 'reject', content: partial });
  assert.equal(result.content, partial, 'the requested rejection committed successfully');
  const current = f.latest();
  assert.equal(current.before, before);
  assert.equal(current.after, 'LATER AI\n');
  assert.equal(current.revision, f.files.read(f.project.id, 'a.py').revision);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), 'LATER AI\n');
});

test('AI-created file rejection removes only the unchanged owned file, never existing empty files or later user edits', async t => {
  const f = fixture(t); await f.aiWrite('new.py', 'AI new\n');
  const created = f.latest(); assert.equal(created.beforeExists, false);
  const removed = await action(f, created, { action: 'reject', remove: true, complete: true });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(path.join(f.root, 'new.py')), false);
  assert.equal(f.records().length, 0);
  f.write('empty.py', ''); await f.aiWrite('empty.py', 'filled\n');
  const existing = f.latest(); assert.equal(existing.beforeExists, true);
  await assert.rejects(() => action(f, existing, { action: 'reject', remove: true, complete: true }), code('IDE_REVIEW_ACTION'));
  await action(f, existing, { action: 'reject', content: '', complete: true });
  assert.equal(fs.readFileSync(path.join(f.root, 'empty.py'), 'utf8'), '');
  await f.aiWrite('later.py', 'AI new\n'); const later = f.latest();
  f.write('later.py', 'USER keeps this\n');
  await assert.rejects(() => action(f, later, { action: 'reject', remove: true, complete: true }), code('IDE_REVIEW_CONFLICT'));
  assert.equal(fs.readFileSync(path.join(f.root, 'later.py'), 'utf8'), 'USER keeps this\n');
});

test('workspace IDs isolate review actions and unrelated or sibling-prefix roots never gain a record', async t => {
  const f = fixture(t); f.write('a.py', 'base'); await f.aiWrite('a.py', 'AI'); const record = f.latest();
  assert.deepEqual(f.store.list(f.other.id).records, []);
  assert.throws(() => f.store.read(f.other.id, record.id), code('IDE_REVIEW_MISSING'));
  await assert.rejects(() => f.store.action(f.other.id, { reviewId: record.id, revision: record.revision, action: 'accept', complete: true }), code('IDE_REVIEW_MISSING'));
  const sibling = f.root + '-unrelated'; fs.mkdirSync(sibling); const outside = path.join(sibling, 'private.py'); fs.writeFileSync(outside, 'outside');
  f.store.record(outside, 'old', 'outside', true, hash(Buffer.from('outside')));
  assert.equal(f.records().length, 1);
  assert.throws(() => f.store.list('unknown'), code('IDE_WORKSPACE'));
});

test('nested authorized project records belong to the most-specific project root', async t => {
  const f = fixture(t), nestedRoot = path.join(f.root, 'nested'); fs.mkdirSync(nestedRoot);
  const nested = f.files.authorize(nestedRoot);
  fs.writeFileSync(path.join(nestedRoot, 'a.py'), 'base');
  const result = await f.tools.writeFile('a.py', 'AI', nestedRoot); assert.equal(result.success, true);
  assert.equal(f.store.list(f.project.id).records.length, 0);
  assert.equal(f.store.list(nested.id).records.length, 1);
  assert.equal(f.store.read(nested.id, f.store.list(nested.id).records[0].id).path, 'a.py');
});

test('pending snapshots persist and restore only through still-authorized project IDs', async t => {
  const f = fixture(t); f.write('a.py', 'base\n'); await f.aiWrite('a.py', 'AI\n'); const record = f.latest();
  await f.store.dispose(); f.files.dispose();
  const restoredFiles = new FileWorkspace(f.filesState), restoredStore = new IDEReviewStore(restoredFiles, f.state); f.owned.push({ files: restoredFiles, store: restoredStore });
  const restored = restoredStore.read(f.project.id, record.id);
  assert.deepEqual(restored, record);
  await restoredStore.action(f.project.id, { reviewId: restored.id, revision: restored.revision, action: 'reject', content: restored.before, complete: true });
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), 'base\n');
  const unauthorizedFiles = new FileWorkspace(), unauthorizedStore = new IDEReviewStore(unauthorizedFiles, f.state); f.owned.push({ files: unauthorizedFiles, store: unauthorizedStore });
  const fresh = unauthorizedFiles.authorize(f.root);
  assert.deepEqual(unauthorizedStore.list(fresh.id).records, []);
});

test('UTF-8 BOM and UTF-16 original file encodings survive real AI modification and review rejection', async t => {
  const f = fixture(t);
  for (const [name, bytes] of [
    ['bom.py', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('原文\r\n')])],
    ['utf16le.py', Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('原文\r\n', 'utf16le')])],
    ['utf16be.py', Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode('原文\r\n', 'utf16be')])],
  ]) {
    f.write(name, bytes); await f.aiWrite(name, 'AI 中文\r\n'); const record = f.latest();
    assert.equal(record.before, '原文\r\n');
    await action(f, record, { action: 'reject', content: record.before, complete: true });
    assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes, name + ' byte-exact restoration');
  }
});

test('4 MiB per-side boundary is exact, over-limit changes emit a notice and preserve disk data', t => {
  const f = fixture(t), events = []; f.store.on('change', event => events.push(event));
  const target = f.write('large.py', 'current');
  f.store.record(target, 'a'.repeat(4 * MiB), 'b'.repeat(4 * MiB), true, hash(Buffer.from('current')));
  assert.equal(f.latest().before.length, 4 * MiB);
  f.store.record(target, 'a'.repeat(4 * MiB + 1), 'new', true, hash(Buffer.from('current')));
  assert.equal(events.at(-1).reason, 'size');
  assert.equal(fs.readFileSync(target, 'utf8'), 'current');
});

test('32 MiB total and 64-record retention evict only oldest review snapshots and never delete files', t => {
  const f = fixture(t), events = []; f.store.on('change', event => events.push(event));
  for (let index = 0; index < 5; index++) {
    const target = f.write(`large${index}.py`, `disk${index}`);
    f.store.record(target, 'a'.repeat(4 * MiB), 'b'.repeat(4 * MiB), true, hash(Buffer.from(`disk${index}`)));
  }
  assert.equal(f.records().length, 4);
  assert.equal(f.records().some(record => record.path === 'large0.py'), false);
  assert.equal(events.some(event => event.reason === 'limit'), true);
  assert.equal(fs.readFileSync(path.join(f.root, 'large0.py'), 'utf8'), 'disk0');
  for (let index = 0; index < 65; index++) {
    const target = f.write(`small${index}.py`, `disk${index}`);
    f.store.record(target, 'before', 'after', true, hash(Buffer.from(`disk${index}`)));
  }
  assert.equal(f.records().length, 64);
  assert.equal(f.records().some(record => record.path === 'small0.py'), false);
  assert.equal(fs.existsSync(path.join(f.root, 'small0.py')), true);
});

test('persisted records exceeding one 4 MiB snapshot are rejected even when combined size is below 8 MiB', async t => {
  const f = fixture(t); f.write('a.py', 'AI');
  const saved = { id: crypto.randomUUID(), workspaceId: f.project.id, path: 'a.py', before: 'a'.repeat(4 * MiB + 1), after: 'AI', beforeExists: true, revision: hash(Buffer.from('AI')), createdAt: 1, updatedAt: 1 };
  await f.store.dispose();
  fs.writeFileSync(f.state, JSON.stringify({ version: 1, records: [saved] }));
  const restored = new IDEReviewStore(f.files, f.state); f.owned.push({ files: f.files, store: restored });
  assert.deepEqual(restored.list(f.project.id).records, []);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.py'), 'utf8'), 'AI');
});
