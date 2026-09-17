'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryTools } = require('../dist/main/tools/ToolExecutors');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-memory-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function linkDirectory(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('memory writes are serialized and preserve every concurrent entry', async (t) => {
  const root = fixture(t); const memoryDir = path.join(root, 'memory'); const tools = new MemoryTools(memoryDir);
  await tools.initialize();
  const writes = Array.from({ length: 40 }, (_, index) => tools.writeMemory(`concurrent-${index}`));
  const results = await Promise.all(writes);
  assert.equal(results.every(result => result.success), true, results.map(result => result.output).join('\n'));
  const files = fs.readdirSync(memoryDir).filter(name => name.endsWith('.md'));
  assert.equal(files.length, 1);
  const content = fs.readFileSync(path.join(memoryDir, files[0]), 'utf8');
  for (let index = 0; index < 40; index++) assert.equal(content.includes(`concurrent-${index}\n`), true, `missing entry ${index}`);
});

test('memory root junctions are rejected for reads and writes', async (t) => {
  const root = fixture(t); const outside = path.join(root, 'outside'); const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'external.md'), '# external\nsecret-sentinel');
  linkDirectory(outside, memoryDir);
  const tools = new MemoryTools(memoryDir);
  const write = await tools.writeMemory('must-not-escape');
  const read = await tools.getMemory('secret-sentinel');
  assert.equal(write.success, false); assert.match(write.output, /symbolic link|junction|outside/i);
  assert.equal(read.success, false); assert.match(read.output, /symbolic link|junction|outside/i);
  assert.equal(fs.readFileSync(path.join(outside, 'external.md'), 'utf8'), '# external\nsecret-sentinel');
  assert.equal(fs.readdirSync(outside).length, 1);
});

test('symlinked markdown entries are rejected without following the target', async (t) => {
  const root = fixture(t); const memoryDir = path.join(root, 'memory'); const outside = path.join(root, 'outside.md');
  fs.mkdirSync(memoryDir); fs.writeFileSync(outside, '# outside\nlinked-secret');
  const link = path.join(memoryDir, 'linked.md');
  try { fs.symlinkSync(outside, link, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('file symlink privilege unavailable'); throw error; }
  const tools = new MemoryTools(memoryDir);
  const read = await tools.getMemory('linked-secret'); const write = await tools.writeMemory('safe-entry');
  assert.equal(read.success, false); assert.match(read.output, /regular file|symbolic link/i);
  assert.equal(write.success, false); assert.match(write.output, /regular file|symbolic link/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), '# outside\nlinked-secret');
});

test('replacing initialized memory directory with a junction is detected', async (t) => {
  const root = fixture(t); const memoryDir = path.join(root, 'memory'); const outside = path.join(root, 'outside');
  const tools = new MemoryTools(memoryDir); await tools.initialize(); fs.mkdirSync(outside);
  fs.rmdirSync(memoryDir); linkDirectory(outside, memoryDir);
  const result = await tools.writeMemory('must-not-escape');
  assert.equal(result.success, false); assert.match(result.output, /symbolic link|junction|outside/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});
