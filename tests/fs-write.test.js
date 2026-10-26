// POST /api/fs/write is the only path that lets the editor put text on disk, so
// its boundaries are pinned: scope, private files, size, and the conflict check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let server;
let endpoint;
let projectRoot;
let auth;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-fswrite-'));
  projectRoot = path.join(dir, 'project');
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  server = await backend.startServer(0, false);
  const token = backend.getServerCredentials(server).token;
  endpoint = 'http://127.0.0.1:' + server.address().port;
  auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const set = await fetch(endpoint + '/api/project', { method: 'POST', headers: auth, body: JSON.stringify({ root: projectRoot }) });
  assert.equal(set.status, 200, await set.text());
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
});

const write = (body) => fetch(endpoint + '/api/fs/write', {
  method: 'POST', headers: auth, body: JSON.stringify(body),
});

test('a new document is created inside the project', async () => {
  const response = await write({ path: 'docs/new.md', content: '# 新文档\n' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.path, 'docs/new.md');
  assert.equal(data.created, true);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'docs/new.md'), 'utf8'), '# 新文档\n');
});

test('an existing document is overwritten and reports the new mtime', async () => {
  await write({ path: 'docs/edit.md', content: 'first' });
  const before = Math.round(fs.statSync(path.join(projectRoot, 'docs/edit.md')).mtimeMs);
  const response = await write({ path: 'docs/edit.md', content: 'second', expectedMtimeMs: before });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.created, false);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'docs/edit.md'), 'utf8'), 'second');
  assert.ok(data.mtimeMs > 0);
});

test('a stale expectedMtimeMs is refused instead of clobbering the file', async () => {
  await write({ path: 'docs/conflict.md', content: 'mine' });
  const stale = Math.round(fs.statSync(path.join(projectRoot, 'docs/conflict.md')).mtimeMs) - 60_000;
  const response = await write({ path: 'docs/conflict.md', content: 'theirs', expectedMtimeMs: stale });
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.match(data.error, /其他程序修改/);
  assert.ok(Number.isFinite(data.mtimeMs));
  assert.equal(fs.readFileSync(path.join(projectRoot, 'docs/conflict.md'), 'utf8'), 'mine', 'the file is untouched');
});

test('a path outside the project is refused', async () => {
  const outside = path.join(path.dirname(projectRoot), 'escape.md');
  const response = await write({ path: '../escape.md', content: 'nope' });
  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(outside), false);
});

test('internal and private paths are refused', async () => {
  // The path sandbox rejects .iexa-* before this route sees it; isPrivateFile
  // covers the rest (.env, .ssh, .git), which the sandbox allows through.
  const internal = await write({ path: '.iexa-settings.json', content: '{}' });
  assert.equal(internal.status, 400);
  assert.equal(fs.existsSync(path.join(projectRoot, '.iexa-settings.json')), false);

  const env = await write({ path: '.env', content: 'SECRET=1' });
  assert.equal(env.status, 403);
  assert.equal(fs.existsSync(path.join(projectRoot, '.env')), false);

  const git = await write({ path: '.git/config', content: '[core]' });
  assert.equal(git.status, 403);
  assert.equal(fs.existsSync(path.join(projectRoot, '.git/config')), false);
});

test('malformed bodies are refused with a reason', async () => {
  assert.equal((await write({ content: 'x' })).status, 400);
  assert.equal((await write({ path: 'docs/x.md' })).status, 400);
  const bad = await fetch(endpoint + '/api/fs/write', { method: 'POST', headers: auth, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /JSON/);
});

test('an oversized document is refused', async () => {
  const response = await write({ path: 'docs/huge.md', content: 'x'.repeat(2 * 1024 * 1024 + 1) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /过大/);
  assert.equal(fs.existsSync(path.join(projectRoot, 'docs/huge.md')), false);
});

test('writing into a directory target is refused', async () => {
  fs.mkdirSync(path.join(projectRoot, 'docs/folder.md'), { recursive: true });
  const response = await write({ path: 'docs/folder.md', content: 'x' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /目录/);
});

test('the written file reads back through the existing read API', async () => {
  await write({ path: 'docs/roundtrip.md', content: '往返测试\n第二行' });
  const response = await fetch(endpoint + '/api/fs/read?path=' + encodeURIComponent('docs/roundtrip.md'), { headers: auth });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.content, '往返测试\n第二行');
  assert.equal(data.name, 'roundtrip.md');
});
