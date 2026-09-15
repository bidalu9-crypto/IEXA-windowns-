const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProjectInstructions } = require('../dist/main/agent/ProjectInstructions');
const { buildSystemPrompt } = require('../dist/main/agent/SystemPrompt');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'iexa-instructions-'));
  t.after(async () => {
    const target = path.resolve(base);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('iexa-instructions-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const root = path.join(base, 'project');
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  return { root, base, reader: new ProjectInstructions(root), write: (p, body) => fs.writeFile(path.join(root, p), body) };
}
test('root → target scopes, sibling isolation, missing target', async t => {
  const f = await fixture(t);
  await f.write('AGENTS.md', 'Root guidance');
  await f.write('src/AGENTS.md', 'Source guidance');
  await f.write('src/nested/AGENTS.md', 'Nested guidance');
  const r = await f.reader.resolve('src/new-file.ts');
  assert.deepEqual(r.sources.map(s => s.content), ['Root guidance', 'Source guidance']);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.sources[1].scope, await fs.realpath(path.join(f.root, 'src')));
  assert.match(r.sources[0].sha256, /^[a-f0-9]{64}$/);
});
test('directory scope includes its own rule; file scope excludes children', async t => {
  const f = await fixture(t); await f.write('src/AGENTS.md', 'Own rule');
  assert.equal((await f.reader.resolve('src', 'directory')).sources.length, 1);
  assert.equal((await f.reader.resolve('new.ts')).sources.length, 0);
});
test('nonempty override wins; empty override falls back', async t => {
  const f = await fixture(t); await f.write('AGENTS.md', 'ordinary');
  await f.write('AGENTS.override.md', 'override');
  assert.equal((await f.reader.resolve('.')).sources[0].content, 'override');
  await f.write('AGENTS.override.md', '\ufeff  \n');
  assert.equal((await f.reader.resolve('.')).sources[0].content, 'ordinary');
});
test('fresh contents and hashes on every read', async t => {
  const f = await fixture(t); await f.write('AGENTS.md', 'before');
  const a = await f.reader.resolve('.'); await f.write('AGENTS.md', 'after');
  const b = await f.reader.resolve('.'); assert.notEqual(a.sources[0].sha256, b.sources[0].sha256);
  assert.equal(b.sources[0].content, 'after');
});
test('reject target traversal; never load parent rules', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.base, 'AGENTS.md'), 'outside');
  assert.equal((await f.reader.resolve('.')).sources.length, 0);
  await assert.rejects(f.reader.resolve('../outside.txt'));
});
test('project junction pointing outside is rejected', async t => {
  const f = await fixture(t); const outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'AGENTS.md'), 'outside');
  await fs.symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.reader.resolve('escape/secret.ts'));
});
test('oversized and invalid UTF-8 rules produce warnings, not partial injection', async t => {
  const f = await fixture(t); await f.write('AGENTS.override.md', 'x'.repeat(16385)); await f.write('AGENTS.md', 'fallback');
  let r = await f.reader.resolve('.'); assert.equal(r.sources.length, 0); assert.match(r.warnings[0], /budget/);
  await f.write('AGENTS.override.md', Buffer.from([0xff, 0xfe]));
  r = await f.reader.resolve('.'); assert.equal(r.sources.length, 0); assert.equal(r.warnings.length, 1);
});
test('combined byte budget accounts for non-ASCII text', async t => {
  const f = await fixture(t); await f.write('AGENTS.md', '中'.repeat(4000)); await f.write('src/AGENTS.md', '文'.repeat(2000));
  const r = await f.reader.resolve('src/new.ts'); assert.equal(r.sources.length, 1); assert.equal(r.warnings.length, 1);
});
test('real runtime registration, read-only tool execution and system prompt integration', async t => {
  const f = await fixture(t); await f.write('AGENTS.md', 'Use test runner');
  const runtime = new ToolRuntime({ workspaceDir: f.root, memoryDir: path.join(f.base, 'memory') });
  runtime.registerDefaults(); runtime.beginRun();
  assert.equal(runtime.registry.get('project_instructions').requiresApproval, false);
  assert.equal(runtime.isParallelSafe('project_instructions'), true);
  const result = await runtime.execute('project_instructions', { tool_title: 'Read project guidance', path: '.' }, { signal: new AbortController().signal, sessionId: 'test', toolCallId: 'test-1', workspaceDir: f.root });
  assert.equal(result.success, true); assert.match(result.output, /Use test runner/);
  const prompt = buildSystemPrompt({ workspaceDir: f.root, hasProject: true, projectInstructions: result.output });
  assert.ok(prompt.includes(result.output)); assert.match(prompt, /project_instructions/);
});
test('agent loop injects root guidance and preserves full nested tool output for the next model turn', async t => {
  const { AgentLoop } = require('../dist/main/agent/AgentLoop');
  const f = await fixture(t); await f.write('AGENTS.md', 'ROOT_INSTRUCTION_SENTINEL');
  const content = 'nested rule '.repeat(400) + 'TAIL_INSTRUCTION_SENTINEL';
  await f.write('src/AGENTS.md', content);
  const runtime = new ToolRuntime({ workspaceDir:f.root, memoryDir:path.join(f.base,'memory') }); runtime.registerDefaults(); runtime.beginRun();
  let turns = 0; let completed = false;
  const provider = { model:'test-model',name:'openai', defaultMaxTokens:1024,
    async *streamMessage(messages, prompt) {
      assert.match(prompt, /ROOT_INSTRUCTION_SENTINEL/);
      if (++turns === 1) {
        yield { type:'toolCallComplete',id:'scope-1',name:'project_instructions',args:{tool_title:'Read source scope',path:'src/main.ts'} };
        yield { type:'done',stopReason:'toolUse' };
      } else {
        const output = messages.flatMap(m=>m.parts).find(p=>p.type==='toolResult'&&p.id==='scope-1');
        assert.ok(output.content.includes(content));
        yield { type:'textDelta',text:'verified' }; yield { type:'done',stopReason:'endTurn' };
      }
    }
  };
  const signal = new AbortController().signal;
  const loop = new AgentLoop({sessionId:'loop-test',workspaceDir:f.root,memoryDir:path.join(f.base,'memory'),memoryEnabled:false,hasProject:true,provider,toolRuntime:runtime,contextWindow:200000,getAbortSignal:()=>signal});
  const noop=()=>{};
  await loop.run('Read the source guidance',runtime.definitions(),{onTextDelta:noop,onThinkingDelta:noop,onToolCallStart:noop,onToolInputDelta:noop,onToolCallComplete:noop,onToolResult:noop,onUsage:noop,onContext:noop,onError:e=>assert.fail(e),onDone:()=>completed=true,onCancelled:()=>assert.fail('unexpected cancellation')});
  assert.equal(turns,2); assert.equal(completed,true);
});
