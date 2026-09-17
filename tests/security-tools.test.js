'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { PathSandbox, resolveScopedPath, resolveScopedPathAsync } = require('../dist/main/security/PathSandbox');
const { NetworkPolicy, normalizeIp, isPublicIp } = require('../dist/main/security/NetworkPolicy');
const { CommandPolicy } = require('../dist/main/tools/shell/CommandPolicy');
const { FileTools, BrowserFetch, buildMediaDisplayResult } = require('../dist/main/tools/ToolExecutors');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-security-tools-')));
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'workspace-other');
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside\nsecond line');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  t.after(() => {
    // Resolve and verify the deletion target, and never delete outside the fixture.
    assert.equal(path.dirname(path.resolve(base)), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('iexa-security-tools-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, workspace, outside };
}
const code = (expected) => (err) => err.code === expected;
async function rejectBoth(input, roots, allowMissing, expected) {
  assert.throws(() => resolveScopedPath(input, roots, allowMissing), expected && code(expected));
  await assert.rejects(resolveScopedPathAsync(input, roots, allowMissing), expected && code(expected));
}

test('sync and async path policies use canonical roots and retain relative-path interfaces', async (t) => {
  const { workspace } = fixture(t);
  const expected = fs.realpathSync.native(path.join(workspace, 'inside.txt'));
  assert.equal(resolveScopedPath('./inside.txt', [workspace]), expected);
  assert.equal(await resolveScopedPathAsync('inside.txt', [workspace]), expected);
  const policy = { workspaceDir: workspace };
  const sandbox = new PathSandbox();
  assert.deepEqual(await sandbox.resolve('inside.txt', policy), sandbox.resolveSync('inside.txt', policy));
  assert.equal(resolveScopedPath('.', [workspace]), fs.realpathSync.native(workspace));
});

test('workspace traversal, absolute escapes and sibling-prefix tricks are rejected', async (t) => {
  const { workspace, outside } = fixture(t);
  for (const input of ['../workspace-other/secret.txt', path.join(outside, 'secret.txt')]) {
    await rejectBoth(input, [workspace], false, 'PATH_OUTSIDE');
  }
  await rejectBoth('../workspace-other/new/deep/file.txt', [workspace], true, 'PATH_OUTSIDE');
  assert.throws(() => resolveScopedPath('anything', []), code('PATH_ROOT'));
});

test('selected roots are explicit; full mode requires explicit permissionMode full', async (t) => {
  const { workspace, outside } = fixture(t);
  const file = path.join(outside, 'secret.txt');
  assert.equal(resolveScopedPath(file, [workspace, outside]), fs.realpathSync.native(file));
  const sandbox = new PathSandbox();
  assert.equal((await sandbox.resolve(file, { workspaceDir: workspace, mode: 'selected-roots', roots: [outside] })).path, fs.realpathSync.native(file));
  await assert.rejects(sandbox.resolve('inside.txt', { workspaceDir: workspace, mode: 'selected-roots', roots: [outside] }), code('PATH_OUTSIDE'));
  await assert.rejects(sandbox.resolve(file, { workspaceDir: workspace, mode: 'full' }), code('PATH_MODE'));
  assert.equal((await sandbox.resolve(file, { workspaceDir: workspace, permissionMode: 'full' })).path, fs.realpathSync.native(file));
});

test('missing suffixes use existing real parents; ENOTDIR and dangling links fail closed', async (t) => {
  const { workspace } = fixture(t);
  const target = path.join(workspace, 'new', 'deep', 'file.txt');
  assert.equal(resolveScopedPath('new/deep/file.txt', [workspace], true), target);
  assert.equal(await resolveScopedPathAsync(target, [workspace], true), target);
  await rejectBoth(target, [workspace], false, 'ENOENT');
  await rejectBoth('inside.txt/child', [workspace], true);
  fs.symlinkSync(path.join(workspace, 'absent'), path.join(workspace, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejectBoth('dangling/deep/new.txt', [workspace], true, 'PATH_LINK');
});

test('junction/symlink escape is denied for existing files and missing nested parents', async (t) => {
  const { workspace, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejectBoth('escape/secret.txt', [workspace], false, 'PATH_OUTSIDE');
  await rejectBoth('escape/new/deep/file.txt', [workspace], true, 'PATH_OUTSIDE');
  assert.equal(resolveScopedPath('escape/secret.txt', [workspace, outside]), fs.realpathSync.native(path.join(outside, 'secret.txt')));
  fs.symlinkSync(workspace, path.join(workspace, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveScopedPath('inside-link/inside.txt', [workspace]), fs.realpathSync.native(path.join(workspace, 'inside.txt')));
});

test('Windows path namespaces, ADS, reserved devices and ambiguous components are rejected', async (t) => {
  const { workspace } = fixture(t);
  for (const input of ['\\\\server\\share\\file', '//server/share/file', '\\\\?\\C:\\file', '\\\\.\\C:\\file', '\\??\\C:\\file', 'C:relative', 'C:', 'inside.txt:stream', 'NUL.txt', 'COM1', 'folder./file', 'folder /file', 'a\0b']) {
    await rejectBoth(input, [workspace], true);
  }
  await assert.rejects(new PathSandbox().resolve('//server/share/file', { workspaceDir: workspace, permissionMode: 'full', allowMissing: true }), code('PATH_NETWORK'));
});

test('internal app paths are blocked both lexically and through aliases, except explicit full tools', async (t) => {
  const { workspace } = fixture(t);
  const internal = path.join(workspace, '.iexa-config');
  fs.mkdirSync(internal); fs.writeFileSync(path.join(internal, 'config.json'), '{}');
  await rejectBoth('.iexa-config/config.json', [workspace], false, 'PATH_INTERNAL');
  await rejectBoth('.IEXA-other/new.txt', [workspace], true, 'PATH_INTERNAL');
  await rejectBoth('.iexa-config/../inside.txt', [workspace], false, 'PATH_INTERNAL');
  fs.symlinkSync(internal, path.join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejectBoth('alias/config.json', [workspace], false, 'PATH_INTERNAL');
  assert.equal((await new PathSandbox().resolve('.iexa-config/config.json', { workspaceDir: workspace, permissionMode: 'full' })).path, fs.realpathSync.native(path.join(internal, 'config.json')));
});

test('Windows case-insensitive containment still distinguishes sibling roots', { skip: process.platform !== 'win32' }, async (t) => {
  const { workspace, outside } = fixture(t);
  assert.equal(resolveScopedPath(path.join(workspace, 'inside.txt').toUpperCase(), [workspace.toUpperCase()]).toLowerCase(), path.join(workspace, 'inside.txt').toLowerCase());
  await rejectBoth(path.join(outside, 'secret.txt').toUpperCase(), [workspace.toUpperCase()], false, 'PATH_OUTSIDE');
});

test('direct FileTools and media interfaces enforce containment and preserve valid read/write/edit', async (t) => {
  const { workspace, outside } = fixture(t);
  const tools = new FileTools();
  assert.equal((await tools.readFile('../workspace-other/secret.txt', workspace)).success, false);
  assert.equal((await tools.writeFile('../workspace-other/new.txt', 'no', workspace)).success, false);
  assert.equal((await tools.editFile('../workspace-other/secret.txt', 'outside', 'no', workspace)).success, false);
  assert.equal((await buildMediaDisplayResult(path.join(outside, 'secret.txt'), workspace)).success, false);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.equal((await tools.writeFile('new/deep/file.txt', 'first', workspace, { createDirs: true })).success, true);
  assert.equal((await tools.writeFile('new/deep/file.txt', ' second', workspace, { append: true })).success, true);
  assert.equal((await tools.editFile('new/deep/file.txt', 'second', 'last', workspace)).success, true);
  assert.match((await tools.readFile('new/deep/file.txt', workspace)).output, /first last/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside secret');
  assert.equal((await new FileTools({ permissionMode: 'full' }).readFile(path.join(outside, 'secret.txt'), workspace)).success, true);
});

test('file writes recheck the scope after waiting for the write lock', async (t) => {
  const { workspace, outside } = fixture(t);
  const tools = new FileTools();
  const parent = path.join(workspace, 'parent'); fs.mkdirSync(parent);
  let release;
  const { withFileLocks } = require('../dist/main/tools/FileWriteLocks');
  let locked; const acquired = new Promise(resolve => { locked = resolve; });
  const holding = withFileLocks([path.join(parent, 'new.txt')], () => new Promise(resolve => { release = resolve; locked(); }));
  await acquired;
  const writing = tools.writeFile('parent/new.txt', 'blocked', workspace);
  fs.rmdirSync(parent);
  fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
  release();
  await holding;
  assert.equal((await writing).success, false);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

test('legacy fixed executors share the hardened implementations', () => {
  const legacy = require('../dist/main/tools/ToolExecutors_fixed');
  const current = require('../dist/main/tools/ToolExecutors');
  for (const name of ['ShellExecutor', 'FileTools', 'MemoryTools', 'BrowserFetch', 'buildMediaDisplayResult']) assert.equal(legacy[name], current[name]);
});

function runtimeFixture(t, extra = {}) {
  const dirs = fixture(t);
  const runtime = new ToolRuntime({ workspaceDir: dirs.workspace, memoryDir: path.join(dirs.workspace, 'memory'), ...extra });
  runtime.registerDefaults();
  const execute = runtime.execute.bind(runtime);
  runtime.execute = (name, args, context) => execute(name, { tool_title: 'Security fixture', ...args }, context);
  const context = { workspaceDir: dirs.workspace, sessionId: 'offline-test', toolCallId: 'call', signal: new AbortController().signal };
  return { ...dirs, runtime, context };
}

test('all arbitrary shell forms classify high, not just blacklisted commands', () => {
  const policy = new CommandPolicy();
  for (const command of ['echo hello', 'git status', 'Get-Content file', 'powershell.exe -EncodedCommand AAAA', 'python -c "print(1)"', 'node script.js', 'cmd /c echo hello', 'unknown-program --anything']) assert.equal(policy.classify(command), 'high');
  assert.throws(() => policy.classify('  '), code('COMMAND_EMPTY'));
});

test('risk shell requires per-command approval even after allow_session or a legacy grant', async (t) => {
  const approvals = []; let executed = 0;
  const { runtime, context } = runtimeFixture(t, { permissionResolver: async (request) => { approvals.push(request); return approvals.length === 1 ? 'allow_session' : 'deny'; } });
  runtime.shell.execute = async () => { executed++; return { output: 'fixture', success: true }; };
  assert.equal((await runtime.execute('shell_execute', { command: 'echo first' }, { ...context, toolCallId: 'first' })).success, true);
  runtime.grantPermission(context.sessionId, 'shell_execute');
  const denied = await runtime.execute('shell_execute', { command: 'echo second' }, { ...context, toolCallId: 'second' });
  assert.equal(denied.success, false); assert.equal(denied.executionStatus, 'denied');
  assert.equal(approvals.length, 2); assert.equal(executed, 1);
  assert.equal(approvals[0].tool.risk, 'high'); assert.equal(approvals[0].tool.requiresApproval, true);
  assert.equal(approvals[1].args.command, 'echo second');
  assert.ok(runtime.getToolExecutions().some(e => e.id === 'second' && e.status === 'denied'));
});

test('risk shell denies without a resolver; explicit full mode and subsequent downgrade take effect', async (t) => {
  const { runtime, context } = runtimeFixture(t);
  let executed = 0;
  runtime.shell.execute = async () => { executed++; return { output: 'fixture', success: true }; };
  const first = await runtime.execute('shell_execute', { command: 'echo denied' }, { ...context, toolCallId: 'risk-before' });
  assert.equal(first.success, false); assert.equal(first.executionStatus, 'denied'); assert.equal(executed, 0);
  runtime.setPermissionMode('full');
  assert.equal((await runtime.execute('shell_execute', { command: 'echo explicit' }, { ...context, toolCallId: 'explicit-full' })).success, true);
  runtime.setPermissionMode('risk');
  const last = await runtime.execute('shell_execute', { command: 'echo denied-again' }, { ...context, toolCallId: 'risk-after' });
  assert.equal(last.success, false); assert.equal(last.executionStatus, 'denied');
  assert.equal(executed, 1);
});

test('runtime paths default to workspace; mode updates reach runtime and direct file execution', async (t) => {
  const { runtime, context, outside, workspace } = runtimeFixture(t);
  const args = { path: path.join(outside, 'secret.txt') };
  const spoofed = await runtime.execute('file_read', { ...args, permissionMode: 'full' }, { ...context, toolCallId: 'spoofed-mode' });
  assert.equal(spoofed.success, false); assert.match(spoofed.output, /Unknown argument: permissionMode/);
  assert.equal((await runtime.execute('file_read', args, { ...context, toolCallId: 'scoped-read' })).success, false);
  runtime.setPermissionMode('full');
  assert.equal((await runtime.execute('file_read', args, { ...context, toolCallId: 'full-read' })).success, true);
  assert.equal((await runtime.execute('file_write', { path: path.join(outside, 'full.txt'), content: 'explicit' }, { ...context, toolCallId: 'full-write' })).success, true);
  assert.equal(fs.readFileSync(path.join(outside, 'full.txt'), 'utf8'), 'explicit');
  runtime.setPermissionMode('risk');
  assert.equal((await runtime.execute('file_read', args, { ...context, toolCallId: 'downgraded-read' })).success, false);
  assert.equal((await runtime.execute('file_write', { path: '.iexa-config/config.json', content: '{}', create_dirs: true }, { ...context, toolCallId: 'internal-write' })).success, false);
  assert.equal(fs.existsSync(path.join(workspace, '.iexa-config')), false);
});

test('permission changes never re-execute a cached call ID or permit its reuse with different arguments', async (t) => {
  const { runtime, context } = runtimeFixture(t); let executed = 0;
  runtime.shell.execute = async () => { executed++; return { success: true, output: 'once' }; };
  const args = { command: 'echo stable' };
  const denied = await runtime.execute('shell_execute', args, context);
  assert.equal(denied.executionStatus, 'denied');
  runtime.setPermissionMode('full');
  assert.strictEqual(await runtime.execute('shell_execute', args, context), denied);
  const conflict = await runtime.execute('shell_execute', { command: 'echo changed' }, context);
  assert.equal(conflict.success, false); assert.equal(conflict.executionStatus, 'failed'); assert.match(conflict.output, /reused with different arguments/);
  assert.equal(executed, 0);
  const next = { ...context, toolCallId: 'fresh-full-call' };
  const result = await runtime.execute('shell_execute', args, next); assert.equal(result.success, true);
  runtime.setPermissionMode('risk');
  assert.strictEqual(await runtime.execute('shell_execute', args, next), result);
  const newDenied = await runtime.execute('shell_execute', args, { ...context, toolCallId: 'fresh-risk-call' });
  assert.equal(newDenied.executionStatus, 'denied'); assert.equal(executed, 1);
});

// A fake HTTPS transport exercises the production request options, pin callback,
// response event handling and destruction without opening any socket or resolver.
function networkFixture(responses, lookupHook) {
  const calls = []; const dns = [];
  const policy = new NetworkPolicy({
    lookup: async (hostname) => { dns.push(hostname); return lookupHook ? lookupHook(hostname, dns.length) : [{ address: '93.184.216.34', family: 4 }]; },
    request: (url, options, callback) => {
      const spec = responses[calls.length];
      assert.ok(spec, 'unexpected outbound request');
      const request = new EventEmitter();
      request.destroyed = false;
      request.destroy = () => { request.destroyed = true; };
      request.end = () => queueMicrotask(() => {
        if (spec.noHeaders || request.destroyed) return;
        const response = new PassThrough();
        response.statusCode = spec.status || 200; response.statusMessage = 'Fixture'; response.headers = spec.headers || { 'content-type': 'text/plain' };
        calls[calls.length - 1].response = response;
        callback(response);
        if (spec.stall || response.destroyed) return;
        for (const chunk of spec.chunks || [Buffer.from('fixture body')]) { if (!response.destroyed) response.write(chunk); }
        if (spec.abort) response.destroy(); else if (!response.destroyed) response.end();
      });
      calls.push({ url, options, request });
      return request;
    },
  });
  return { policy, calls, dns };
}

test('IP normalization rejects mapped loopback, private, reserved and non-global IPv6', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
  assert.equal(normalizeIp('::ffff:5db8:d822'), '93.184.216.34');
  for (const ip of ['0.0.0.0', '10.1.1.1', '100.64.0.1', '127.0.0.1', '169.254.1.2', '172.16.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:c0a8:101', '::127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::7f00:1', '2001::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1', 'fe80::1%eth0', 'not-an-ip']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicIp(ip), true, ip);
});

test('URL policy rejects private literal variants, credentials, HTTP and mixed DNS answers', async () => {
  const { policy, calls } = networkFixture([]);
  for (const url of ['https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://localhost./', 'https://x.localhost/', 'http://example.test/', 'file:///etc/passwd', 'https://user:password@example.test/']) await assert.rejects(policy.fetch(url));
  assert.equal(calls.length, 0);
  const mixed = networkFixture([], () => [{ address: '1.1.1.1', family: 4 }, { address: '::ffff:10.0.0.1', family: 6 }]);
  await assert.rejects(mixed.policy.fetch('https://example.test'), code('SSRF_PRIVATE'));
  const empty = networkFixture([], () => []);
  await assert.rejects(empty.policy.fetch('https://example.test'), code('SSRF_PRIVATE'));
});

test('HTTPS pins the verified address without a second DNS lookup and retains TLS hostname validation', async () => {
  const { policy, calls, dns } = networkFixture([{}], (_host, count) => [{ address: count === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
  const result = await policy.fetch('https://example.test/path');
  assert.equal(result.body.toString(), 'fixture body'); assert.deepEqual(dns, ['example.test']);
  const { options, url } = calls[0];
  assert.equal(url.hostname, 'example.test'); assert.equal(options.servername, 'example.test');
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
  assert.equal(options.headers['Accept-Encoding'], 'identity');
  options.lookup('example.test', {}, (err, address, family) => { assert.equal(err, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
  options.lookup('example.test', { all: true }, (err, records) => { assert.equal(err, null); assert.deepEqual(records, [{ address: '93.184.216.34', family: 4 }]); });
  assert.equal(dns.length, 1);
});

test('manual redirects validate every protocol, host and DNS answer before connecting', async () => {
  for (const location of ['https://127.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'http://example.test/', 'https://user:pass@example.test/']) {
    const f = networkFixture([{ status: 302, headers: { location } }]);
    await assert.rejects(f.policy.fetch('https://example.test'));
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].response.destroyed, true);
  }
  const rebinding = networkFixture([{ status: 302, headers: { location: '/next' } }], (_host, count) => [{ address: count === 1 ? '1.1.1.1' : '127.0.0.1', family: 4 }]);
  await assert.rejects(rebinding.policy.fetch('https://example.test'), code('SSRF_PRIVATE'));
  assert.equal(rebinding.calls.length, 1); assert.equal(rebinding.dns.length, 2);
  const good = networkFixture([{ status: 307, headers: { location: '/next' } }, {}]);
  assert.equal((await good.policy.fetch('https://example.test/start')).url, 'https://example.test/next');
  assert.equal(good.dns.length, 2); assert.equal(good.calls.length, 2);
  const loop = networkFixture([{ status: 301, headers: { location: '/again' } }]);
  await assert.rejects(loop.policy.fetch('https://example.test', { maxRedirects: 0 }), code('REDIRECT_LIMIT'));
});

test('response limits count streamed bytes, not text characters; header and encoding checks are bounded', async () => {
  const f = networkFixture([{ chunks: [Buffer.from('你好'), Buffer.from('!')] }]);
  await assert.rejects(f.policy.fetch('https://example.test', { maxBytes: 6 }), code('RESPONSE_LIMIT'));
  assert.equal(f.calls[0].response.destroyed, true); assert.equal(f.calls[0].request.destroyed, true);
  const exact = networkFixture([{ chunks: [Buffer.from('你好')] }]);
  assert.equal((await exact.policy.fetch('https://example.test', { maxBytes: 6 })).body.length, 6);
  const header = networkFixture([{ headers: { 'content-length': '999' }, stall: true }]);
  await assert.rejects(header.policy.fetch('https://example.test', { maxBytes: 8 }), code('RESPONSE_LIMIT'));
  const compressed = networkFixture([{ headers: { 'content-encoding': 'gzip' } }]);
  await assert.rejects(compressed.policy.fetch('https://example.test'), code('RESPONSE_ENCODING'));
  const premature = networkFixture([{ abort: true }]);
  await assert.rejects(premature.policy.fetch('https://example.test'), code('RESPONSE_ABORTED'));
});

test('timeout covers DNS, response headers and stalled bodies even with an external signal', async () => {
  const dns = networkFixture([], () => new Promise(() => {}));
  await assert.rejects(dns.policy.fetch('https://example.test', { timeoutMs: 15 }), code('NETWORK_TIMEOUT'));
  for (const spec of [{ noHeaders: true }, { stall: true }]) {
    const f = networkFixture([spec]);
    await assert.rejects(f.policy.fetch('https://example.test', { timeoutMs: 15, signal: new AbortController().signal }), code('NETWORK_TIMEOUT'));
    assert.equal(f.calls[0].request.destroyed, true);
  }
});

test('caller cancellation destroys requests and pre-aborted calls do no DNS or network work', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled fixture'));
  const pre = networkFixture([]);
  await assert.rejects(pre.policy.fetch('https://example.test', { signal: controller.signal }), /cancelled fixture/);
  assert.equal(pre.dns.length, 0); assert.equal(pre.calls.length, 0);
  const active = new AbortController(); const f = networkFixture([{ stall: true }]);
  const pending = f.policy.fetch('https://example.test', { signal: active.signal });
  await new Promise((resolve) => setImmediate(resolve)); active.abort(new Error('stop fixture'));
  await assert.rejects(pending, /stop fixture/); assert.equal(f.calls[0].request.destroyed, true);
});

test('BrowserFetch uses the controlled helper once, preserves output interface and rejects HTTP', async () => {
  const f = networkFixture([{ headers: { 'content-type': 'text/html' }, chunks: [Buffer.from('<script>bad()</script><p>Hello world</p>')] }]);
  const browser = new BrowserFetch(f.policy);
  const result = await browser.fetch('example.test', 5);
  assert.equal(result.success, true); assert.match(result.output, /Hello\n\n\[Content truncated/);
  assert.doesNotMatch(result.output, /bad\(\)/); assert.equal(f.dns.length, 1); assert.equal(f.calls.length, 1);
  assert.equal((await browser.fetch('http://example.test')).success, false);
  assert.equal(f.calls.length, 1);
});

test('runtime selected-root policy grants only configured roots, never caller-supplied roots', async (t) => {
  const { workspace, outside } = fixture(t);
  const runtime = new ToolRuntime({ workspaceDir: workspace, memoryDir: path.join(workspace, 'memory'), pathMode: 'selected-roots', selectedRoots: [outside] });
  runtime.registerDefaults();
  const context = { workspaceDir: workspace, sessionId: 'selected', toolCallId: 'call', signal: new AbortController().signal };
  assert.equal((await runtime.execute('file_read', { tool_title: 'fixture', path: path.join(outside, 'secret.txt') }, context)).success, true);
  assert.equal((await runtime.execute('file_read', { tool_title: 'fixture', path: 'inside.txt', roots: [workspace] }, context)).success, false);
});

test('runtime BrowserFetch delegates to one controlled network operation with no preflight DNS', async (t) => {
  const { runtime, context } = runtimeFixture(t);
  const f = networkFixture([{}]);
  runtime.browser = new BrowserFetch(f.policy);
  const result = await runtime.execute('browser_fetch', { url: 'https://offline-fixture.test' }, context);
  assert.equal(result.success, true);
  assert.equal(f.dns.length, 1); assert.equal(f.calls.length, 1);
});

test('public mapped IPv6 normalizes its pinned family and IP literals skip DNS entirely', async () => {
  const mapped = networkFixture([{}], () => [{ address: '::ffff:8.8.8.8', family: 6 }]);
  await mapped.policy.fetch('https://mapped.test');
  mapped.calls[0].options.lookup('mapped.test', {}, (err, address, family) => {
    assert.equal(err, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  const literal = networkFixture([{}]);
  await literal.policy.fetch('https://[2606:4700:4700::1111]/');
  assert.equal(literal.dns.length, 0); assert.equal(literal.calls[0].options.servername, '');
});

test('verified DNS addresses fail over without a second lookup', async () => {
  const attempts = []; let dnsCalls = 0;
  const policy = new NetworkPolicy({
    lookup: async () => { dnsCalls++; return [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ]; },
    request: (url, options, callback) => {
      const request = new EventEmitter(); request.destroyed = false;
      request.destroy = () => { request.destroyed = true; };
      request.end = () => options.lookup(url.hostname, {}, (_error, address, family) => {
        attempts.push({ address, family });
        if (family === 6) {
          const failure = new Error('IPv6 fixture unreachable'); failure.code = 'ENETUNREACH';
          queueMicrotask(() => request.emit('error', failure)); return;
        }
        const response = new PassThrough(); response.statusCode = 200; response.statusMessage = 'OK'; response.headers = { 'content-type': 'text/plain' };
        callback(response); response.end('fallback-ok');
      });
      return request;
    },
  });
  const response = await policy.fetch('https://fixture.test/');
  assert.equal(response.body.toString(), 'fallback-ok');
  assert.equal(dnsCalls, 1);
  assert.deepEqual(attempts, [
    { address: '2606:4700:4700:0:0:0:0:1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ]);
});

test('DNS failures and malformed resolver addresses fail closed before transport', async () => {
  const failed = networkFixture([], () => { throw new Error('fixture DNS failed'); });
  await assert.rejects(failed.policy.fetch('https://fixture.test'), code('DNS_FAILED'));
  const invalid = networkFixture([], () => [{ address: 'invalid', family: 4 }]);
  await assert.rejects(invalid.policy.fetch('https://fixture.test'), code('SSRF_PRIVATE'));
  assert.equal(failed.calls.length + invalid.calls.length, 0);
});
