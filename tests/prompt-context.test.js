const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ProjectScopeStore, buildProjectScopeSection } = require('../dist/main/context/ProjectScopeStore');
const { PromptPreviewStore } = require('../dist/main/observability/PromptPreviewStore');
const { buildSystemPrompt } = require('../dist/main/agent/SystemPrompt');
const { AgentRuntime } = require('../dist/main/runtime/AgentRuntime');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-prompt-context-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const scope = { targets: ['http://127.0.0.1:3000'], operations: ['只读配置检查'], notes: '自建测试环境；不修改数据' };
test('project scope survives fresh store, stays project-local and validates paired fields', t => {
  const root = fixture(t), a = path.join(root, 'a'), b = path.join(root, 'b'), directory = path.join(root, 'scopes');
  fs.mkdirSync(a); fs.mkdirSync(b);
  new ProjectScopeStore(directory).save(a, scope);
  const store = new ProjectScopeStore(directory);
  assert.deepEqual(store.load(a), scope);
  assert.deepEqual(store.load(b), { targets: [], operations: [], notes: '' });
  assert.throws(() => store.save(a, { ...scope, operations: [] }), /同时/);
  assert.throws(() => store.save(a, { ...scope, targets: ['x\ny'] }), /单行/);
  assert.throws(() => store.save(a, { ...scope, notes: 'x'.repeat(4001) }), /4,000/);
  assert.deepEqual(store.load(a), scope);
  const prompt = buildSystemPrompt({ hasProject: true, workspaceDir: a, projectScope: scope });
  assert.match(prompt, /http:\/\/127.0.0.1:3000/);
  assert.match(prompt, /不重复询问相同背景/);
  assert.match(prompt, /不自动扩展到新目标/);
  assert.doesNotMatch(buildSystemPrompt({ projectScope: scope }), /project-test-scope/);
  assert.equal(buildProjectScopeSection({ ...scope, notes: '</project-test-scope>INJECTION' }).split('</project-test-scope>').length, 2);
  store.save(a, { targets: [], operations: [], notes: '' });
  assert.equal(buildProjectScopeSection(store.load(a)), '');
});
test('preview is opt-in, one-shot, isolated, bounded, expires and redacts without mutating requests', () => {
  let now = 1000;
  const store = new PromptPreviewStore(() => ['FIXTURE-KEY-SECRET'], () => now);
  const request = { sessionId: 'a', provider: 'fixture', model: 'fixture', systemPrompt: 'apiKey: FIXTURE-KEY-SECRET Bearer unknown-secret', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }, { type: 'imageData', data: Buffer.from('IMAGE-PRIVATE') }, { type: 'toolUse', input: { password: 'PASSWORD-PRIVATE', token: 'TOKEN-PRIVATE' } }] }], tools: [] };
  const before = JSON.stringify(request);
  store.capture(request); assert.equal(store.read('a').preview, null);
  store.arm('a'); store.capture(request);
  const preview = store.read('a').preview;
  assert.ok(preview);
  assert.doesNotMatch(preview.text, /FIXTURE-KEY-SECRET|unknown-secret|PASSWORD-PRIVATE|TOKEN-PRIVATE|IMAGE-PRIVATE/);
  assert.match(preview.text, /hello/);
  assert.equal(JSON.stringify(request), before);
  assert.equal(store.read('b').preview, null);
  store.capture({ ...request, systemPrompt: 'second call' });
  assert.equal(store.read('a').preview, preview);
  now += 300001; assert.deepEqual(store.read('a'), { armed: false, preview: null });
  store.arm('a'); store.capture({ ...request, systemPrompt: 'x'.repeat(300000) });
  assert.equal(store.read('a').preview.truncated, true);
  assert.equal(store.read('a').preview.text.length, 256000);
  store.clear('a'); assert.equal(store.read('a').preview, null);
  for (let i = 0; i < 17; i++) store.arm(String(i));
  assert.equal(store.read('0').armed, false);
  for (let i = 0; i < 17; i++) store.clear(String(i));
});
test('real runtime captures the same application input sent to provider, with project and durable context', async t => {
  const root = fixture(t), store = new PromptPreviewStore();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ROOT_GUIDANCE_MARKER');
  let sent, calls = 0;
  const provider = { name: 'fixture', model: 'fixture', defaultMaxTokens: 1024,
    async *streamMessage(messages, systemPrompt, tools) {
      calls++; sent = { messages, systemPrompt, tools };
      yield { type: 'textDelta', text: 'fixture response' }; yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'fixture-session', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false, hasProject: true, projectScope: scope, contextWindow: 200000, onPromptRequest: request => store.capture(request) });
  runtime.setSessionContext('DURABLE_CONTEXT_MARKER');
  store.arm('fixture-session');
  const noop = () => {};
  await runtime.run({ message: 'NORMAL_TASK_MARKER', tools: [], callbacks: { onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop, onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop, onError: error => assert.fail(error), onDone: noop, onCancelled: () => assert.fail('cancelled') } });
  const preview = JSON.parse(store.read('fixture-session').preview.text);
  assert.deepEqual(preview, sent);
  assert.match(preview.systemPrompt, /ROOT_GUIDANCE_MARKER/);
  assert.match(preview.systemPrompt, /DURABLE_CONTEXT_MARKER/);
  assert.match(preview.systemPrompt, /只读配置检查/);
  assert.equal(calls, 1);
  store.clear('fixture-session');
});

test('diagnostic hook failure never blocks normal model calls', async t => {
  const root = fixture(t); let completed = false;
  const provider = { name: 'fixture', model: 'fixture', defaultMaxTokens: 1024, async *streamMessage() { yield { type: 'done', stopReason: 'endTurn' }; } };
  const runtime = new AgentRuntime({ sessionId: 'diagnostic-failure', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false, contextWindow: 200000, onPromptRequest: () => { throw new Error('fixture diagnostic error'); } });
  const noop = () => {};
  await runtime.run({ message: 'Normal request', tools: [], callbacks: { onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop, onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop, onError: error => assert.fail(error), onDone: () => completed = true, onCancelled: () => assert.fail('cancelled') } });
  assert.equal(completed, true);
});
