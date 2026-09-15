const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { SubAgentManager } = require('../dist/main/runtime/SubAgentManager');
const { AgentRuntime } = require('../dist/main/runtime/AgentRuntime');
const { TranscriptRecorder } = require('../dist/main/session/TranscriptRecorder');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(5); } throw new Error('Fixture condition timed out'); }
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-subagents-'));
  const events = [], calls = [], runtimes = []; let active = 0, peak = 0;
  const manager = new SubAgentManager({ rootSessionId: 'root', directory, model: 'fixture-model', workspaceDir: directory,
    rootContext: () => 'parent reference', onChange: agent => events.push(agent), ...options,
    factory: (record) => {
      let cancelled = false;
      const runtime = { initialize: async () => { if (options.initGate) await options.initGate.promise; },
        seedHistoryFromChat: messages => { runtime.seed = JSON.parse(JSON.stringify(messages)); }, setSessionContext: value => { runtime.context = value; },
        contextSnapshot: () => 'child reference', setPermissionMode: mode => { runtime.mode = mode; }, toolDefinitions: () => [],
        cancel: () => { cancelled = true; calls.push('cancel:' + record.nickname); },
        run: async ({ message, callbacks }) => {
          cancelled = false; active++; peak = Math.max(peak, active); calls.push('start:' + message);
          callbacks.onTextDelta('partial', 'partial');
          try {
            for (let i = 0; i < (message.includes('slow') ? 40 : 2) && !cancelled; i++) await pause(3);
            if (cancelled) { await pause(15); calls.push('cleanup:' + message); callbacks.onCancelled(); }
            else if (message === 'fail') callbacks.onError('fixture failure');
            else { callbacks.onTextDelta('done', 'result:' + message); callbacks.onUsage({inputTokens: 3, outputTokens: 5}); callbacks.onDone('endTurn'); }
          } finally { active--; calls.push('end:' + message); }
        },
      }; runtimes.push(runtime); return runtime;
    },
  });
  t.after(async () => { options.initGate?.resolve(); manager.cancelAll(); await manager.settleAll(); assert.ok(directory.startsWith(path.join(os.tmpdir(), 'iexa-subagents-'))); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, directory, events, calls, runtimes, get peak() { return peak; } };
}

test('children truly overlap, have unique identities, isolated histories and copied context only on request', async t => {
  const f = fixture(t); const a = f.manager.spawn('root', 'slow-A', true, 'A'), b = f.manager.spawn('root', 'slow-B', false, 'B');
  assert.notEqual(a.id, b.id); await f.manager.wait('root', [a.id, b.id], 2000); await f.manager.settleDescendants('root');
  assert.equal(f.peak, 2); assert.equal(f.manager.detail(a.id).messages[0].content, 'slow-A'); assert.equal(f.manager.detail(b.id).messages[0].content, 'slow-B');
  assert.match(f.runtimes[0].context, /parent reference/); assert.doesNotMatch(f.runtimes[1].context, /parent reference/);
  assert.equal(f.manager.detail(a.id).inputTokens, 3); const copy = f.manager.detail(a.id); copy.messages.length = 0; assert.equal(f.manager.detail(a.id).messages.length, 2);
});

test('ownership, global open quota and nested depth are enforced; completed agents retain slots until close', async t => {
  const { manager } = fixture(t, { maxAgents: 3, maxDepth: 2 });
  const a = manager.spawn('root', 'A'), b = manager.spawn('root', 'B'), c = manager.spawn(a.id, 'C');
  assert.throws(() => manager.spawn('root', 'D'), /limit/); assert.throws(() => manager.send(b.id, c.id, 'bad'), /another parent/);
  await manager.settleDescendants('root'); assert.throws(() => manager.spawn('root', 'D'), /limit/);
  await manager.close('root', b.id); assert.throws(() => manager.spawn(c.id, 'too deep'), /nesting/);
  const d = manager.spawn('root', 'D'); assert.throws(() => manager.resume('root', b.id), /limit/); await manager.close('root', d.id);
  assert.equal(manager.resume('root', b.id).status, 'idle');
});

test('wait returns first settled child, timeout leaves work running, and abort ends only wait', async t => {
  const { manager } = fixture(t); const a = manager.spawn('root', 'slow-A'), b = manager.spawn('root', 'fast');
  assert.equal((await manager.wait('root', [a.id], 0)).timedOut, true);
  const result = await manager.wait('root', [a.id, b.id], 1000); assert.equal(result.agents[0].id, b.id);
  const controller = new AbortController(); const waiting = manager.wait('root', [a.id], 1000, controller.signal); controller.abort(); await assert.rejects(waiting, /cancelled/);
  assert.ok(['running', 'queued'].includes(manager.detail(a.id).status));
  await assert.rejects(manager.wait('root', [], 100), /1–32/); await assert.rejects(manager.wait('root', [a.id], -1), /timeout/);
});

test('queued input stays serial; interrupt waits for cleanup before follow-up starts', async t => {
  const f = fixture(t); const a = f.manager.spawn('root', 'slow-original'); await until(() => f.calls.includes('start:slow-original'));
  f.manager.send('root', a.id, 'next', true); f.manager.send('root', a.id, 'last');
  await f.manager.settleDescendants('root');
  assert.ok(f.calls.indexOf('cleanup:slow-original') < f.calls.indexOf('start:next')); assert.ok(f.calls.indexOf('end:next') < f.calls.indexOf('start:last')); assert.equal(f.peak, 1);
  assert.deepEqual(f.manager.detail(a.id).messages.filter(m => m.role === 'user').map(m => m.content), ['slow-original', 'next', 'last']);
});

test('close recursively settles descendants, rejects input during cleanup, retains records and resume history', async t => {
  const f = fixture(t); const a = f.manager.spawn('root', 'slow-A'), b = f.manager.spawn(a.id, 'slow-B');
  await until(() => f.calls.includes('start:slow-B')); const closing = f.manager.close('root', a.id);
  assert.throws(() => f.manager.send('root', a.id, 'race'), /closed|stopped/); assert.throws(() => f.manager.resume('root', a.id), /cleanup/);
  await closing; assert.equal(f.manager.detail(a.id).status, 'closed'); assert.equal(f.manager.detail(b.id).status, 'closed'); assert.equal(f.manager.hasActiveWork(), false);
  f.manager.resume('root', a.id); f.manager.send('root', a.id, 'resumed'); await f.manager.settleDescendants('root');
  assert.equal(f.runtimes.at(-1).seed[0].content, 'slow-A'); assert.equal(f.manager.detail(b.id).status, 'closed');
});

test('root stop while child initializes prevents queued execution and publishes settled cancellation', async t => {
  const initGate = deferred(), f = fixture(t, { initGate }); const a = f.manager.spawn('root', 'never-start');
  await until(() => f.runtimes.length === 1); f.manager.cancelAll(); assert.throws(() => f.manager.spawn('root', 'race'), /cancellation/);
  initGate.resolve(); await f.manager.settleAll(); assert.equal(f.manager.detail(a.id).status, 'cancelled'); assert.ok(!f.calls.some(x => x.startsWith('start:')));
});

test('failed output and child transcripts persist; restart does not execute interrupted work', async t => {
  const f = fixture(t); const a = f.manager.spawn('root', 'fail'); await f.manager.settleDescendants('root');
  assert.equal(f.manager.detail(a.id).status, 'failed'); assert.equal(f.manager.detail(a.id).output, 'partial');
  const file = SubAgentManager.storePath(f.directory, 'root'), disk = JSON.parse(fs.readFileSync(file));
  disk.agents[0].status = 'running'; disk.agents[0].pendingInputs = ['must not rerun']; fs.writeFileSync(file, JSON.stringify(disk));
  let calls = 0;
  const restored = new SubAgentManager({ rootSessionId: 'root', directory: f.directory, workspaceDir: f.directory, model: 'fixture', factory: () => { calls++; throw new Error('No automatic execution'); }, rootContext: () => '' });
  assert.equal(restored.detail(a.id).status, 'interrupted'); assert.equal(restored.detail(a.id).pendingInputs.length, 0); assert.equal(calls, 0);
  assert.equal(restored.detail(a.id).messages[1].transcript.status, 'failed'); assert.match(restored.detail(a.id).error, /重启/);
});

test('live inherited permission-mode changes reach all initialized descendants', async t => {
  const f = fixture(t); f.manager.spawn('root', 'A'); f.manager.spawn('root', 'B'); await until(() => f.runtimes.length === 2);
  f.manager.setPermissionMode('ask'); assert.deepEqual(f.runtimes.map(r => r.mode), ['ask', 'ask']);
});

function callbacks(extra = {}) { return { onTextDelta() {}, onThinkingDelta() {}, onToolCallStart() {}, onToolInputDelta() {}, onToolCallComplete() {}, onToolResult() {}, onUsage() {}, onContext() {}, onError(error) { throw new Error(error); }, onDone() {}, onCancelled() {}, ...extra }; }

test('real AgentRuntime model/tool loop spawns and waits for child file reads with independent provider histories', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-subagents-runtime-')); fs.writeFileSync(path.join(dir, 'fixture.txt'), 'local-child-evidence');
  let peak = 0, active = 0; const seen = [], requests = [];
  const provider = { name: 'fixture', model: 'fixture-model', defaultMaxTokens: 1000,
    async *streamMessage(messages, system, tools, _max, signal) {
      requests.push({ system, tools: tools.map(t => t.name) });
      const allResults = messages.flatMap(m => m.parts).filter(p => p.type === 'toolResult');
      const child = system.includes('You are sub-agent');
      if (child) {
        if (!allResults.length) {
          active++; peak = Math.max(peak, active); await pause(20); active--;
          yield {type: 'toolCallComplete', id: 'read-1', name: 'file_read', args: { path: 'fixture.txt', tool_title: '读取本地测试文件' }};
          yield {type: 'done', stopReason: 'toolUse'};
        } else { assert.match(allResults[0].content, /local-child-evidence/); yield {type: 'textDelta', text: 'Child verified fixture.'}; yield {type: 'done', stopReason: 'endTurn'}; }
      } else if (!allResults.length) {
        for (const name of ['A', 'B']) yield {type: 'toolCallComplete', id: 'spawn-' + name, name: 'spawn_agent', args: { message: 'Read fixture ' + name, nickname: name }};
        yield {type: 'done', stopReason: 'toolUse'};
      } else if (!allResults.some(r => r.name === 'wait_agent')) {
        const ids = allResults.filter(r => r.name === 'spawn_agent').map(r => JSON.parse(r.content).id);
        // Separate waits ensure both siblings are settled before the parent final result.
        for (let i = 0; i < ids.length; i++) yield {type: 'toolCallComplete', id: 'wait-' + i, name: 'wait_agent', args: { ids: [ids[i]], timeout_ms: 2000 }};
        yield {type: 'done', stopReason: 'toolUse'};
      } else { for (const r of allResults.filter(r => r.name === 'wait_agent')) assert.match(r.content, /Child verified fixture/); yield {type: 'textDelta', text: 'Both children complete.'}; yield {type: 'done', stopReason: 'endTurn'}; }
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'root', provider, workspaceDir: dir, memoryDir: path.join(dir, 'memory'), memoryEnabled: false, permissionMode: 'risk', subAgentDir: path.join(dir, 'agents') });
  t.after(async () => { runtime.cancel(); await runtime.settleBackground(); assert.ok(dir.startsWith(path.join(os.tmpdir(), 'iexa-subagents-runtime-'))); fs.rmSync(dir, {recursive:true,force:true}); });
  await runtime.initialize(); let output = '';
  await runtime.run({ message: 'Delegate two reads.', tools: runtime.toolDefinitions(), callbacks: callbacks({ onToolResult: (id, result) => seen.push({id, result}), onTextDelta: (_t, full) => output = full }) });
  assert.equal(output, 'Both children complete.'); assert.equal(peak, 2); assert.equal(runtime.getSubAgents().list().length, 2);
  assert.equal(seen.filter(s => s.id.startsWith('spawn-') && s.result.success).length, 2);
  for (const record of runtime.getSubAgents().list()) { const message = runtime.getSubAgents().detail(record.id).messages[1]; assert.deepEqual(message.transcript.items.map(i => i.type), ['tool', 'text']); assert.match(message.toolCalls[0].result.output, /local-child-evidence/); }
  assert.ok(requests.every(r => r.tools.includes('spawn_agent')));
});


test('real root cancellation waits for child approval cancellation and descendant settlement before terminal callback', async t => {
 const { PermissionBroker } = require('../dist/main/security/PermissionManager');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-subagents-cancel-')),broker=new PermissionBroker(10000);let runtime, childId, parentWaiting=false, cancelledAt;
 const provider={name:'fixture',model:'fixture',defaultMaxTokens:1000,async *streamMessage(messages,system,tools,max,signal){
  const results=messages.flatMap(m=>m.parts).filter(p=>p.type==='toolResult');
  if(system.includes('You are sub-agent')){yield {type:'toolCallComplete',id:'write',name:'file_write',args:{path:'must-not-exist.txt',content:'should not execute',tool_title:'审批取消夹具'}};yield {type:'done',stopReason:'toolUse'};}
  else if(!results.length){yield {type:'toolCallComplete',id:'spawn',name:'spawn_agent',args:{message:'Attempt an approved write'}};yield {type:'done',stopReason:'toolUse'};}
  else {childId=JSON.parse(results[0].content).id;parentWaiting=true;yield {type:'toolCallComplete',id:'wait',name:'wait_agent',args:{ids:[childId],timeout_ms:10000}};yield {type:'done',stopReason:'toolUse'};}
 }};
 runtime=new AgentRuntime({sessionId:'root',provider,workspaceDir:dir,memoryDir:path.join(dir,'memory'),memoryEnabled:false,permissionMode:'ask',permissionResolver:r=>broker.request(r),subAgentDir:path.join(dir,'agents')});
 t.after(async()=>{runtime.cancel();broker.cancelSession('root');await runtime.settleBackground();assert.ok(dir.startsWith(path.join(os.tmpdir(),'iexa-subagents-cancel-')));fs.rmSync(dir,{recursive:true,force:true});});
 await runtime.initialize();
 // Approve only parent orchestration operations in ask mode. Child file_write stays pending.
 broker.subscribe('root',pending=>{if(['spawn_agent','wait_agent'].includes(pending.request.tool.name))broker.resolve(pending.id,'allow_once');});
 const run=runtime.run({message:'Spawn then wait',tools:runtime.toolDefinitions(),callbacks:callbacks({onCancelled:()=>{cancelledAt=runtime.hasBackgroundWork();}})});
 await until(()=>parentWaiting&&broker.list('root').some(p=>p.request.tool.name==='file_write'));const pending=broker.list('root').find(p=>p.request.tool.name==='file_write');assert.match(pending.request.toolCallId,new RegExp('^'+childId+':'));
 runtime.cancel();await run;assert.equal(cancelledAt,false);assert.equal(broker.list('root').length,0);assert.equal(broker.resolve(pending.id,'allow_once'),false);assert.equal(fs.existsSync(path.join(dir,'must-not-exist.txt')),false);
 assert.equal(runtime.getSubAgents().detail(childId).status,'cancelled');
});

test('corrupt ownership trees are rejected without replacing the saved file', async t => {
 const f=fixture(t);const a=f.manager.spawn('root','A');await f.manager.settleDescendants('root');const file=SubAgentManager.storePath(f.directory,'root');
 const data=JSON.parse(fs.readFileSync(file));data.agents[0].parentId=a.id;fs.writeFileSync(file,JSON.stringify(data));const before=fs.readFileSync(file,'utf8');
 assert.throws(()=>SubAgentManager.read(f.directory,'root'),/存档结构/);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('nested children cannot resume under a closed parent, and close returns prior status', async t=>{
 const {manager}=fixture(t);const a=manager.spawn('root','A'),b=manager.spawn(a.id,'B');await manager.settleDescendants('root');
 const result=await manager.close('root',a.id);assert.equal(result.previousStatus,'completed');assert.throws(()=>manager.resume(a.id,b.id),/parent agent first/);
 manager.resume('root',a.id);assert.equal(manager.resume(a.id,b.id).status,'idle');
});

test('storage failure cancels active children and rejects new work rather than faking durable success', async t=>{
 const f=fixture(t);const a=f.manager.spawn('root','slow-A');await until(()=>f.calls.includes('start:slow-A'));
 f.manager.store.saveSync=()=>{throw new Error('disk full fixture');};
 assert.throws(()=>f.manager.send('root',a.id,'must not run'),/保存失败/);await f.manager.settleAll();
 assert.equal(f.manager.detail(a.id).status,'failed');assert.match(f.manager.detail(a.id).error,/disk full fixture/);
 assert.throws(()=>f.manager.spawn('root','new'),/保存失败/);assert.ok(!f.calls.includes('start:must not run'));assert.equal(f.manager.hasActiveWork(),false);
});
