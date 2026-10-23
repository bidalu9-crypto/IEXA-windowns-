// Every provider gets the same prompt, so the tool knowledge has to live there
// once and be generated from the registry — not hand-maintained, which is how
// names drift and models invent `edit`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildSystemPrompt } = require('../dist/main/agent/SystemPrompt');
const { buildToolAppendix, TOOL_PLAYBOOK } = require('../dist/main/agent/ToolPlaybook');
const { makeAgentTools } = require('../dist/main/tools/ToolDefinitions');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
const { AgentLoop } = require('../dist/main/agent/AgentLoop');

const fullTools = () => makeAgentTools(true, { shellSession: true, jobs: true, goal: true });

test('the quick reference lists every registered tool exactly once', () => {
  const tools = fullTools();
  const appendix = buildToolAppendix(tools);
  for (const tool of tools) {
    const hits = appendix.split('`' + tool.name + '`').length - 1;
    assert.equal(hits, 1, `${tool.name} should appear exactly once, saw ${hits}`);
  }
  // No invented names: every backticked token is a real tool.
  const names = new Set(tools.map((tool) => tool.name));
  for (const match of appendix.matchAll(/^- `([a-z_]+)`/gm)) {
    assert.ok(names.has(match[1]), `appendix mentions unknown tool ${match[1]}`);
  }
});

test('required arguments are spelled out, which is the common recoverable failure', () => {
  const tools = fullTools();
  const appendix = buildToolAppendix(tools);
  for (const tool of tools) {
    const line = appendix.split('\n').find((row) => row.startsWith('- `' + tool.name + '`'));
    assert.ok(line, `missing line for ${tool.name}`);
    for (const required of (tool.required || []).slice(0, 5)) {
      assert.ok(line.includes(required), `${tool.name} line omits required ${required}`);
    }
  }
});

test('the playbook states the routing rules that prevent the common mistakes', () => {
  assert.match(TOOL_PLAYBOOK, /`file_edit`，不是 `edit`/);
  assert.match(TOOL_PLAYBOOK, /搜内容 → `grep`/);
  assert.match(TOOL_PLAYBOOK, /不要用 shell 的 findstr/);
  assert.match(TOOL_PLAYBOOK, /改完代码必须跑构建或测试/);
  assert.match(TOOL_PLAYBOOK, /不要因此放弃整次调用/);
  assert.match(TOOL_PLAYBOOK, /`tool_title`/);
});

test('the prompt carries the generated sections only when the tool set is known', () => {
  const withTools = buildSystemPrompt({ workspaceDir: process.cwd(), hasProject: true, tools: fullTools() });
  assert.ok(withTools.includes('## 工具速查（由运行时注册表生成）'));
  assert.ok(withTools.includes('## 工具路由与调用规则'));
  for (const tool of fullTools()) assert.ok(withTools.includes('`' + tool.name + '`'), tool.name);

  // Back-compat: no runtime means the hand-written list, unchanged.
  const legacy = buildSystemPrompt({ workspaceDir: process.cwd(), hasProject: true });
  assert.doesNotMatch(legacy, /## 工具速查/);
  assert.match(legacy, /你可以使用以下工具/);
});

test('the generated sections stay inside a fixed prompt budget', () => {
  const tools = fullTools();
  const appendix = buildToolAppendix(tools);
  assert.ok(appendix.length < 2600, `appendix grew to ${appendix.length} chars`);
  assert.ok(TOOL_PLAYBOOK.length < 2200, `playbook grew to ${TOOL_PLAYBOOK.length} chars`);
  const prompt = buildSystemPrompt({ workspaceDir: process.cwd(), hasProject: true, tools });
  assert.ok(prompt.length < 12000, `system prompt grew to ${prompt.length} chars`);
});

test('an unknown tool name is answered with the closest real one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-suggest-'));
  const runtime = new ToolRuntime({ workspaceDir: dir, memoryDir: path.join(dir, 'mem'), permissionMode: 'full' });
  runtime.registerDefaults();

  assert.throws(() => runtime.registry.validate('file_reed', {}), /Unknown tool: file_reed\. Did you mean: file_read\?/);
  assert.throws(() => runtime.registry.validate('file_read', { tool_title: 'x', path: 'a', linez: 2 }),
    /Unknown argument: linez\. Valid: .*path/);
});

test('a real turn hands the generated reference to the provider', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-playbook-'));
  const runtime = new ToolRuntime({ workspaceDir: dir, memoryDir: path.join(dir, 'mem'), permissionMode: 'full' });
  runtime.registerDefaults();

  let capturedPrompt = '';
  let capturedTools = [];
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 256,
    async *streamMessage(_messages, systemPrompt, tools) {
      capturedPrompt = systemPrompt;
      capturedTools = tools.map((tool) => tool.name);
      yield { type: 'textDelta', text: 'ok' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const loop = new AgentLoop({
    sessionId: 'playbook', workspaceDir: dir, memoryDir: path.join(dir, 'mem'), memoryEnabled: false,
    provider, toolRuntime: runtime, contextWindow: 200_000, maxTokens: 256, getAbortSignal: () => undefined,
  });
  const noop = () => {};
  await loop.run('hi', runtime.definitions(), {
    onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop,
    onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop,
    onError: (error) => { throw new Error(error); }, onDone: noop, onCancelled: noop,
  });

  assert.ok(capturedPrompt.includes('## 工具速查（由运行时注册表生成）'), 'the provider received the reference');
  assert.ok(capturedPrompt.includes('## 工具路由与调用规则'), 'the provider received the routing rules');
  assert.deepEqual(capturedTools.sort(), runtime.definitions().map((tool) => tool.name).sort(),
    'the prompt and the tool array describe the same set');
  for (const name of capturedTools) assert.ok(capturedPrompt.includes('`' + name + '`'), name);
});
