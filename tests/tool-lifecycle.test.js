const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {getEventListeners} = require('node:events');
const {ToolRuntime} = require('../dist/main/runtime/ToolRuntime');
const {ToolLifecycle} = require('../dist/main/runtime/ToolLifecycle');
const {ToolScheduler} = require('../dist/main/runtime/ToolScheduler');
const {PermissionBroker,PermissionManager} = require('../dist/main/security/PermissionManager');
const {AgentRuntime} = require('../dist/main/runtime/AgentRuntime');
const tick = () => new Promise(r => setImmediate(r));
function deferred() { let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}; }
async function fixture(t, options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'iexa-lifecycle-'));
  t.after(async()=>{const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('iexa-lifecycle-'));await fs.rm(target,{recursive:true,force:true});});
  const runtime=new ToolRuntime({workspaceDir:root,memoryDir:path.join(root,'memory'),...options});runtime.beginRun();
  return {root,runtime};
}
function tool(execute,other={}) {return {name:'fixture_tool',description:'Test tool',parameters:{},required:[],risk:'low',parallelSafe:true,cancellable:true,requiresApproval:false,execute,...other};}
function context(controller=new AbortController(),events=[],id='call-1') {return {sessionId:'session-1',toolCallId:id,workspaceDir:'.',signal:controller.signal,onToolState:e=>events.push(e)};}
const status = events => events.map(e=>e.status);

test('lifecycle enforces monotonic legal transitions and immutable terminal snapshots',()=>{
 const l=new ToolLifecycle();assert.throws(()=>l.transition('s','i','t','completed'));
 const a=l.transition('s','i','t','queued');const b=l.transition('s','i','t','running');l.transition('s','i','t','completed');
 assert.ok(b.sequence>a.sequence);assert.equal(a.runId,b.runId);assert.throws(()=>l.transition('s','i','t','running'));
 const snap=l.snapshot();snap[0].status='running';assert.equal(l.snapshot()[0].status,'completed');
 assert.throws(()=>l.transition('s','i','other','queued'));
});
test('approval is a distinct state and executor starts only after acceptance',async t=>{
 const broker=new PermissionBroker();const {runtime}=await fixture(t,{permissionResolver:r=>broker.request(r)});let calls=0;
 runtime.registry.register(tool(async()=>{calls++;return {output:'ok',success:true};},{requiresApproval:true}));
 const events=[];const promise=runtime.execute('fixture_tool',{},context(undefined,events));await tick();
 assert.deepEqual(status(events),['queued','awaiting_approval']);assert.equal(calls,0);const pending=broker.list()[0];assert.ok(pending);
 broker.resolve(pending.id,'allow_once');const result=await promise;
 assert.equal(result.executionStatus,'completed');assert.equal(calls,1);assert.deepEqual(status(events),['queued','awaiting_approval','running','completed']);
 assert.ok(events.at(-1).durationMs>=0);assert.equal(broker.list().length,0);
});
test('denied approval never executes or emits running',async t=>{
 const {runtime}=await fixture(t,{permissionResolver:async()=> 'deny'});let calls=0;
 runtime.registry.register(tool(async()=>{calls++;return {output:'bad',success:true};},{requiresApproval:true}));
 const events=[];const result=await runtime.execute('fixture_tool',{},context(undefined,events));
 assert.equal(calls,0);assert.equal(result.executionStatus,'denied');assert.deepEqual(status(events),['queued','awaiting_approval','denied']);
});
test('cancelling approval removes pending request and rejects a late acceptance',async t=>{
 const broker=new PermissionBroker();const {runtime}=await fixture(t,{permissionResolver:r=>broker.request(r)});let calls=0;
 runtime.registry.register(tool(async()=>{calls++;return {output:'bad',success:true};},{requiresApproval:true}));
 const events=[],controller=new AbortController();const promise=runtime.execute('fixture_tool',{},context(controller,events));await tick();
 const pending=broker.list()[0];controller.abort();const result=await promise;
 assert.equal(result.executionStatus,'cancelled');assert.equal(calls,0);assert.equal(broker.list().length,0);assert.equal(broker.resolve(pending.id,'allow_once'),false);
 assert.deepEqual(status(events),['queued','awaiting_approval','cancelling','cancelled']);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('pre-cancelled call never opens an approval or starts the executor',async t=>{
 let calls=0;const {runtime}=await fixture(t,{permissionResolver:async()=>{calls++;return 'allow_once';}});
 runtime.registry.register(tool(async()=>{calls++;return {output:'bad',success:true};},{requiresApproval:true}));
 const c=new AbortController();c.abort();const events=[];const r=await runtime.execute('fixture_tool',{},context(c,events));
 assert.equal(calls,0);assert.equal(r.executionStatus,'cancelled');assert.deepEqual(status(events),['queued','cancelled']);
});
test('cancellation stays nonterminal until actual executor cleanup settles',async t=>{
 const {runtime}=await fixture(t);const entered=deferred(),cleanup=deferred();let cleaned=false;
 runtime.registry.register(tool(async()=>{entered.resolve();await cleanup.promise;cleaned=true;return {output:'late success',success:true};}));
 const controller=new AbortController(),events=[];let settled=false;
 const promise=runtime.execute('fixture_tool',{},context(controller,events)).then(r=>{settled=true;return r;});await entered.promise;controller.abort();await tick();
 assert.equal(settled,false);assert.equal(cleaned,false);assert.equal(events.at(-1).status,'cancelling');assert.throws(()=>runtime.beginRun());
 cleanup.resolve();const r=await promise;assert.equal(cleaned,true);assert.equal(r.success,false);assert.equal(r.executionStatus,'cancelled');
 assert.equal(events.at(-1).status,'cancelled');assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('deadline emits cancelling but waits for executor settlement',async t=>{
 const {runtime}=await fixture(t);const deadline=deferred(),cleanup=deferred();const events=[];let settled=false;
 runtime.registry.register(tool(async(_a,c)=>{c.signal.addEventListener('abort',()=>deadline.resolve(),{once:true});await cleanup.promise;return {output:'cleanup done',success:true};},{timeoutMs:15}));
 const promise=runtime.execute('fixture_tool',{},context(undefined,events)).then(r=>{settled=true;return r;});await deadline.promise;await tick();
 assert.equal(settled,false);assert.equal(events.at(-1).status,'cancelling');cleanup.resolve();const r=await promise;
 assert.equal(r.executionStatus,'timed_out');assert.equal(r.timedOut,true);assert.equal(r.success,false);
});
test('sync exceptions release abort listeners and return failed state',async()=>{
 const scheduler=new ToolScheduler(),controller=new AbortController();const r=await scheduler.execute(tool(()=>{throw new Error('sync failure');}),{},context(controller));
 assert.equal(r.success,false);assert.match(r.output,/sync failure/);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('duplicate call IDs with canonical-equivalent arguments execute exactly once',async t=>{
 const {runtime}=await fixture(t);let count=0;const hold=deferred();runtime.registry.register(tool(async()=>{count++;await hold.promise;return {output:'ok',success:true};},{parameters:{a:{type:'integer',description:''},b:{type:'integer',description:''}}}));
 const events=[];const a=runtime.execute('fixture_tool',{a:1,b:2},context(undefined,events));const b=runtime.execute('fixture_tool',{b:2,a:1},context());await tick();assert.equal(count,1);
 const conflict=await runtime.execute('fixture_tool',{a:99},context());assert.equal(conflict.success,false);assert.match(conflict.output,/reused/);hold.resolve();
 assert.deepEqual(await a,await b);assert.equal(count,1);assert.deepEqual(status(events),['queued','running','completed']);
 const oldRun=events[0].runId;runtime.beginRun();await runtime.execute('fixture_tool',{},context(undefined,events));assert.equal(count,2);assert.notEqual(events.at(-1).runId,oldRun);
});
test('state observer failures do not change execution outcome',async t=>{
 const {runtime}=await fixture(t);runtime.registry.register(tool(async()=>({output:'ok',success:true})));
 const r=await runtime.execute('fixture_tool',{}, {...context(),onToolState:()=>{throw new Error('UI offline');}});assert.equal(r.success,true);
});
test('late approval after abort does not persist session permission',async t=>{
 const {root}=await fixture(t);const gate=deferred();let prompts=0;
 const permissions=new PermissionManager(path.join(root,'audit'),async()=>{prompts++;return prompts===1?gate.promise:'deny';},'ask');
 const c=new AbortController();const req={sessionId:'s',tool:tool(async()=>({output:'ok',success:true})),args:{},signal:c.signal};
 const first=permissions.authorize(req);c.abort();gate.resolve('allow_session');await assert.rejects(first,/cancelled/);
 await assert.rejects(permissions.authorize({...req,signal:new AbortController().signal}),/拒绝/);assert.equal(prompts,2);
});
test('AgentRuntime rejects overlapping model turns and reports cancellation after tool cleanup',async t=>{
 const {root}=await fixture(t);const gate=deferred(),entered=deferred();const events=[];let done=0,cancelled=0;
 const provider={model:'fixture',name:'openai',defaultMaxTokens:1000,async *streamMessage(){yield {type:'toolCallComplete',id:'c',name:'fixture_tool',args:{}};yield {type:'done',stopReason:'toolUse'};}};
 const runtime=new AgentRuntime({sessionId:'s',workspaceDir:root,memoryDir:path.join(root,'memory'),memoryEnabled:false,provider,contextWindow:200000,permissionMode:'full'});
 runtime.registerDynamicTool(tool(async()=>{}),async()=>{entered.resolve();await gate.promise;return {output:'stopped',success:true};});
 const noop=()=>{};const request={message:'run',tools:runtime.toolDefinitions(),callbacks:{onTextDelta:noop,onThinkingDelta:noop,onToolCallStart:noop,onToolInputDelta:noop,onToolCallComplete:noop,onToolResult:noop,onUsage:noop,onContext:noop,onToolState:e=>events.push(e),onDone:()=>done++,onCancelled:()=>cancelled++,onError:e=>assert.fail(e)}};
 const run=runtime.run(request);await entered.promise;await assert.rejects(runtime.run(request),/already/);runtime.cancel();await tick();assert.equal(cancelled,0);
 gate.resolve();await run;assert.equal(cancelled,1);assert.equal(done,0);assert.equal(runtime.getState().status,'cancelled');assert.equal(events.at(-1).status,'cancelled');
});
test('real local command cancellation ends the fixture parent and child process', {timeout:15000},async t=>{
 const {ProcessManager}=require('../dist/main/tools/shell/ProcessManager');
 const {root}=await fixture(t);const controller=new AbortController();const marker=path.join(root,'pids.json');
 await fs.writeFile(path.join(root,'fixture.cjs'),`const fs=require('node:fs');const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`);
 const promise=new ProcessManager().run(`"${process.execPath}" "${path.join(root,'fixture.cjs')}"`,root,controller.signal,{timeoutMs:8000,maxOutputBytes:4096,killGracePeriodMs:1500},process.platform==='win32'?'cmd':'auto');
 let pids;
 try {
  const until=Date.now()+6000;
  while(Date.now()<until){try{pids=JSON.parse(await fs.readFile(marker,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
  assert.equal(pids?.length,2,'fixture process must report its own PIDs');controller.abort();const result=await promise;
  assert.equal(result.success,false);
  for(const pid of pids){let live=true;const until=Date.now()+1500;while(live&&Date.now()<until){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,25));}catch(e){assert.equal(e.code,'ESRCH');live=false;}}assert.equal(live,false,`fixture PID ${pid} still running`);}
 }finally{controller.abort();await promise;}
});
