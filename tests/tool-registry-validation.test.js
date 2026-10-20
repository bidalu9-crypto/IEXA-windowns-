'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolRegistry } = require('../dist/main/runtime/ToolRegistry');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');

function definition(name = 'fixture') {
  return {
    name, description: 'fixture', required: ['title', 'mode', 'count', 'enabled', 'items', 'target'],
    parameters: {
      title: { type: 'string', description: '' },
      mode: { type: 'string', description: '', enumValues: ['one', 'two'] },
      count: { type: 'integer', description: '', minimum: 1, maximum: 10 },
      enabled: { type: 'boolean', description: '' },
      items: { type: 'array', description: '', items: { type: 'string', description: '' } },
      target: { type: 'object', description: '', properties: { name: { type: 'string', description: '' } }, required: ['name'] },
      open: { type: 'object', description: '' },
    },
    risk: 'low', parallelSafe: true, cancellable: false, requiresApproval: false,
    execute: async () => ({ success: true, output: 'executed' }),
  };
}

function valid() {
  return { title: 'x', mode: 'one', count: 1, enabled: true, items: ['a'], target: { name: 'button' }, open: { nested: [1, 'x', false, null] } };
}

test('registry recursively enforces declared types, enums, required fields and unknown keys', () => {
  const registry = new ToolRegistry(); registry.register(definition());
  assert.doesNotThrow(() => registry.validate('fixture', valid()));
  const invalid = [
    [{ ...valid(), title: 3 }, /title.*string/],
    [{ ...valid(), mode: 'three' }, /mode.*one, two/],
    [{ ...valid(), count: 1.5 }, /count.*safe integer/],
    [{ ...valid(), count: Number.MAX_SAFE_INTEGER + 1 }, /count.*safe integer/],
    [{ ...valid(), enabled: 'false' }, /enabled.*boolean/],
    [{ ...valid(), items: ['a', 2] }, /items\[1\].*string/],
    [{ ...valid(), target: {} }, /target\.name/],
    [{ ...valid(), target: { name: 'x', id: 'surprise' } }, /target\.id/],
    [{ ...valid(), title: null }, /required argument: title/],
    [{ ...valid(), open: undefined }, /open.*object/],
    [{ ...valid(), target: { name: null } }, /required argument: target\.name/],
    [{ ...valid(), surprise: true }, /surprise/],
  ];
  for (const [args, expected] of invalid) assert.throws(() => registry.validate('fixture', args), expected);
});

test('open object payloads remain supported but reject non-finite and excessively deep values', () => {
  const registry = new ToolRegistry(); registry.register(definition());
  assert.doesNotThrow(() => registry.validate('fixture', valid()));
  assert.throws(() => registry.validate('fixture', { ...valid(), open: { value: Number.NaN } }), /finite/);
  let nested = {}; let cursor = nested;
  for (let i = 0; i < 20; i++) cursor = cursor.next = {};
  assert.throws(() => registry.validate('fixture', { ...valid(), open: nested }), /nesting depth/);
});

test('runtime resolves the edit alias before validation, approvals and execution', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-alias-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let approvals = 0;
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory'), permissionMode: 'full', permissionResolver: async () => { approvals++; return 'allow_once'; } });
  runtime.registerDefaults();
  fs.writeFileSync(path.join(root, 'sample.txt'), 'alpha\n', 'utf8');
  const result = await runtime.execute('edit', { tool_title: 'fix sample', path: 'sample.txt', old_string: 'alpha', new_string: 'beta' },
    { workspaceDir: root, sessionId: 'alias', toolCallId: 'alias-1', signal: new AbortController().signal });
  assert.equal(result.success, true, result.output);
  assert.equal(fs.readFileSync(path.join(root, 'sample.txt'), 'utf8'), 'beta\n');
  const unknown = await runtime.execute('edit_file', { tool_title: 'x', path: 'sample.txt', old_string: 'beta', new_string: 'gamma' },
    { workspaceDir: root, sessionId: 'alias', toolCallId: 'alias-2', signal: new AbortController().signal });
  assert.equal(unknown.success, true, unknown.output);
  assert.equal(approvals, 0, 'file edits stay on the low-risk path');
});

test('runtime rejects malformed calls before approvals or side effects across built-in tools', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-schema-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let approvals = 0;
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory'), permissionMode: 'full', permissionResolver: async () => { approvals++; return 'allow_once'; } });
  runtime.registerDefaults();
  let shellCalls = 0, desktopCalls = 0;
  runtime.shell.execute = async () => { shellCalls++; return { success: true, output: 'shell' }; };
  runtime.desktop.execute = async () => { desktopCalls++; return { success: true, output: '{}' }; };
  const context = id => ({ workspaceDir: root, sessionId: 'schema', toolCallId: id, signal: new AbortController().signal });
  const cases = [
    ['shell_execute', { tool_title: 'x', command: 'echo x', timeout: '1' }],
    ['shell_execute', { tool_title: 'x', command: 'echo x', shell: 'bash' }],
    ['file_write', { tool_title: 'x', path: 'x.txt', content: 'x', append: 'false' }],
    ['file_read', { tool_title: 'x', path: 'x.txt', direction: 'sideways' }],
    ['browser_fetch', { tool_title: 'x', url: 'https://example.test', max_length: 1.5 }],
    ['web_search', { tool_title: 'x', query: 'query', limit: Number.NaN }],
    ['memory_get', { tool_title: 'x', limit: '20' }],
    ['desktop_control', { tool_title: 'x', action: 'observe', background: 'false' }],
    ['todo_write', { todos: [{ content: 'x', status: 'running' }] }],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [name, args] = cases[i];
    const result = await runtime.execute(name, args, context(`bad-${i}`));
    assert.equal(result.success, false, `${name} should reject malformed input`);
    assert.match(result.output, /Invalid (?:tool )?argument|Unknown argument|Missing required argument/);
  }
  assert.equal(shellCalls, 0); assert.equal(desktopCalls, 0); assert.equal(approvals, 0);
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
});

test('out-of-range numbers are clamped and the caller is told what changed', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-clamp-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory'), permissionMode: 'full' });
  runtime.registerDefaults();
  const context = id => ({ workspaceDir: root, sessionId: 'clamp', toolCallId: id, signal: new AbortController().signal });

  // The reported case: the model asks for more context than the schema allows.
  fs.writeFileSync(path.join(root, 'sample.txt'), 'one\ntwo\nthree\n', 'utf8');
  const grep = await runtime.execute('grep', { tool_title: 'grep sample', pattern: 'two', path: 'sample.txt', context_lines: 6 },
    context('clamp-1'));
  assert.equal(grep.success, true, grep.output);
  assert.match(grep.output, /two/, 'the search still ran');
  assert.match(grep.output, /arguments adjusted: context_lines 6 → 3 \(maximum is 3\)/);

  // Registry-level contract: the value is normalised in place and reported.
  const registry = new ToolRegistry(); registry.register(definition());
  const args = { ...valid(), count: 99 };
  const notes = registry.validate('fixture', args);
  assert.equal(args.count, 10);
  assert.deepEqual(notes, ['count 99 → 10 (maximum is 10)']);
  const low = { ...valid(), count: 0 };
  assert.deepEqual(registry.validate('fixture', low), ['count 0 → 1 (minimum is 1)']);
  assert.equal(low.count, 1);
});

test('malformed optional values are rejected before call-id deduplication', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-schema-dedup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory'), permissionMode: 'full' });
  runtime.registerDefaults();
  const context = { workspaceDir: root, sessionId: 'schema', toolCallId: 'same-id', signal: new AbortController().signal };
  const malformed = await runtime.execute('file_read', { tool_title: 'read', path: 'missing.txt', lines: undefined }, context);
  assert.equal(malformed.success, false); assert.match(malformed.output, /lines.*integer/);
  const valid = await runtime.execute('file_read', { tool_title: 'read', path: 'missing.txt' }, context);
  assert.equal(valid.success, false); assert.match(valid.output, /file not found|ENOENT/);
  assert.doesNotMatch(valid.output, /reused/);
});

test('desktop batch open action objects pass schema validation for session-level checks', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-schema-batch-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory'), permissionMode: 'full' });
  runtime.registerDefaults();
  let received;
  runtime.desktop.execute = async args => { received = args; return { success: true, output: '{}' }; };
  const result = await runtime.execute('desktop_control', { tool_title: 'batch', action: 'batch', actions: [{ action: 'click', target: { name: 'Save', role: 'button' } }] }, { workspaceDir: root, sessionId: 'schema', toolCallId: 'batch', signal: new AbortController().signal });
  assert.equal(result.success, true, result.output); assert.equal(received.actions[0].target.name, 'Save');
});
