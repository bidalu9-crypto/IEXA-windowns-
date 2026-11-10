'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileWorkspace } = require('../dist/main/ide/FileWorkspace');
const { PythonLanguageService } = require('../dist/main/ide/PythonLanguageService');
const { make, remove } = require('./helpers/temp-dir');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) assert.fail('condition timed out'); await delay(20); }
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fakeSource = String.raw`
let input=Buffer.alloc(0),config;
const send=value=>{const bytes=Buffer.from(JSON.stringify(value));process.stdout.write('Content-Length: '+bytes.length+'\r\n\r\n');process.stdout.write(bytes)};
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);for(;;){const boundary=input.indexOf('\r\n\r\n');if(boundary<0)return;const size=Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0,boundary).toString())[1]);if(input.length<boundary+4+size)return;const m=JSON.parse(input.subarray(boundary+4,boundary+4+size));input=input.subarray(boundary+4+size);handle(m)}});
function handle(m){
 if(m.method==='initialize'){
   send({jsonrpc:'2.0',id:m.id,method:'workspace/configuration',params:{items:[{section:'python.analysis'}]}});
   setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{capabilities:{}}}),Number(process.env.FAKE_INITIALIZE_DELAY||0));
 }else if(m.id!==undefined&&!m.method){config=m.result;}
 else if(m.method==='textDocument/didOpen'){
   if(process.env.FAKE_OVERFLOW)process.stdout.write('Content-Length: 33554433\r\n\r\n');
   const d=m.params.textDocument;send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:d.uri,version:d.version,diagnostics:[]}});
 }else if(m.method==='textDocument/didChange'){
   const d=m.params.textDocument;send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:d.uri,version:d.version,diagnostics:[{message:m.params.contentChanges[0].text,range:{start:{line:0,character:0},end:{line:0,character:1}},severity:1}]}});
 }else if(m.method==='textDocument/hover'){
   if(!process.env.FAKE_QUERY_TIMEOUT)send({jsonrpc:'2.0',id:m.id,result:{contents:JSON.stringify(config)}});
 }else if(m.id!==undefined){send({jsonrpc:'2.0',id:m.id,result:null});}
}
`;
function fixture(t, options = {}, real = false) {
  const directory = make('iexa-python-language-'), root = path.join(directory, "中文 project & user's");
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'main.py'), ''); fs.writeFileSync(path.join(root, 'notes.txt'), '');
  const files = new FileWorkspace(), project = files.authorize(root), events = [];
  let resourcePath;
  if (!real) {
    resourcePath = path.join(directory, 'pyright'); fs.mkdirSync(path.join(resourcePath, 'dist'), { recursive: true });
    const entries = { 'dist/server.js': fakeSource, 'LICENSE.txt': 'MIT License', 'dist/server.js.LICENSE.txt': 'MIT License' };
    for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(resourcePath, name), text);
    fs.writeFileSync(path.join(resourcePath, 'vendor-manifest.json'), JSON.stringify({ version: '1.1.402', license: 'MIT', entry: 'dist/server.js', files: Object.entries(entries).map(([name, text]) => ({ path: name, sha256: hash(text) })) }));
  }
  const service = new PythonLanguageService(files, { nodePath: process.execPath, ...(resourcePath ? { resourcePath } : {}), sampleRss: async () => undefined, ...options });
  service.on('change', value => events.push(value));
  t.after(async () => { await service.dispose(); files.dispose(); remove(directory); });
  return { root, directory, files, project, service, events, request: extra => service.request({ workspaceId: project.id, path: 'main.py', ...extra }) };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('status, unsupported languages, bad text and paths stay lazy and launch no process', async t => {
  const f = fixture(t);
  assert.equal(f.service.getStatus(f.project.id).status, 'idle');
  assert.equal((await f.request({ method: 'open', path: 'notes.txt', text: '', version: 1 })).status, 'unavailable');
  await assert.rejects(f.request({ method: 'open', path: '../outside.py', text: '', version: 1 }));
  await assert.rejects(f.request({ method: 'open', text: 'x'.repeat(500 * 1024 + 1), version: 1 }), { code: 'IDE_LANGUAGE_SIZE' });
  await assert.rejects(f.request({ method: 'open', text: 'x', version: 0 }), { code: 'IDE_LANGUAGE_VERSION' });
  assert.equal(f.service.getStatus().pid, undefined);
  assert.equal((await f.request({ method: 'close' })).status, 'idle');
});

test('missing Node is actionable; release during queued and pending initialize never leaves a server', async t => {
  const missing = fixture(t, { nodePath: null });
  const unavailable = await missing.request({ method: 'open', text: '', version: 1 });
  assert.equal(unavailable.status, 'unavailable'); assert.match(unavailable.reason, /Node.js/);
  const f = fixture(t, { env: { FAKE_INITIALIZE_DELAY: '250' } });
  const first = f.request({ method: 'open', text: 'x=1', version: 1 });
  await f.request({ method: 'release' }); await first;
  assert.equal(f.service.getStatus().pid, undefined);
  const second = f.request({ method: 'open', text: 'x=2', version: 2 });
  await until(() => f.service.getStatus().pid);
  const pid = f.service.getStatus().pid;
  await f.request({ method: 'release' }); await second;
  await until(() => !alive(pid)); assert.equal(f.service.getStatus().pid, undefined);
});

test('JSON-RPC client/server IDs stay independent and configuration disables scans, indexing and imports', async t => {
  const f = fixture(t);
  assert.equal((await f.request({ method: 'open', text: 'x=1', version: 1 })).status, 'ready');
  const pid = f.service.getStatus().pid;
  const result = await f.request({ method: 'hover', position: { line: 0, character: 0 } });
  const [config] = JSON.parse(result.result.contents);
  assert.equal(config.diagnosticMode, 'openFilesOnly'); assert.equal(config.indexing, false);
  assert.equal(config.autoImportCompletions, false); assert.deepEqual(config.include, []); assert.ok(config.exclude.includes('**'));
  assert.equal(f.service.getStatus().pid, pid);
});

test('50ms changes keep one latest snapshot; diagnostics require the exact server version', async t => {
  const f = fixture(t); await f.request({ method: 'open', text: 'v1', version: 1 });
  await f.request({ method: 'change', text: 'v2', version: 2 });
  await f.request({ method: 'change', text: 'v3', version: 3 });
  await f.request({ method: 'change', text: 'v4', version: 4 });
  await until(() => f.events.some(event => event.kind === 'diagnostics' && event.version === 4));
  const changes = f.events.filter(event => event.kind === 'diagnostics' && event.diagnostics?.[0]);
  assert.deepEqual(changes.map(event => event.version), [4]); assert.equal(changes[0].diagnostics[0].message, 'v4');
  const doc = [...f.service.documents.values()][0], count = f.events.length;
  f.service.message({ method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version: 3, diagnostics: [] } });
  f.service.message({ method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics: [] } });
  assert.equal(f.events.length, count);
  await assert.rejects(f.request({ method: 'change', text: 'other', version: 4 }), { code: 'IDE_LANGUAGE_VERSION' });
  await f.request({ method: 'release' });
});

test('closing deleted and renamed Python files releases their document slots without restarting the server', async t => {
  const f = fixture(t);
  const opened = await f.request({ method: 'open', text: 'draft', version: 1 });
  fs.renameSync(path.join(f.root, 'main.py'), path.join(f.root, 'renamed.py'));
  const closed = await f.request({ method: 'close' });
  assert.equal(closed.status, 'ready'); assert.equal(closed.pid, opened.pid);
  assert.equal(f.service.documents.size, 0);
  assert.ok(f.events.some(event => event.kind === 'diagnostics' && event.path === 'main.py' && event.diagnostics.length === 0));
  await f.request({ method: 'open', path: 'renamed.py', text: 'other draft', version: 1 });
  fs.unlinkSync(path.join(f.root, 'renamed.py'));
  await f.request({ method: 'close', path: 'renamed.py' });
  assert.equal(f.service.documents.size, 0);
  assert.equal(f.service.getStatus().pid, opened.pid);
  await assert.rejects(f.request({ method: 'close', path: '../outside.py' }));
});

test('workspace switch terminates A; idle releases B; changing project never reuses document URIs', async t => {
  const f = fixture(t, { idleMs: 250 });
  await f.request({ method: 'open', text: 'x=1', version: 1 }); const aPid = f.service.getStatus().pid;
  const otherRoot = path.join(f.directory, 'other'); fs.mkdirSync(otherRoot); fs.writeFileSync(path.join(otherRoot, 'main.py'), '');
  const other = f.files.authorize(otherRoot);
  const opened = await f.service.request({ workspaceId: other.id, method: 'open', path: 'main.py', text: 'x=2', version: 9 });
  assert.equal(opened.status, 'ready'); assert.notEqual(opened.pid, aPid); assert.equal(opened.workspaceId, other.id);
  await until(() => !alive(aPid)); const bPid = opened.pid;
  await until(() => f.service.getStatus().status === 'idle'); await until(() => !alive(bPid));
});

test('persistent RSS excess kills one owned process, enters cooldown and does not restart', async t => {
  let overload = false;
  const f = fixture(t, { sampleRss: async () => (overload ? 321 : 120) * 1024 * 1024, rssIntervalMs: 25, cooldownMs: 10000 });
  const opened = await f.request({ method: 'open', text: 'x=1', version: 1 }); const pid = opened.pid;
  assert.equal(opened.status, 'ready');
  overload = true;
  await until(() => f.service.getStatus().status === 'cooldown'); await until(() => !alive(pid));
  const retry = await f.request({ method: 'open', text: 'x=2', version: 2 });
  assert.equal(retry.status, 'cooldown'); assert.equal(retry.pid, undefined); assert.match(retry.reason, /320 MiB/);
});

test('oversized stdout and a hung request return bounded, explicit failure', async t => {
  const f = fixture(t, { env: { FAKE_OVERFLOW: '1' } });
  await f.request({ method: 'open', text: 'x=1', version: 1 });
  await until(() => f.service.getStatus().status === 'cooldown');
  assert.match(f.service.getStatus().reason, /消息大小超限/); assert.equal(f.service.getStatus().pid, undefined);
  const slow = fixture(t, { env: { FAKE_QUERY_TIMEOUT: '1' }, requestTimeoutMs: 80 });
  await slow.request({ method: 'open', text: 'x=1', version: 1 });
  const result = await slow.request({ method: 'hover', position: { line: 0, character: 0 } });
  assert.match(result.reason, /超时/); assert.equal(slow.service.pending.size, 0);
});

test('real pinned Pyright returns completion, hover, cross-file definition, references and versioned diagnostics', { timeout: 20000 }, async t => {
  const f = fixture(t, {}, true), started = Date.now();
  const helper = 'def greet(name: str) -> str:\n    return name\n';
  fs.writeFileSync(path.join(f.root, 'helper.py'), helper);
  const text = "from helper import greet\nanswer = greet('x')\nwrong: int = 'bad'\nvalues = [1, 2, 3]\nvalues.ap\n";
  const opened = await f.request({ method: 'open', text, version: 1 }); assert.equal(opened.status, 'ready');
  assert.ok(opened.pid); assert.deepEqual(f.service.child.spawnargs.slice(1, 2), ['--max-old-space-size=192']);
  const completion = await f.request({ method: 'completion', position: { line: 4, character: 9 } });
  assert.ok(completion.result.items.some(item => item.label === 'append'), JSON.stringify(completion));
  const hover = await f.request({ method: 'hover', position: { line: 3, character: 2 } });
  assert.match(hover.result.contents.value, /list\[int\]/);
  const definition = await f.request({ method: 'definition', position: { line: 1, character: 11 } });
  assert.ok(definition.result.some(item => item.path === 'helper.py'), JSON.stringify(definition));
  // Opening the referenced file makes references stay scoped to opened documents.
  await f.service.request({ workspaceId: f.project.id, method: 'open', path: 'helper.py', text: helper, version: 1 });
  const references = await f.request({ method: 'references', position: { line: 1, character: 11 } });
  assert.ok(references.result.some(item => item.path === 'main.py'), JSON.stringify(references));
  await until(() => f.events.some(event => event.kind === 'diagnostics' && event.path === 'main.py' && event.version === 1 && event.diagnostics.some(item => item.range.start.line === 2)), 7000);
  const changed = text.replace("wrong: int = 'bad'", 'wrong: int = 1').replace('values.ap', 'values.append(4)');
  await f.request({ method: 'change', text: changed, version: 2 });
  await until(() => f.events.some(event => event.kind === 'diagnostics' && event.path === 'main.py' && event.version === 2 && !event.diagnostics.some(item => item.range.start.line === 2)), 7000);
  const summary = { elapsedMs: Date.now() - started, pid: opened.pid, completion: 'append', hover: 'list[int]', definition: 'helper.py', referenceCount: references.result.length, diagnosticsVersions: [...new Set(f.events.filter(event => event.kind === 'diagnostics').map(event => event.version))] };
  const evidenceDir = path.resolve('.iexa-artifacts/python-language-20261108'); fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'real-lsp-validation.json'), JSON.stringify(summary, null, 2) + '\n');
  await f.request({ method: 'release' }); await until(() => !alive(opened.pid));
  assert.equal(f.service.getStatus().pid, undefined);
});
