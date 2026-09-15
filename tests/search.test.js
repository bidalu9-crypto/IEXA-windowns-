'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');

// TypeScript is compiled in memory; no server, Electron, services or dist writes.
const source = path.resolve(__dirname, '../src/main/search/ProjectSearch.ts');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
function load(promises = fsp) {
  const mod = new Module(source, module);
  mod.filename = source;
  mod.require = (id) => {
    if (id === 'fs/promises') return promises;
    if (id === 'fs') return new Proxy({ constants: fs.constants }, {
      get(target, key) {
        if (key in target) return target[key];
        throw new Error(`Unexpected synchronous filesystem API: ${String(key)}`);
      },
    });
    return require(id);
  };
  mod._compile(compiled, source);
  return mod.exports.searchProjectText;
}
async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iexa-search-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('iexa-search-'));
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function put(root, file, content) {
  const target = path.join(root, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}
function dirent(name, kind = 'file') {
  return { name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' };
}
function stats(size, directory = false, ino = 1) {
  return { size, dev: 1, ino, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
}

// In-memory filesystem exercises quotas without creating thousands of real files.
function virtual(files, options = {}) {
  const root = path.resolve(os.tmpdir(), 'iexa-search-virtual');
  const state = { opened: 0, active: 0, peak: 0, closed: 0, bytes: 0, directoryClosed: 0, entries: 0 };
  const bodies = new Map(files.map(([name, body]) => [path.join(root, name), Buffer.from(body)]));
  const api = {
    realpath: async (target) => path.resolve(target),
    lstat: async (target) => target === root ? stats(0, true) : stats(options.size ?? bodies.get(target).length),
    opendir: async () => {
      let i = 0;
      return {
        read: async () => { state.entries++; return i < files.length ? dirent(files[i++][0]) : null; },
        close: async () => { state.directoryClosed++; },
      };
    },
    open: async (target) => {
      state.opened++; state.active++; state.peak = Math.max(state.peak, state.active);
      const body = bodies.get(target);
      return {
        stat: async () => stats(options.size ?? body.length),
        read: async (buffer, offset, length, position) => {
          await new Promise((resolve) => setImmediate(resolve));
          if (options.readError) throw new Error('fixture read error');
          state.bytes += length;
          const bytesRead = Math.max(0, Math.min(length, body.length - position));
          body.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead, buffer };
        },
        close: async () => { state.closed++; state.active--; },
      };
    },
    readFile: async () => { throw new Error('unbounded readFile forbidden'); },
  };
  return { root, api, state };
}

test('async literal search preserves relative paths, 1-based lines/columns and preview contract', async (t) => {
  const root = await fixture(t);
  await put(root, 'src/sample.ts', 'zero\r\n  Hello.* HELLO.*\r\n你好 hello.*\n' + 'x'.repeat(350) + 'hello.*');
  const search = load();
  const promise = search(root, ' HELLO.* ');
  assert.ok(promise instanceof Promise);
  const results = await promise;
  assert.deepEqual(results.slice(0, 2), [
    { path: 'src/sample.ts', line: 2, column: 3, preview: 'Hello.* HELLO.*' },
    { path: 'src/sample.ts', line: 3, column: 4, preview: '你好 hello.*' },
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[2].column, 351); assert.equal(results[2].preview.length, 300);
  assert.deepEqual(await search(root, 'no such match'), []);
});

test('hidden, dependency, build, credential and private-key paths are excluded case-insensitively', async (t) => {
  const root = await fixture(t);
  for (const file of ['.git/config', 'node_modules/pkg/code.js', '.iexa-state.json', '.iexa-plugins/entry.js',
    '.env', '.env.local', '.aws/credentials', 'secrets/config.json', 'SECRETS.txt', 'config/credentials.json',
    'auth.json', 'service-account.json', 'user-token.txt', 'private_key.json', 'client.pem', 'client.key',
    'id_rsa', 'dist/bundle.js', 'build/out.txt', '.next/page.js', '__pycache__/code.txt', 'coverage/result.txt']) {
    await put(root, file, 'needle');
  }
  await put(root, 'src/SecretStore.ts', 'needle'); // Ordinary source files remain searchable.
  await put(root, 'config/settings.json', 'needle');
  const results = await load()(root, 'needle');
  assert.deepEqual(results.map((item) => item.path).sort(), ['config/settings.json', 'src/SecretStore.ts']);
});

test('oversized and binary files skipped; exactly 1 MiB accepted; empty/missing roots return []', async (t) => {
  const root = await fixture(t);
  await put(root, 'oversized.txt', Buffer.alloc(1024 * 1024 + 1, 120));
  await put(root, 'exact.txt', Buffer.concat([Buffer.from('needle'), Buffer.alloc(1024 * 1024 - 6, 120)]));
  await put(root, 'binary.bin', Buffer.concat([Buffer.alloc(10_000, 120), Buffer.from('\0needle')]));
  await put(root, 'empty.txt', '');
  const search = load();
  assert.deepEqual((await search(root, 'needle')).map((item) => item.path), ['exact.txt']);
  assert.deepEqual(await search(path.join(root, 'missing'), 'needle'), []);
  assert.deepEqual(await search(path.join(root, 'exact.txt'), 'needle'), []);
});

test('symlink/junction escapes and cycles never read sibling fixture content', async (t) => {
  const base = await fixture(t); const root = path.join(base, 'project');
  const sibling = path.join(base, 'project-sibling');
  await put(root, 'inside.txt', 'needle'); await put(sibling, 'outside.txt', 'needle external');
  await fsp.symlink(sibling, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await fsp.symlink(root, path.join(root, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  const opened = [];
  const search = load({ ...fsp, open: async (target, flags) => { opened.push(target); return fsp.open(target, flags); } });
  assert.deepEqual(await search(root, 'needle'), [{ path: 'inside.txt', line: 1, column: 1, preview: 'needle' }]);
  assert.equal(opened.length, 1); assert.equal(path.dirname(opened[0]), await fsp.realpath(root));
});

test('limits clamp to 0..100 and blank/oversized queries perform no filesystem work', async (t) => {
  let filesystemCalls = 0;
  const none = load({ realpath: async () => { filesystemCalls++; throw new Error('Unexpected filesystem work'); } });
  assert.deepEqual(await none('fixture', '  '), []);
  assert.deepEqual(await none('fixture', 'x'.repeat(4097)), []);
  assert.deepEqual(await none('fixture', 'needle', 0), []);
  assert.deepEqual(await none('fixture', 'needle', -1), []);
  assert.equal(filesystemCalls, 0);
  const root = await fixture(t); await put(root, 'many.txt', 'needle\n'.repeat(200));
  const search = load();
  assert.equal((await search(root, 'needle')).length, 100);
  assert.equal((await search(root, 'needle', 1000)).length, 100);
  assert.equal((await search(root, 'needle', NaN)).length, 100);
  assert.equal((await search(root, 'needle', 2.9)).length, 2);
});

test('at most 2500 files and eight concurrent file handles; all handles close', async () => {
  const v = virtual(Array.from({ length: 2600 }, (_, i) => [`file-${i}.txt`, 'haystack']));
  assert.deepEqual(await load(v.api)(v.root, 'needle'), []);
  assert.equal(v.state.opened, 2500);
  assert.equal(v.state.peak, 8);
  assert.equal(v.state.active, 0); assert.equal(v.state.closed, 2500);
  assert.equal(v.state.directoryClosed, 1);
});

test('result cap stops after current batch and preserves discovery rather than completion order', async () => {
  const v = virtual(Array.from({ length: 100 }, (_, i) => [`file-${i}.txt`, 'needle\nneedle']));
  const open = v.api.open;
  v.api.open = async (target, flags) => {
    const handle = await open(target, flags); const read = handle.read;
    handle.read = async (...args) => {
      if (target.endsWith('file-0.txt')) await new Promise((resolve) => setImmediate(resolve));
      return read(...args);
    };
    return handle;
  };
  assert.deepEqual(await load(v.api)(v.root, 'needle', 1), [{ path: 'file-0.txt', line: 1, column: 1, preview: 'needle' }]);
  assert.equal(v.state.opened, 8); assert.equal(v.state.closed, 8); assert.equal(v.state.directoryClosed, 1);
});

test('read failures and post-stat file growth are bounded and close file handles', async () => {
  const failed = virtual([['file.txt', 'needle']], { readError: true });
  assert.deepEqual(await load(failed.api)(failed.root, 'needle'), []);
  assert.equal(failed.state.opened, failed.state.closed);
  const growing = virtual([['file.txt', 'needle' + 'x'.repeat(1024 * 1024)]], { size: 6 });
  assert.deepEqual(await load(growing.api)(growing.root, 'needle'), []);
  assert.ok(growing.state.bytes <= 7); assert.equal(growing.state.active, 0);
});

test('canonical containment rejects prefix siblings, excluded aliases and final-path replacements before content reads', async () => {
  for (const alias of ['sibling', 'secret']) {
    const v = virtual([['file.txt', 'needle']]);
    v.api.realpath = async (target) => target === v.root ? target : alias === 'sibling'
      ? path.join(`${v.root}-sibling`, 'file.txt') : path.join(v.root, 'secrets', 'file.txt');
    assert.deepEqual(await load(v.api)(v.root, 'needle'), []);
    assert.equal(v.state.opened, 0);
  }
  const v = virtual([['file.txt', 'needle']]); const open = v.api.open;
  v.api.open = async (...args) => { const handle = await open(...args); handle.stat = async () => stats(6, false, 2); return handle; };
  assert.deepEqual(await load(v.api)(v.root, 'needle'), []);
  assert.equal(v.state.bytes, 0); assert.equal(v.state.opened, v.state.closed);
});

test('a tree full of excluded entries respects the metadata traversal cap', async () => {
  const v = virtual([]);
  v.api.opendir = async () => {
    let index = 0;
    return {
      read: async () => { v.state.entries++; return dirent(index++ < 50_001 ? '.ignored' : 'file.txt'); },
      close: async () => { v.state.directoryClosed++; },
    };
  };
  assert.deepEqual(await load(v.api)(v.root, 'needle'), []);
  assert.equal(v.state.entries, 50_000); assert.equal(v.state.opened, 0); assert.equal(v.state.directoryClosed, 1);
});

test('newline-heavy scans yield to the event loop without materializing a full lines array', async () => {
  const v = virtual([['file.txt', '\n'.repeat(100_000) + 'needle']]);
  let turns = 0; let running = true;
  const pulse = () => { if (running) { turns++; setImmediate(pulse); } };
  setImmediate(pulse);
  try {
    const result = await load(v.api)(v.root, 'needle');
    assert.equal(result[0].line, 100_001); assert.ok(turns > 100);
  } finally { running = false; }
});

test('empty-directory fanout and depth are bounded independently of the file quota', async () => {
  const v = virtual([]); let opened = 0; let closed = 0;
  v.api.lstat = async () => stats(0, true);
  v.api.opendir = async (target) => {
    opened++; let index = 0;
    return {
      read: async () => target === v.root && index < 3000 ? dirent(`folder-${index++}`, 'dir') : null,
      close: async () => { closed++; },
    };
  };
  assert.deepEqual(await load(v.api)(v.root, 'needle'), []);
  assert.equal(opened, 2500); assert.equal(closed, opened);
  opened = 0; closed = 0;
  v.api.opendir = async () => {
    opened++; let read = false;
    return {
      read: async () => { if (read) return null; read = true; return dirent('deeper', 'dir'); },
      close: async () => { closed++; },
    };
  };
  assert.deepEqual(await load(v.api)(v.root, 'needle'), []);
  assert.equal(opened, 65); assert.equal(closed, opened);
});

test('a file resolving outside after open is closed before content is read', async () => {
  const v = virtual([['file.txt', 'needle']]); let resolutions = 0;
  v.api.realpath = async (target) => target === v.root || ++resolutions === 1
    ? target : path.join(`${v.root}-sibling`, 'file.txt');
  assert.deepEqual(await load(v.api)(v.root, 'needle'), []);
  assert.equal(v.state.opened, 1); assert.equal(v.state.closed, 1); assert.equal(v.state.bytes, 0);
});
