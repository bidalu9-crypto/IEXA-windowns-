'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter, getEventListeners } = require('node:events');
const ts = require('typescript');

// Compile only in memory: no desktop/native PTY, external service, dist writes,
// or dependence on the centrally removed original test suite.
function loader(mocks = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(__dirname, '..', file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = new Module(file, module);
    cache.set(file, mod);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod.require = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id.startsWith('.')) {
        const target = path.resolve(path.dirname(file), id);
        if (fs.existsSync(`${target}.ts`)) return load(`${target}.ts`);
      }
      return Module.prototype.require.call(mod, id);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: file,
    }).outputText, file);
    return mod.exports;
  }
  return (name) => load(`src/main/${name}.ts`);
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-lifecycle-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('iexa-lifecycle-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const event = (n) => ({ at: n, name: `event-${n}` });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function childStub() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.write = () => true; child.stdin.end = () => {};
  child.killCount = 0;
  child.kill = () => { child.killCount++; child.emit('close', 0); return true; };
  return child;
}

test('fetch: already cancelled signals (including Request input) never call fetch', async (t) => {
  const { fetchWithRetry } = loader()('providers/stream-utils');
  const controller = new AbortController(); controller.abort();
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  await assert.rejects(fetchWithRetry('https://fixture.invalid', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(fetchWithRetry(new Request('https://fixture.invalid', { signal: controller.signal }), {}), { name: 'AbortError' });
  assert.equal(mock.mock.callCount(), 0);
});

test('fetch: AbortError is terminal without a signal; cancellation stops retry backoff', async (t) => {
  const { fetchWithRetry } = loader()('providers/stream-utils');
  let calls = 0;
  const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
  await assert.rejects(fetchWithRetry('https://fixture.invalid', {}), { name: 'AbortError' });
  assert.equal(calls, 1);
  const controller = new AbortController();
  mock.mock.mockImplementation(async () => { calls++; throw new Error('fetch failed'); });
  const result = fetchWithRetry('https://fixture.invalid', { signal: controller.signal });
  await tick();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const reason = new Error('user stopped'); controller.abort(reason);
  await assert.rejects(result, (error) => error === reason);
  assert.equal(calls, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('fetch: retry status bodies are cancelled, never buffered; final response remains readable', async (t) => {
  const utils = loader()('providers/stream-utils'); utils.STREAM_RETRY_DELAYS_MS.fill(1);
  let calls = 0; let cancels = 0;
  const controller = new AbortController();
  const final = { ok: true, status: 200 };
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? {
    ok: false, status: 503,
    arrayBuffer() { throw new Error('must not drain'); },
    body: { cancel() { cancels++; return new Promise(() => {}); } },
  } : final);
  assert.equal(await utils.fetchWithRetry('https://fixture.invalid', { signal: controller.signal }), final);
  assert.equal(calls, 2); assert.equal(cancels, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(utils.isRetryableStatus(600), false);
});

test('fetch: abort during in-flight mock request never retries', async (t) => {
  const { fetchWithRetry } = loader()('providers/stream-utils');
  const controller = new AbortController();
  const mock = t.mock.method(globalThis, 'fetch', async (_input, init) => {
    controller.abort('stop');
    assert.equal(init.signal, controller.signal);
    throw new TypeError('fetch failed');
  });
  await assert.rejects(fetchWithRetry('https://fixture.invalid', { signal: controller.signal }), (error) => error === 'stop');
  assert.equal(mock.mock.callCount(), 1);
});

test('retry: preserves explicit non-retryability and recognizes cancellation codes', async () => {
  const load = loader();
  const { ProviderError } = load('providers/ProviderError');
  const { RetryManager } = load('runtime/RetryManager');
  const manager = new RetryManager([1]);
  const original = new ProviderError('CUSTOM', 'network timeout', false);
  assert.equal(ProviderError.from(original), original);
  for (const error of [original, Object.assign(new Error('socket aborted'), { name: 'AbortError' }), { code: 'ABORT_ERR' }]) {
    assert.equal(manager.isRetryable(error), false);
  }
  assert.equal(manager.isRetryable(new Error('terminated')), true);
  let calls = 0;
  await assert.rejects(manager.run(async () => { calls++; throw original; }), (error) => error === original);
  assert.equal(calls, 1);
});

test('retry: sleep cleans listeners on timeout and abort, preserving AgentLoop wake contract', async () => {
  const { RetryManager } = loader()('runtime/RetryManager');
  const manager = new RetryManager(); const controller = new AbortController();
  for (let i = 0; i < 20; i++) await manager.sleep(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = manager.sleep(60_000, controller.signal); controller.abort(); await pending;
  await manager.sleep(60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('retry: run aborts before operations and during backoff, passing signal through', async () => {
  const { RetryManager } = loader()('runtime/RetryManager');
  const manager = new RetryManager([60_000]);
  const controller = new AbortController(); let calls = 0;
  const result = manager.run(async (signal) => {
    assert.equal(signal, controller.signal); calls++; throw new Error('network failed');
  }, undefined, controller.signal);
  await tick(); controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  await assert.rejects(manager.run(async () => { calls++; }, undefined, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('reader timeout cancels the reader and still rejects if cancel completes read synchronously', async () => {
  const { readWithTimeout } = loader()('providers/stream-utils');
  let resolveRead; let cancelled = 0;
  const reader = {
    read: () => new Promise((resolve) => { resolveRead = resolve; }),
    cancel: async () => { cancelled++; resolveRead({ done: true }); },
  };
  await assert.rejects(readWithTimeout(reader, 1), /stream idle timeout/);
  assert.equal(cancelled, 1);
  assert.deepEqual(await readWithTimeout({ read: async () => ({ done: false, value: 'ok' }) }, 60_000), { done: false, value: 'ok' });
});

test('trace: bounded count/bytes, monotonic cursors across eviction and repeated runs', () => {
  const { Trace } = loader()('observability/Trace');
  const trace = new Trace({ maxEvents: 3, maxBytes: 1024, maxEventBytes: 256 });
  let cursor = trace.cursor();
  for (let i = 0; i < 100; i++) {
    trace.event('run', { i });
    assert.equal(trace.since(cursor).length, 1);
    cursor = trace.cursor();
    assert.ok(trace.snapshot().length <= 3);
  }
  assert.equal(trace.cursor(), 100); assert.equal(trace.oldestCursor(), 97);
  assert.deepEqual(trace.since(0).map((value) => value.data.i), [97, 98, 99]);
  assert.deepEqual(trace.since(cursor), []);
  trace.event('large', { text: 'x'.repeat(100_000) });
  assert.equal(trace.snapshot().at(-1).data.truncated, true);
  const snapshot = trace.snapshot(); snapshot[0].data.i = 'mutated';
  assert.notEqual(trace.snapshot()[0].data.i, 'mutated');
  assert.ok(Buffer.byteLength(JSON.stringify(trace.snapshot())) < 1024);
  assert.throws(() => new Trace({ maxEvents: NaN }), RangeError);
});

test('trace: byte quota evicts, secrets redact, circular data does not break runtime', () => {
  const { Trace } = loader()('observability/Trace');
  const trace = new Trace({ maxEvents: 100, maxBytes: 256, maxEventBytes: 128 });
  for (let i = 0; i < 100; i++) trace.event('s', { apiKey: 'sk-1234567890' });
  assert.ok(trace.snapshot().length < 100);
  assert.ok(!JSON.stringify(trace.snapshot()).includes('sk-1234567890'));
  assert.ok(trace.snapshot().reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) <= 256);
  const cyclic = {}; cyclic.self = cyclic; trace.event('circular', cyclic);
  assert.equal(trace.snapshot().at(-1).name, 'trace_event_unserializable');
});

test('trace store: bounded byte reads, partial head/tail and malformed records', (t) => {
  const root = temporary(t); const file = path.join(root, 'session.jsonl');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, Buffer.from('\n' + [event(1), event(2)].map(JSON.stringify).join('\n') + '\n{broken}\n{"at":3,'), 0,
    Buffer.byteLength('\n' + [event(1), event(2)].map(JSON.stringify).join('\n') + '\n{broken}\n{"at":3,'), 8 * 1024 * 1024);
  fs.closeSync(fd);
  let requested = 0; let opened = 0; let closed = 0;
  const mockFs = { ...fs,
    readFileSync() { throw new Error('full file read forbidden'); },
    openSync(...args) { opened++; return fs.openSync(...args); },
    closeSync(...args) { closed++; return fs.closeSync(...args); },
    readSync(fd, buffer, offset, length, position) { requested += length; return fs.readSync(fd, buffer, offset, length, position); },
  };
  const { TraceStore } = loader({ fs: mockFs })('observability/TraceStore');
  const store = new TraceStore(root, { maxReadBytes: 256 });
  assert.deepEqual(store.read('session', 100), [event(1), event(2)]);
  assert.ok(requested <= 256); assert.equal(opened, closed);
  assert.deepEqual(store.read('missing'), []);
  assert.deepEqual(store.read('session', 0), []);
  assert.throws(() => store.read('../escape'), /Invalid session/);
  assert.throws(() => new TraceStore(root, { maxReadBytes: Infinity }), RangeError);
});

test('trace store: rotation limits files/bytes, reads backups chronologically, repairs partial append', (t) => {
  const root = temporary(t);
  const { TraceStore } = loader()('observability/TraceStore');
  const store = new TraceStore(root, { maxFileBytes: 100, maxReadBytes: 500, maxFiles: 3 });
  store.append('session', Array.from({ length: 40 }, (_, index) => event(index)));
  const files = fs.readdirSync(root);
  assert.equal(files.length, 3);
  for (const file of files) assert.ok(fs.statSync(path.join(root, file)).size <= 100);
  const records = store.read('session');
  assert.ok(records.length > 3); assert.deepEqual(records, records.slice().sort((a, b) => a.at - b.at));
  assert.equal(records.at(-1).at, 39);
  store.append('session', [{ at: 100, name: 'oversized'.repeat(100) }]);
  assert.equal(store.read('session').at(-1).at, 39);
  fs.appendFileSync(path.join(root, 'session.jsonl'), '{"at":');
  store.append('session', [event(40)]);
  assert.equal(store.read('session').at(-1).at, 40);
  const single = new TraceStore(root, { maxFileBytes: 100, maxFiles: 1 });
  single.append('single', Array.from({ length: 10 }, (_, index) => event(index)));
  assert.equal(single.read('single').at(-1).at, 9);
  assert.ok(!fs.existsSync(path.join(root, 'single.jsonl.1')));
});

test('child environment: explicit portable paths/config retained; mixed-case credentials and hooks dropped', () => {
  const { createChildEnvironment } = loader()('security/ChildEnvironment');
  const source = { Path: 'C:\\tools', PATH: 'duplicate', SystemRoot: 'C:\\Windows', HOME: '/home/test', APPDATA: '/config',
    PYTHONPATH: '/modules', JAVA_HOME: '/java', XDG_CONFIG_HOME: '/xdg', NODE_EXTRA_CA_CERTS: '/ca.pem',
    OPENAI_API_KEY: 'secret', anthropic_api_key: 'secret', GH_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
    IEXA_AUTH_TOKEN: 'secret', arbitrary_config: 'secret', HTTP_PROXY: 'https://user:pass@proxy',
    NODE_OPTIONS: '--require steal', LD_PRELOAD: '/steal', SSH_AUTH_SOCK: '/agent', Undefined: undefined };
  const child = createChildEnvironment(source);
  assert.deepEqual(Object.keys(child).sort(), ['Path', 'SystemRoot', 'HOME', 'APPDATA', 'PYTHONPATH', 'JAVA_HOME', 'XDG_CONFIG_HOME', 'NODE_EXTRA_CA_CERTS'].sort());
  assert.equal(child.Path, source.Path); assert.ok(!JSON.stringify(child).includes('secret'));
  child.Path = 'changed'; assert.equal(source.Path, 'C:\\tools');
});

test('plugin: sanitized spawn, pre-abort avoids spawn, cancellation cleans listeners, output cap terminates', async (t) => {
  const root = temporary(t); const calls = [];
  const load = loader({ child_process: { spawn: (...args) => { const child = childStub(); calls.push({ args, child }); return child; } } });
  const { PluginManager } = load('plugins/PluginManager');
  const manager = new PluginManager(root);
  const controller = new AbortController(); controller.abort();
  assert.equal((await manager.runPlugin(path.join(root, 'entry.js'), {}, controller.signal)).success, false);
  assert.equal(calls.length, 0);
  const previousSecret = process.env.LIFECYCLE_TEST_SECRET_TOKEN;
  process.env.LIFECYCLE_TEST_SECRET_TOKEN = 'secret';
  t.after(() => { if (previousSecret === undefined) delete process.env.LIFECYCLE_TEST_SECRET_TOKEN; else process.env.LIFECYCLE_TEST_SECRET_TOKEN = previousSecret; });
  const live = new AbortController();
  const pending = manager.runPlugin(path.join(root, 'entry.js'), {}, live.signal);
  assert.equal(calls[0].args[2].env.LIFECYCLE_TEST_SECRET_TOKEN, undefined);
  assert.equal(calls[0].args[2].env.ELECTRON_RUN_AS_NODE, '1');
  live.abort(); assert.equal((await pending).success, false);
  assert.equal(getEventListeners(live.signal, 'abort').length, 0);
  assert.equal(calls[0].child.killCount, 1);
  const tooLarge = manager.runPlugin(path.join(root, 'entry.js'), {});
  calls[1].child.stdout.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal((await tooLarge).success, false);
  assert.equal(calls[1].child.killCount, 1);
});

test('MCP: sanitized spawn, process exit promptly rejects and clears pending requests', async (t) => {
  const root = temporary(t); const child = childStub(); let options;
  const { McpManager } = loader({ child_process: { spawn: (_cmd, _args, opts) => { options = opts; return child; } } })('mcp/McpManager');
  const manager = new McpManager(path.join(root, 'mcp.json'));
  const config = manager.add({ name: 'fixture', transport: 'stdio', command: 'fixture-executable', enabled: true });
  const previousSecret = process.env.LIFECYCLE_TEST_SECRET_TOKEN;
  process.env.LIFECYCLE_TEST_SECRET_TOKEN = 'secret';
  t.after(() => { if (previousSecret === undefined) delete process.env.LIFECYCLE_TEST_SECRET_TOKEN; else process.env.LIFECYCLE_TEST_SECRET_TOKEN = previousSecret; });
  const request = manager.request(config, 'tools/list', {});
  assert.equal(options.env.LIFECYCLE_TEST_SECRET_TOKEN, undefined);
  const connection = manager.connections.get(config.id);
  assert.equal(connection.pending.size, 1);
  child.emit('close', 1);
  await assert.rejects(request, /process closed/);
  assert.equal(connection.pending.size, 0);
  assert.equal(manager.connections.size, 0);
});

test('MCP: disconnect clears pending timer/map and oversized partial output kills child', async (t) => {
  const root = temporary(t); const children = [];
  const { McpManager } = loader({ child_process: { spawn: () => { const child = childStub(); children.push(child); return child; } } })('mcp/McpManager');
  const manager = new McpManager(path.join(root, 'mcp.json'));
  const config = manager.add({ name: 'fixture', transport: 'stdio', command: 'fixture', enabled: true });
  const pending = manager.request(config, 'tools/list', {}); const connection = manager.connections.get(config.id);
  manager.disconnect(config.id); await assert.rejects(pending, /断开/);
  assert.equal(connection.pending.size, 0);
  const overflow = manager.request(config, 'tools/list', {});
  children[1].stdout.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1, 120));
  await assert.rejects(overflow, /exceeds 8 MB/);
  assert.equal(children[1].killCount, 1);
});

function terminalFixture() {
  const terminals = [];
  const { TerminalManager } = loader({ 'node-pty': { spawn: () => {
    const pty = { pid: 123, disposed: 0,
      onData(fn) { this.data = fn; return { dispose: () => this.disposed++ }; },
      onExit(fn) { this.exit = fn; return { dispose: () => this.disposed++ }; },
      kill() { this.exit({ exitCode: 0 }); }, write() {}, resize() {},
    }; terminals.push(pty); return pty;
  } }, child_process: { spawn() { throw new Error('No real subprocess expected'); } } })('terminals/TerminalManager');
  return { TerminalManager, terminals };
}

test('terminal: active cap checked before spawn, exit frees slots and shutdown disposes subscriptions', async () => {
  const { TerminalManager, terminals } = terminalFixture(); const manager = new TerminalManager(2);
  const first = manager.create('.'); manager.create('.');
  assert.throws(() => manager.create('.'), /limit/); assert.equal(terminals.length, 2);
  await manager.terminate(first.id); manager.create('.');
  assert.equal(terminals[0].disposed, 2);
  await manager.shutdown(); assert.deepEqual(manager.list(), []);
  assert.ok(terminals.every((pty) => pty.disposed === 2));
  assert.throws(() => new TerminalManager(0), RangeError);
});

test('terminal: oversized UTF-8 output, tiny chunks and ended history are bounded', () => {
  const { TerminalManager, terminals } = terminalFixture(); const manager = new TerminalManager(1);
  const info = manager.create('.');
  terminals[0].data('界'.repeat(1024 * 1024));
  let text = manager.output(info.id).chunks.map((chunk) => chunk.text).join('');
  assert.ok(Buffer.byteLength(text) <= 1024 * 1024); assert.ok(!text.includes('\ufffd'));
  for (let i = 0; i < 10_000; i++) terminals[0].data('x');
  assert.ok(manager.output(info.id).chunks.length <= 4096);
  terminals[0].exit({ exitCode: 0 });
  for (let i = 0; i < 25; i++) { manager.create('.'); terminals.at(-1).exit({ exitCode: 0 }); }
  assert.ok(manager.list().length <= 20);
  manager.shutdownSync();
});

test('trace store: legacy oversized files compact to recent records, append batches avoid per-event writes', (t) => {
  const root = temporary(t); const file = path.join(root, 'legacy.jsonl');
  fs.writeFileSync(file, Array.from({ length: 1000 }, (_, index) => JSON.stringify(event(index))).join('\n') + '\n');
  let reads = 0; let writes = 0;
  const { TraceStore } = loader({ fs: { ...fs,
    readSync(fd, buffer, offset, length, position) { reads += length; return fs.readSync(fd, buffer, offset, length, position); },
    appendFileSync(...args) { writes++; return fs.appendFileSync(...args); },
  } })('observability/TraceStore');
  const store = new TraceStore(root, { maxFileBytes: 512, maxReadBytes: 256, maxFiles: 2 });
  store.append('legacy', [event(1000)]);
  assert.ok(reads <= 257);
  assert.ok(fs.statSync(file).size <= 512);
  assert.ok(store.read('legacy').some((item) => item.at === 999));
  assert.equal(store.read('legacy').at(-1).at, 1000);
  const batchStore = new TraceStore(root); writes = 0;
  batchStore.append('batch', Array.from({ length: 100 }, (_, index) => event(index)));
  assert.equal(writes, 1);
});

test('retry: abort from onRetry prevents backoff timer and all subsequent operations', async (t) => {
  const { RetryManager } = loader()('runtime/RetryManager');
  const manager = new RetryManager([60_000]); const controller = new AbortController(); let calls = 0;
  const timers = t.mock.method(globalThis, 'setTimeout');
  await assert.rejects(manager.run(async () => { calls++; throw new Error('network'); },
    () => controller.abort(), controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(timers.mock.callCount(), 0);
});

test('terminal: prompt exit clears grace timers and failed spawn does not consume a slot', async (t) => {
  const { TerminalManager } = terminalFixture(); const manager = new TerminalManager(1);
  const info = manager.create('.');
  const timers = t.mock.method(globalThis, 'setTimeout'); const cleared = t.mock.method(globalThis, 'clearTimeout');
  await manager.terminate(info.id);
  for (const call of timers.mock.calls) assert.ok(cleared.mock.calls.some((entry) => entry.arguments[0] === call.result));
  let calls = 0;
  const { TerminalManager: FailingManager } = loader({ 'node-pty': { spawn() { calls++; throw new Error('spawn failure'); } } })('terminals/TerminalManager');
  const failing = new FailingManager(1);
  assert.throws(() => failing.create('.'), /spawn failure/);
  assert.throws(() => failing.create('.'), /spawn failure/);
  assert.equal(calls, 2); assert.deepEqual(failing.list(), []);
});

test('MCP: pending quota and synchronous stdin failure leave no dangling timers', async (t) => {
  const root = temporary(t); const child = childStub();
  const { McpManager } = loader({ child_process: { spawn: () => child } })('mcp/McpManager');
  const manager = new McpManager(path.join(root, 'mcp.json'));
  const config = manager.add({ name: 'fixture', transport: 'stdio', command: 'fixture', enabled: true });
  child.stdin.write = () => { throw new Error('broken stdin'); };
  await assert.rejects(manager.request(config, 'tools/list', {}), /broken stdin/);
  const connection = manager.connections.get(config.id); assert.equal(connection.pending.size, 0);
  child.stdin.write = () => true;
  const pending = Array.from({ length: 128 }, () => manager.request(config, 'tools/list', {}));
  const results = Promise.allSettled(pending);
  await assert.rejects(manager.request(config, 'tools/list', {}), /pending request limit/);
  manager.disconnect(config.id);
  assert.ok((await results).every((result) => result.status === 'rejected'));
  assert.equal(connection.pending.size, 0);
});
