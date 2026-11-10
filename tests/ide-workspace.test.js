'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { make, remove } = require('./helpers/temp-dir');
const { FileWorkspace } = require('../dist/main/ide/FileWorkspace');
const { PreviewServerManager } = require('../dist/main/ide/PreviewServerManager');

function fixture(t, prefix = 'iexa-ide-') {
  const root = make(prefix); const files = new FileWorkspace(); const project = files.authorize(root);
  t.after(() => { files.dispose(); remove(root); });
  return { root, files, id: project.id };
}
async function get(url, headers) {
  return new Promise((resolve, reject) => { http.get(url, { headers }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body })); }).once('error', reject); });
}

test('selected standalone HTML previews exact encoded paths, relative assets and UTF16 without running scripts', async t => {
  const { root, files, id } = fixture(t); const manager = new PreviewServerManager(files); t.after(() => manager.shutdown());
  fs.mkdirSync(path.join(root, '中文 space'));
  const entry = '中文 space/pelican #ride.html';
  fs.writeFileSync(path.join(root, entry), '<!doctype html><link rel="stylesheet" href="theme.css"><h1>PELICAN</h1>');
  fs.writeFileSync(path.join(root, '中文 space/theme.css'), 'h1{color:green}');
  fs.writeFileSync(path.join(root, 'second.htm'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('<h1>第二页</h1>', 'utf16le')]));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts:{dev:'node should-not-run.cjs'}}));
  const first = await manager.start(id, undefined, false, entry);
  assert.equal(first.status, 'running'); assert.equal(first.script, undefined); assert.equal(first.entryPath, entry);
  assert.equal(decodeURIComponent(new URL(first.url).pathname), '/' + entry);
  assert.match((await get(first.url)).body, /PELICAN/);
  assert.equal((await get(new URL('theme.css', first.url).href)).body, 'h1{color:green}');
  const second = await manager.start(id, undefined, false, 'second.htm');
  assert.equal(new URL(second.url).origin, new URL(first.url).origin);
  assert.match((await get(second.url)).body, /第二页/);
  assert.match((await get(second.url)).body, /data-iexa-ide-reload/);
  const restarted = await manager.restart(id);
  assert.equal(restarted.entryPath, 'second.htm'); assert.match((await get(restarted.url)).body, /第二页/);
  await assert.rejects(manager.start(id, undefined, false, 'package.json'), {code:'IDE_PREVIEW'});
  await assert.rejects(manager.start(id, undefined, false, '../outside.html'));
  fs.writeFileSync(path.join(root, 'binary.html'), Buffer.from([0,1,2,3]));
  await assert.rejects(manager.start(id, undefined, false, 'binary.html'), {code:'IDE_BINARY'});
  assert.equal(manager.status(id).url, restarted.url, 'a rejected entry keeps the healthy preview');
});

test('concurrent selected HTML starts settle on the most recent requested entry', async t => {
  const { root, files, id } = fixture(t); const manager = new PreviewServerManager(files); t.after(() => manager.shutdown());
  for (const name of ['first.html','last.html']) fs.writeFileSync(path.join(root,name), '<h1>' + name + '</h1>');
  await Promise.all([manager.start(id, undefined, false, 'first.html'), manager.start(id, undefined, false, 'last.html')]);
  const state = manager.status(id); assert.equal(state.entryPath, 'last.html'); assert.match((await get(state.url)).body, /last.html/);
});
test('workspace reads complete text and saves bytes, detects same-mtime external edits', async t => {
  const { root, files, id } = fixture(t); const original = 'a'.repeat(120000); fs.writeFileSync(path.join(root, 'main.js'), original);
  const first = files.read(id, 'main.js'); assert.equal(first.content, original);
  const saved = await files.write(id, 'main.js', 'export const ok = true;', first.revision);
  assert.equal(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), saved.content);
  const oldTime = fs.statSync(path.join(root, 'main.js')).mtime;
  fs.writeFileSync(path.join(root, 'main.js'), 'external change'); fs.utimesSync(path.join(root, 'main.js'), oldTime, oldTime);
  await assert.rejects(files.write(id, 'main.js', 'stale buffer', saved.revision), { code: 'IDE_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), 'external change');
});
test('workspace preserves UTF16 BOM, handles hierarchy, rename, search, delete', async t => {
  const { root, files, id } = fixture(t); await files.create(id, 'src', true); await files.create(id, 'src/test.py');
  fs.writeFileSync(path.join(root, 'src/test.py'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('文本\r\n', 'utf16le')]));
  const first = files.read(id, 'src/test.py'); assert.equal(first.encoding, 'utf16le-bom'); assert.equal(first.content, '文本\r\n');
  await files.write(id, 'src/test.py', '保存\r\n', first.revision); const bytes = fs.readFileSync(path.join(root, 'src/test.py'));
  assert.equal(bytes.readUInt16LE(0), 0xfeff); assert.equal(bytes.subarray(2).toString('utf16le'), '保存\r\n');
  await files.rename(id, 'src/test.py', 'src/main.py'); assert.equal(files.search(id, 'main.py').entries[0].path, 'src/main.py');
  assert.equal(files.list(id, '').entries[0].directory, true); await files.remove(id, 'src'); assert.equal(fs.existsSync(path.join(root, 'src')), false);
});
test('workspace rejects traversal, unauthorized ids, junction escape, root deletion and binary files', async t => {
  const { root, files, id } = fixture(t); const outside = make('iexa-ide-outside-'); t.after(() => remove(outside));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside'); fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.read(id, '../secret.txt')); assert.throws(() => files.read(id, 'escape/secret.txt'));
  assert.throws(() => files.read('invented-id', 'a.txt'), { code: 'IDE_WORKSPACE' });
  await assert.rejects(files.remove(id, ''), { code: 'IDE_ROOT' });
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([1, 0, 3])); assert.throws(() => files.read(id, 'binary.dat'), { code: 'IDE_BINARY' });
  assert.equal(files.list(id).entries.some(item => item.name === 'escape'), false);
  assert.throws(() => files.resolve(id, 'file.txt:ads', true));
});
test('two saves with the same revision serialize so stale content cannot replace a newer save', async t => {
  const { root, files, id } = fixture(t); fs.writeFileSync(path.join(root, 'main.js'), 'before'); const first = files.read(id, 'main.js');
  const results = await Promise.allSettled([files.write(id, 'main.js', 'one', first.revision), files.write(id, 'main.js', 'two', first.revision)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(results.find(item => item.status === 'rejected').reason.code, 'IDE_CONFLICT');
});

test('Windows transient rename locks retry without deleting the target or overwriting external changes', { skip: process.platform !== 'win32' }, async t => {
  const { files, id } = fixture(t); const target = path.join(files.project(id).root, 'main.js'); fs.writeFileSync(target, 'original'); const initial = files.read(id, 'main.js');
  const originalRename = fs.promises.rename; let attempts = 0;
  fs.promises.rename = async (source, destination) => {
    if (destination === target && attempts++ < 2) { assert.equal(fs.readFileSync(target, 'utf8'), 'original'); throw Object.assign(new Error('temporary reader lock'), { code: 'EPERM' }); }
    return originalRename(source, destination);
  };
  t.after(() => { fs.promises.rename = originalRename; });
  await files.write(id, 'main.js', 'saved', initial.revision); assert.equal(attempts, 3); assert.equal(fs.readFileSync(target, 'utf8'), 'saved');
  const saved = files.read(id, 'main.js');
  fs.promises.rename = async () => { fs.writeFileSync(target, 'external during retry'); throw Object.assign(new Error('temporary reader lock'), { code: 'EPERM' }); };
  await assert.rejects(files.write(id, 'main.js', 'stale', saved.revision), { code: 'IDE_CONFLICT' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'external during retry');
});
test('static preview uses dynamic isolated ports, serves real files, reports reload and stops sockets', async t => {
  const a = fixture(t, 'iexa-ide-static-a-'); const bRoot = make('iexa-ide-static-b-'); t.after(() => remove(bRoot));
  fs.writeFileSync(path.join(a.root, 'index.html'), '<html><head></head><body>FIRST</body></html>'); fs.writeFileSync(path.join(bRoot, 'index.html'), '<html><body>SECOND</body></html>');
  const b = a.files.authorize(bRoot); const manager = new PreviewServerManager(a.files); t.after(() => manager.shutdown());
  assert.equal(manager.inspect(a.id).type, 'static'); const first = await manager.start(a.id); const second = await manager.start(b.id);
  assert.equal(first.status, 'running'); assert.notEqual(first.url, second.url); assert.match((await get(first.url)).body, /FIRST/); assert.match((await get(second.url)).body, /SECOND/);
  assert.match((await get(first.url)).body, /__iexa_ide_events/); assert.equal((await get(first.url, { Origin: 'http://evil.example' })).status, 403);
  fs.writeFileSync(path.join(a.root, '.env'), 'SECRET'); assert.equal((await get(`${first.url}.env`)).status, 403);
  fs.mkdirSync(path.join(a.root, '.git')); fs.writeFileSync(path.join(a.root, '.git/info.txt'), 'PRIVATE');
  fs.symlinkSync(path.join(a.root, '.git'), path.join(a.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await get(`${first.url}alias/info.txt`)).status, 403);
  const events = await new Promise(resolve => {
    const request = http.get(`${first.url}__iexa_ide_events`, response => {
      response.setEncoding('utf8'); response.once('data', () => { a.files.emit('change', { workspaceId: a.id }); response.once('data', value => { request.destroy(); resolve(value); }); });
    });
  }); assert.match(events, /reload/);
  await manager.stop(a.id); await assert.rejects(get(first.url)); assert.equal((await get(second.url)).status, 200); await manager.stop(b.id);
});
test('development scripts require explicit confirmation, capture output, and stop owned child trees', { timeout: 25000 }, async t => {
  const { root, files, id } = fixture(t, 'iexa-ide-进程 space &-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node fixture.cjs' } }));
  fs.writeFileSync(path.join(root, 'fixture.cjs'), [
    "const fs=require('node:fs'),http=require('node:http'),{spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});",
    "fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));",
    "http.createServer((req,res)=>res.end('DEV')).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('PREVIEW_READY'));",
  ].join('\n'));
  const manager = new PreviewServerManager(files); t.after(() => manager.shutdown());
  await assert.rejects(manager.start(id, 'dev', false), { code: 'IDE_CONFIRM' }); assert.equal(fs.existsSync(path.join(root, 'pids.json')), false);
  const state = await manager.start(id, 'dev', true); assert.equal(state.status, 'running', JSON.stringify(state)); assert.match(state.logs.map(item => item.message).join(''), /PREVIEW_READY/);
  assert.equal((await get(state.url)).body, 'DEV'); const pids = JSON.parse(fs.readFileSync(path.join(root, 'pids.json'), 'utf8'));
  await manager.stop(id); await assert.rejects(get(state.url));
  const deadline = Date.now() + 5000;
  function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
  while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pids.some(alive), false, `Owned descendants remain: ${pids}`);
});

test('restart during startup waits for cancelled launch before creating a new server', { timeout: 25000 }, async t => {
  const { root, files, id } = fixture(t, 'iexa-ide-restart-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node fixture.cjs' } }));
  fs.writeFileSync(path.join(root, 'fixture.cjs'), "setTimeout(()=>require('http').createServer((q,s)=>s.end('RESTARTED')).listen(+process.env.PORT,'127.0.0.1'),250)");
  const manager = new PreviewServerManager(files); t.after(() => manager.shutdown());
  const starting = manager.start(id, 'dev', true);
  const restarted = manager.restart(id, 'dev', true);
  await starting; const result = await restarted;
  assert.equal(result.status, 'running', JSON.stringify(result)); assert.equal((await get(result.url)).body, 'RESTARTED');
  await manager.stop(id);
});

test('a moved project root can still stop its already owned preview service', async t => {
  const { root, files, id } = fixture(t, 'iexa-ide-moved-'); fs.writeFileSync(path.join(root, 'index.html'), '<html>move</html>');
  const manager = new PreviewServerManager(files); t.after(() => manager.shutdown()); const state = await manager.start(id);
  const moved = `${root}-moved`; fs.renameSync(root, moved); t.after(() => remove(moved));
  assert.equal(manager.status(id).status, 'running'); await manager.stop(id); await assert.rejects(get(state.url));
});

test('a plain Vite script bypasses broken Windows command shims in ampersand project paths', { skip: process.platform !== 'win32' }, async t => {
  const { root, files, id } = fixture(t, 'iexa-ide-vite-&-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: 'fixture' } }));
  fs.mkdirSync(path.join(root, 'node_modules/vite/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/vite/bin/vite.js'), "const port=+process.argv[process.argv.indexOf('--port')+1];require('http').createServer((q,s)=>s.end('VITE_DIRECT')).listen(port,'127.0.0.1')");
  const manager = new PreviewServerManager(files); t.after(() => manager.shutdown());
  const state = await manager.start(id, 'dev', true); assert.equal(state.status, 'running', JSON.stringify(state)); assert.equal((await get(state.url)).body, 'VITE_DIRECT');
  assert.match(state.logs.map(log => log.message).join('\n'), /Vite Node/); await manager.stop(id);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { predev: 'node hook.cjs', dev: 'vite' }, devDependencies: { vite: 'fixture' } }));
  fs.writeFileSync(path.join(root, 'hook.cjs'), "require('fs').writeFileSync('hook-ran.txt','yes')");
  fs.mkdirSync(path.join(root, 'node_modules/.bin'));
  fs.writeFileSync(path.join(root, 'node_modules/.bin/vite.cmd'), '@node "%~dp0\\..\\vite\\bin\\vite.js" %*\r\n');
  const withHook = await manager.start(id, 'dev', true); assert.equal(withHook.status, 'running', JSON.stringify(withHook));
  assert.equal(fs.readFileSync(path.join(root, 'hook-ran.txt'), 'utf8'), 'yes');
  assert.equal(withHook.logs.some(log => log.message.includes('Vite Node')), false); await manager.stop(id);
});
