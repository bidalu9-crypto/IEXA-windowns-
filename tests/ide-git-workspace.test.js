'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { make, remove } = require('./helpers/temp-dir');
const { FileWorkspace } = require('../dist/main/ide/FileWorkspace');
const { GitWorkspace, parseIDEGitStatus } = require('../dist/main/ide/GitWorkspace');
function git(root, ...args) {
  const env = { ...process.env }; for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(t, initialize = true) {
  const root = make('iexa-ide-git-'); const files = new FileWorkspace(); const project = files.authorize(root); const service = new GitWorkspace(files);
  if (initialize) { git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'IDE fixture'); git(root, 'config', 'user.email', 'fixture@localhost'); git(root, 'config', 'core.autocrlf', 'false'); }
  t.after(() => { files.dispose(); remove(root); });
  return { root, files, id: project.id, service };
}
function write(root, relative, text) { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); }
function commit(root) { git(root, 'add', '--all'); git(root, 'commit', '-m', 'fixture'); }
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('porcelain v1/v2 -z preserve Unicode, spaces, literal quotes, rename source and conflict', () => {
  const v1 = parseIDEGitStatus(' M 中文 space.py\0R  new name.txt\0old name.txt\0?? "literal".txt\0UU conflict.py\0!! ignored/\0');
  assert.deepEqual(v1.files.map(f => [f.path, f.index, f.workTree, f.originalPath]), [
    ['中文 space.py', ' ', 'M', undefined], ['new name.txt', 'R', ' ', 'old name.txt'], ['"literal".txt', '?', '?', undefined], ['conflict.py', 'U', 'U', undefined], ['ignored/', '!', '!', undefined],
  ]);
  assert.equal(v1.files[1].staged, true); assert.equal(v1.files[3].conflict, true); assert.equal(v1.files[4].ignored, true);
  const oid = 'a'.repeat(40);
  const v2 = parseIDEGitStatus(Buffer.from(`# branch.oid ${oid}\0# branch.head main\0` +
    `1 .M N... 100644 100644 100644 ${oid} ${oid} 中文 with spaces.txt\0` +
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 target\nline.txt\0source.txt\0` +
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt\0? untracked.txt\0! cache/\0`));
  assert.equal(v2.head, oid); assert.equal(v2.branch, 'main'); assert.equal(v2.files[0].path, '中文 with spaces.txt');
  assert.equal(v2.files[1].path, 'target\nline.txt'); assert.equal(v2.files[1].originalPath, 'source.txt'); assert.equal(v2.files[2].path, 'conflict.txt'); assert.equal(v2.files[2].conflict, true);
});

test('authorized non-repository and unborn HEAD are explicit; index baseline exists before first commit', async t => {
  const f = fixture(t, false); assert.equal((await f.service.status(f.id)).repository, false);
  await assert.rejects(f.service.baseline(f.id, 'test.py'), { code: 'IDE_GIT_REPOSITORY' });
  await assert.rejects(f.service.status('untrusted-id'), { code: 'IDE_WORKSPACE' });
  git(f.root, 'init', '-b', 'main'); write(f.root, 'test.py', 'print("new")\n'); git(f.root, 'add', 'test.py');
  const status = await f.service.status(f.id); assert.equal(status.repository, true, JSON.stringify(status)); assert.equal(status.unborn, true); assert.equal(status.branch, 'main'); assert.equal(status.files[0].index, 'A');
  assert.equal((await f.service.baseline(f.id, 'test.py', 'HEAD')).exists, false);
  const index = await f.service.baseline(f.id, 'test.py'); assert.equal(index.exists, true); assert.equal(index.content, 'print("new")\n');
});

test('real status separates staged/unstaged/deleted/untracked/ignored with exact HEAD and index blobs', async t => {
  const f = fixture(t);
  write(f.root, '中文 space.py', 'base\n'); write(f.root, 'deleted.txt', 'deleted base\n'); write(f.root, '.gitignore', 'ignored/\n'); commit(f.root);
  write(f.root, '中文 space.py', 'staged\n'); git(f.root, 'add', '中文 space.py'); write(f.root, '中文 space.py', 'working\n');
  fs.unlinkSync(path.join(f.root, 'deleted.txt')); write(f.root, 'new.txt', 'new\n'); write(f.root, 'ignored/cache.txt', 'ignored');
  const indexHash = hash(path.join(f.root, '.git/index')); const status = await f.service.status(f.id); assert.equal(status.repository, true, JSON.stringify(status));
  const item = status.files.find(f => f.path === '中文 space.py'); assert.equal(item.index, 'M'); assert.equal(item.workTree, 'M'); assert.equal(item.staged, true);
  assert.equal(status.files.find(f => f.path === 'deleted.txt').workTree, 'D'); assert.equal(status.files.find(f => f.path === 'new.txt').untracked, true);
  assert.ok(status.files.some(f => f.path === 'ignored/' && f.ignored));
  const diff = await f.service.diff(f.id, '中文 space.py'); assert.equal(diff.original.content, 'staged\n'); assert.equal(diff.modified.content, 'working\n');
  assert.equal(diff.modified.revision, f.files.read(f.id, '中文 space.py').revision);
  assert.equal((await f.service.baseline(f.id, '中文 space.py', 'HEAD')).content, 'base\n');
  const deleted = await f.service.diff(f.id, 'deleted.txt'); assert.equal(deleted.original.content, 'deleted base\n'); assert.equal(deleted.modified.exists, false);
  const untracked = await f.service.diff(f.id, 'new.txt'); assert.equal(untracked.original.exists, false); assert.equal(untracked.modified.content, 'new\n');
  assert.equal(hash(path.join(f.root, '.git/index')), indexHash, 'read-only Git never refreshes original index');
});

test('real staged rename retains original path and HEAD content; index follows renamed path', async t => {
  const f = fixture(t); write(f.root, 'old 名.py', 'rename baseline\n'); commit(f.root); git(f.root, 'mv', 'old 名.py', 'new 名.py');
  const status = await f.service.status(f.id); const renamed = status.files.find(file => file.path === 'new 名.py'); assert.ok(renamed, JSON.stringify(status)); assert.equal(renamed.index, 'R'); assert.equal(renamed.originalPath, 'old 名.py');
  const head = await f.service.diff(f.id, 'new 名.py', 'HEAD'); assert.equal(head.original.content, 'rename baseline\n'); assert.equal(head.modified.content, 'rename baseline\n');
  assert.equal((await f.service.baseline(f.id, 'new 名.py')).content, 'rename baseline\n');
});

test('repository subtree status and baselines cannot expose sibling paths or rename sources', async t => {
  const f = fixture(t); write(f.root, 'project/main.py', 'inside base\n'); write(f.root, 'secret.txt', 'OUTSIDE_SECRET\n'); write(f.root, 'move.txt', 'OUTSIDE_RENAME\n'); commit(f.root);
  const project = f.files.authorize(path.join(f.root, 'project'));
  write(f.root, 'project/main.py', 'inside change\n'); write(f.root, 'secret.txt', 'OUTSIDE_CHANGED\n'); git(f.root, 'mv', 'move.txt', 'project/imported.txt');
  const status = await f.service.status(project.id); assert.equal(status.repository, true, JSON.stringify(status)); assert.ok(status.files.some(file => file.path === 'main.py'));
  assert.equal(JSON.stringify(status).includes('secret'), false); assert.equal(JSON.stringify(status).includes('move.txt'), false);
  assert.ok(status.files.every(file => !file.path.includes('project/')));
  await assert.rejects(f.service.diff(project.id, '../secret.txt')); await assert.rejects(f.service.baseline(project.id, '../secret.txt', 'HEAD'));
  assert.equal((await f.service.baseline(project.id, 'main.py', 'HEAD')).content, 'inside base\n');
  assert.equal((await f.service.baseline(project.id, 'imported.txt', 'HEAD')).exists, false, 'external rename source does not authorize external blob read');
});

test('real conflict exposes stages1/2/3 and leaves index/working conflict untouched', async t => {
  const f = fixture(t); write(f.root, 'conflict.py', 'base\n'); commit(f.root); git(f.root, 'branch', 'other');
  write(f.root, 'conflict.py', 'ours\n'); commit(f.root); git(f.root, 'switch', 'other'); write(f.root, 'conflict.py', 'theirs\n'); commit(f.root); git(f.root, 'switch', 'main');
  assert.throws(() => git(f.root, 'merge', 'other'));
  const before = hash(path.join(f.root, '.git/index')); const status = await f.service.status(f.id); assert.equal(status.files[0].conflict, true);
  assert.equal((await f.service.baseline(f.id, 'conflict.py', 'base')).content, 'base\n'); assert.equal((await f.service.baseline(f.id, 'conflict.py', 'ours')).content, 'ours\n'); assert.equal((await f.service.baseline(f.id, 'conflict.py', 'theirs')).content, 'theirs\n');
  const unresolved = await f.service.diff(f.id, 'conflict.py'); assert.equal(unresolved.original.conflict, true); assert.deepEqual(unresolved.original.stages, [1, 2, 3]); assert.match(unresolved.modified.content, /<<<<<<< HEAD/);
  assert.equal(hash(path.join(f.root, '.git/index')), before);
});

test('status and blob reads never invoke clean/process filters, fsmonitor, hooks, external diff or includes', async t => {
  const f = fixture(t); write(f.root, 'nested/file.txt', 'raw baseline\n'); write(f.root, 'nested/.gitattributes', '*.txt filter=sentinel diff=sentinel\n'); commit(f.root);
  const marker = path.join(f.root, 'external-executed.txt'); const command = `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'executed')"`;
  for (const key of ['filter.sentinel.clean', 'filter.sentinel.smudge', 'filter.sentinel.process', 'core.fsmonitor', 'diff.sentinel.textconv', 'diff.external']) git(f.root, 'config', key, command);
  git(f.root, 'config', 'filter.sentinel.required', 'true');
  write(f.root, '.git/hooks/post-index-change', '#!/bin/sh\n' + command + '\n');
  const outside = make('iexa-git-config-outside-'); t.after(() => remove(outside)); write(outside, 'include.config', '[core]\nfsmonitor = ' + command + '\n'); git(f.root, 'config', 'include.path', path.join(outside, 'include.config'));
  write(f.root, 'nested/file.txt', 'raw changed\n');
  const status = await f.service.status(f.id); assert.equal(status.repository, true, JSON.stringify(status)); assert.equal(status.files.find(file => file.path === 'nested/file.txt').workTree, 'M');
  const diff = await f.service.diff(f.id, 'nested/file.txt', 'HEAD'); assert.equal(diff.original.content, 'raw baseline\n'); assert.equal(diff.modified.content, 'raw changed\n'); assert.equal(fs.existsSync(marker), false);
});

test('malicious Git env cannot redirect authorized status or baseline', async t => {
  const f = fixture(t); write(f.root, 'main.py', 'authorized\n'); commit(f.root); write(f.root, 'main.py', 'authorized change\n');
  const saved = {}; for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_COUNT']) { saved[key] = process.env[key]; process.env[key] = key === 'GIT_CONFIG_COUNT' ? '0' : path.join(f.root, 'nonexistent-redirect'); }
  try { const status = await f.service.status(f.id); assert.equal(status.repository, true, JSON.stringify(status)); assert.equal((await f.service.baseline(f.id, 'main.py', 'HEAD')).content, 'authorized\n'); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('metadata symlinks/gitfiles/object alternates and project path escapes fail closed', async t => {
  const f = fixture(t); write(f.root, 'main.py', 'base\n'); commit(f.root);
  await assert.rejects(f.service.diff(f.id, '.git/config'), { code: 'IDE_GIT_PATH' }); await assert.rejects(f.service.diff(f.id, '../outside.py'));
  const outside = make('iexa-git-metadata-outside-'); t.after(() => remove(outside));
  fs.symlinkSync(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.service.diff(f.id, 'escape/secret.txt'));
  write(f.root, '.git/objects/info/alternates', outside + '\n'); const alternate = await f.service.status(f.id); assert.equal(alternate.errorCode, 'IDE_GIT_METADATA'); fs.unlinkSync(path.join(f.root, '.git/objects/info/alternates'));
  fs.renameSync(path.join(f.root, '.git'), path.join(outside, 'metadata')); fs.symlinkSync(path.join(outside, 'metadata'), path.join(f.root, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await f.service.status(f.id); assert.equal(linked.repository, false); assert.equal(linked.errorCode, 'IDE_GIT_METADATA'); fs.unlinkSync(path.join(f.root, '.git'));
  write(f.root, '.git', 'gitdir: ' + path.join(outside, 'metadata') + '\n'); assert.equal((await f.service.status(f.id)).errorCode, 'IDE_GIT_METADATA');
});

test('binary and UTF16 baselines remain explicit and UTF8 revisions match FileWorkspace CAS', async t => {
  const f = fixture(t); write(f.root, 'binary.dat', Buffer.from([1, 0, 2, 3])); write(f.root, 'utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\r\n', 'utf16le')])); write(f.root, 'text.txt', 'base\n'); commit(f.root);
  assert.equal((await f.service.diff(f.id, 'binary.dat')).original.binary, true); assert.equal((await f.service.diff(f.id, 'binary.dat')).modified.binary, true);
  const utf16 = await f.service.diff(f.id, 'utf16.txt'); assert.equal(utf16.original.content, '中文\r\n'); assert.equal(utf16.modified.encoding, 'utf16le-bom'); assert.equal(utf16.modified.revision, f.files.read(f.id, 'utf16.txt').revision);
  const before = await f.service.diff(f.id, 'text.txt'); write(f.root, 'text.txt', 'external\n'); await assert.rejects(f.files.write(f.id, 'text.txt', before.original.content, before.modified.revision), { code: 'IDE_CONFLICT' }); assert.equal(fs.readFileSync(path.join(f.root, 'text.txt'), 'utf8'), 'external\n');
  await assert.rejects(f.service.baseline(f.id, 'text.txt', 'arbitrary-ref'), { code: 'IDE_GIT_REF' });
});

test('packed refs, split index and detached HEAD retain actual version data', async t => {
  const f = fixture(t); write(f.root, 'main.py', 'committed\n'); commit(f.root); const head = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'pack-refs', '--all'); git(f.root, 'update-index', '--split-index'); write(f.root, 'main.py', 'changed\n');
  const status = await f.service.status(f.id); assert.equal(status.branch, 'main'); assert.equal(status.head, head); assert.equal(status.files[0].workTree, 'M');
  assert.equal((await f.service.baseline(f.id, 'main.py')).content, 'committed\n'); assert.equal((await f.service.baseline(f.id, 'main.py', 'HEAD')).content, 'committed\n');
  git(f.root, 'switch', '--detach', head); assert.equal((await f.service.status(f.id)).branch, '(detached HEAD)');
});

test('oversized blobs and working files fail explicitly; status remains available', async t => {
  const f = fixture(t); write(f.root, 'big.txt', 'a'.repeat(4 * 1024 * 1024 + 1)); commit(f.root);
  await assert.rejects(f.service.baseline(f.id, 'big.txt', 'HEAD'), { code: 'IDE_SIZE' });
  write(f.root, 'new-big.txt', 'b'.repeat(4 * 1024 * 1024 + 1)); await assert.rejects(f.service.diff(f.id, 'new-big.txt'), { code: 'IDE_SIZE' });
  assert.equal((await f.service.status(f.id)).repository, true);
});

test('missing Git is distinguished from a non-repository', async t => {
  const f = fixture(t); const previousPath = process.env.PATH; process.env.PATH = f.root;
  try { const status = await f.service.status(f.id); assert.equal(status.available, false); assert.equal(status.errorCode, 'IDE_GIT_UNAVAILABLE'); }
  finally { process.env.PATH = previousPath; }
});

test('safe text normalization avoids false M for clean CRLF while returning raw baselines', async t => {
  const f = fixture(t); write(f.root, '.gitattributes', '*.txt text eol=crlf\n'); write(f.root, 'windows.txt', 'line1\r\nline2\r\n'); commit(f.root);
  assert.equal((await f.service.status(f.id)).files.some(file => file.path === 'windows.txt'), false);
  const diff = await f.service.diff(f.id, 'windows.txt'); assert.equal(diff.original.content, 'line1\nline2\n'); assert.equal(diff.modified.content, 'line1\r\nline2\r\n');
  git(f.root, 'config', 'core.autocrlf', 'true'); write(f.root, 'plain.py', 'clean\r\n'); git(f.root, '-c', 'core.autocrlf=true', 'add', 'plain.py'); git(f.root, 'commit', '-m', 'crlf');
  assert.equal((await f.service.status(f.id)).files.some(file => file.path === 'plain.py'), false);
});

test('SHA256 object-format repositories retain full object IDs', async t => {
  const f = fixture(t, false); git(f.root, 'init', '--object-format=sha256', '-b', 'main'); git(f.root, 'config', 'user.name', 'IDE fixture'); git(f.root, 'config', 'user.email', 'fixture@localhost'); write(f.root, 'main.py', 'sha256 base\n'); commit(f.root); write(f.root, 'main.py', 'sha256 change\n');
  const status = await f.service.status(f.id); assert.equal(status.repository, true, JSON.stringify(status)); assert.equal(status.head.length, 64); assert.equal(status.files[0].workTree, 'M');
  const baseline = await f.service.baseline(f.id, 'main.py', 'HEAD'); assert.equal(baseline.content, 'sha256 base\n'); assert.equal(baseline.oid.length, 64);
});
