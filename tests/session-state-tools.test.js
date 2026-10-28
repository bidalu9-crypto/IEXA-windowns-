const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const tempDir = require('./helpers/temp-dir');
const path = require('node:path');

const { GoalStore } = require('../dist/main/agent/GoalStore');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
const { buildSystemPrompt } = require('../dist/main/agent/SystemPrompt');
const { makeAgentTools } = require('../dist/main/tools/ToolDefinitions');

const fixture = () => tempDir.make('iexa-session-state-');
const context = (dir, id = 't1') => ({ signal: new AbortController().signal, sessionId: 's1', toolCallId: id, workspaceDir: dir });

test('a goal is re-injected every turn, survives a restart, and disappears when done', () => {
  const dir = fixture();
  const file = path.join(dir, 'goals.json');
  const first = new GoalStore(file);
  const record = first.set('s1', 'ship the compact grid', 'tests pass and the page renders');
  assert.equal(record.status, 'active');
  assert.equal(first.update('s1', { note: 'grid landed' }).notes.length, 1);

  const reopened = new GoalStore(file);
  const block = reopened.promptBlock('s1');
  assert.match(block, /ship the compact grid/);
  assert.match(block, /tests pass and the page renders/);
  assert.match(block, /- grid landed/);

  reopened.update('s1', { status: 'done' });
  assert.equal(reopened.promptBlock('s1'), '', 'a finished goal is not injected');
  assert.equal(reopened.clear('s1'), true);
  assert.equal(reopened.get('s1'), null);
});

test('goal notes are bounded instead of growing without limit', () => {
  const store = new GoalStore(path.join(fixture(), 'goals.json'));
  store.set('s1', 'x', '');
  for (let index = 0; index < 20; index += 1) store.update('s1', { note: `note-${index}` });
  const record = store.get('s1');
  assert.equal(record.notes.length, 12);
  assert.equal(record.notes.at(-1), 'note-19');
});

test('job tools read the audit bridge and mark evicted output honestly', async () => {
  const dir = fixture();
  const now = Date.now();
  const job = { id: 'job-1', toolId: 'call_1', toolName: 'shell_execute', title: 'run tests', status: 'completed', createdAt: now - 1200, finishedAt: now, success: true, preview: 'ok 42 tests' };
  const bridge = {
    list: () => [job],
    output: (_sessionId, id) => (id === 'job-1' || id === 'call_1')
      ? { job, output: 'line one\nline two', recorded: true }
      : { job: { ...job, id: 'job-2', outputPreview: 'gone' }, output: '', recorded: false },
  };
  const runtime = new ToolRuntime({ workspaceDir: dir, memoryDir: path.join(dir, 'mem'), permissionMode: 'full', jobBridge: bridge, goalStore: new GoalStore(path.join(dir, 'goals.json')) });
  runtime.registerDefaults();
  runtime.beginRun(['job_list', 'job_output', 'goal']);

  const listed = await runtime.execute('job_list', { tool_title: 'list' }, context(dir, 't1'));
  assert.equal(listed.success, true);
  assert.match(listed.output, /job-1/);
  assert.match(listed.output, /call_1/);
  assert.match(listed.output, /shell_execute/);
  assert.match(listed.output, /1\.2s/);

  const full = await runtime.execute('job_output', { tool_title: 'read', job_id: 'call_1' }, context(dir, 't2'));
  assert.equal(full.success, true);
  assert.match(full.output, /line one\nline two/);

  const sliced = await runtime.execute('job_output', { tool_title: 'read', job_id: 'job-1', offset: 5, max_length: 3 }, context(dir, 't3'));
  assert.equal(sliced.output.startsWith('one'), true, sliced.output);
  assert.match(sliced.output, /还有/);

  const missing = await runtime.execute('job_output', { tool_title: 'read', job_id: 'job-2' }, context(dir, 't4'));
  assert.equal(missing.success, false);
  assert.match(missing.output, /未被保留/);

  const unknown = await runtime.execute('job_output', { tool_title: 'read', job_id: 'nope' }, context(dir, 't5'));
  assert.equal(unknown.success, false);
});

test('the goal tool writes through the runtime and reports state', async () => {
  const dir = fixture();
  const runtime = new ToolRuntime({ workspaceDir: dir, memoryDir: path.join(dir, 'mem'), permissionMode: 'full', goalStore: new GoalStore(path.join(dir, 'goals.json')) });
  runtime.registerDefaults();
  runtime.beginRun(['goal']);

  const unset = await runtime.execute('goal', { tool_title: 'get', action: 'get' }, context(dir, 'g1'));
  assert.match(unset.output, /没有设置目标/);

  const set = await runtime.execute('goal', { tool_title: 'set', action: 'set', objective: 'fix the cache line', done_when: 'no stale rows' }, context(dir, 'g2'));
  assert.equal(set.success, true);
  assert.match(set.output, /fix the cache line/);

  const update = await runtime.execute('goal', { tool_title: 'note', action: 'update', note: 'reproduced', status: 'blocked' }, context(dir, 'g3'));
  assert.match(update.output, /受阻/);
  assert.match(update.output, /reproduced/);

  const invalid = await runtime.execute('goal', { tool_title: 'bad', action: 'update', status: 'sideways' }, context(dir, 'g4'));
  assert.equal(invalid.success, false);
});

test('session tools are advertised only when the runtime can back them', () => {
  const dir = fixture();
  const bare = new ToolRuntime({ workspaceDir: dir, memoryDir: path.join(dir, 'mem') });
  bare.registerDefaults();
  assert.equal(bare.registry.has('goal'), false);
  assert.equal(bare.registry.has('job_list'), false);
  assert.equal(bare.registry.has('shell_session'), false);

  const wired = new ToolRuntime({ workspaceDir: dir, memoryDir: path.join(dir, 'mem'), goalStore: new GoalStore(path.join(dir, 'goals.json')), jobBridge: { list: () => [], output: () => null } });
  wired.registerDefaults();
  assert.equal(wired.registry.has('goal'), true);
  assert.equal(wired.registry.has('job_list'), true);

  const advertised = makeAgentTools(true, { shellSession: true, jobs: true, goal: true }).map(tool => tool.name);
  assert.ok(advertised.includes('shell_session'));
  assert.ok(advertised.includes('job_output'));
  assert.ok(advertised.includes('goal'));
  assert.equal(makeAgentTools(true).some(tool => tool.name === 'goal'), false);
});

test('the system prompt explains session state only when the tools exist', () => {
  const dir = fixture();
  const withTools = buildSystemPrompt({ workspaceDir: dir, sessionTools: true });
  assert.match(withTools, /\*\*shell_session\*\*/);
  assert.match(withTools, /\*\*job_list \/ job_output\*\*/);
  assert.match(withTools, /目标每轮自动注入/);
  const without = buildSystemPrompt({ workspaceDir: dir });
  assert.doesNotMatch(without, /shell_session/);
});
