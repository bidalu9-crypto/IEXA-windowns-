const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {DesktopControlSession}=require('../dist/main/tools/desktop/DesktopControlSession');
const {DesktopControlScheduler}=require('../dist/main/tools/desktop/DesktopControlScheduler');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
function setup(t, transportOverride) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-recovery-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^iexa-recovery-/);fs.rmSync(dir,{recursive:true,force:true});});
 const file=path.join(dir,createHash('sha256').update('recovery-owner').digest('hex')+'.jsonl');
 let seq=0;const calls=[];
 const make=()=>new DesktopControlSession(async(args,signal)=>{
  calls.push(args.action);if(transportOverride){const r=await transportOverride(args,signal);if(r)return r;}
  let data={};
  if(args.action==='observe')data={session:{handle:10,observationToken:'snapshot'},elements:[{id:'send',text:'Send',role:'button',enabled:true,selector:{automationId:'send'}}]};
  if(args.action==='session_state')data={handle:10,foreground:true,observationToken:'snapshot'};
  if(args.action==='list_windows')data={windows:[{handle:10,pid:42,title:'Owned fixture'}]};
  return {success:true,output:JSON.stringify({ok:true,action:args.action,data})};
 },new DesktopControlScheduler(),dir);
 const run=(session,args,signal)=>session.execute(args,signal,{owner:'recovery-owner',operationId:'new-'+ ++seq});
 const event=(id,phase,extra={})=>JSON.stringify({version:1,operationId:id,phase,timestamp:Date.now(),action:'click_element',...extra})+'\n';
 return {dir,file,calls,make,run,event};
}
test('queued/read-only terminal records never hide a previous in-flight input across restarts',async t=>{
 const f=setup(t);
 fs.writeFileSync(f.file,f.event('lost-submit','action_start')+f.event('queued-observer','queued',{action:'observe'})+f.event('queued-observer','completed',{action:'observe'}));
 const one=f.make();const result=await f.run(one,{action:'session_state'});
 const recovered=JSON.parse(result.output).data.control.recovered;
 assert.ok(recovered.unresolvedOperations.some(op=>op.operationId==='lost-submit'&&op.inputMayHaveExecuted&&op.interrupted));
 await f.run(one,{action:'observe'});
 const two=f.make();const reopened=await f.run(two,{action:'session_state'});
 assert.ok(JSON.parse(reopened.output).data.control.recovered.unresolvedOperations.some(op=>op.operationId==='lost-submit'));
 const denied=await f.run(two,{action:'click',target:{name:'Send'},background:true});
 assert.equal(denied.success,false);assert.equal(f.calls.includes('click_element'),false);
});
test('recovery scans beyond 64KB without losing unresolved older operations',async t=>{
 const f=setup(t);fs.writeFileSync(f.file,f.event('old-input','action_start')+Array.from({length:700},(_,i)=>f.event('read-'+i,'completed',{action:'observe'})).join(''));
 assert.ok(fs.statSync(f.file).size>65536);
 const result=await f.run(f.make(),{action:'session_state'});const r=JSON.parse(result.output).data.control.recovered;
 assert.ok(r.unresolvedOperations.some(op=>op.operationId==='old-input'));assert.equal(r.journalIntegrity,'complete');
});
test('cancelled input durably retains dispatch risk, not just in ephemeral tool metadata',async t=>{
 const abort=new AbortController();const f=setup(t,async args=>{if(args.action==='click_element'){abort.abort();return {success:true,output:JSON.stringify({ok:true,data:{}})};}});
 const session=f.make();await f.run(session,{action:'observe'});
 const failed=await f.run(session,{action:'click',target:{name:'Send'},background:true},abort.signal);
 assert.equal(failed.cancelled,true);assert.equal(failed.metadata.desktop.inputMayHaveExecuted,true);
 const rows=fs.readFileSync(f.file,'utf8').trim().split('\n').map(JSON.parse);const last=rows.at(-1);
 assert.equal(last.phase,'cancelled');assert.equal(last.dispatchedActions,1);assert.equal(last.inputMayHaveExecuted,true);
 const recovered=await f.run(f.make(),{action:'session_state'});
 assert.ok(JSON.parse(recovered.output).data.control.recovered.unresolvedOperations.some(op=>op.operationId===last.operationId&&op.inputMayHaveExecuted&&!op.interrupted));
});
test('a completed action cycle and queued cancellation are not mistaken for uncertain dispatched work',async t=>{
 const f=setup(t);fs.writeFileSync(f.file,f.event('done','action_start')+f.event('done','completed',{verified:true})+f.event('never-started','queued')+f.event('never-started','cancelled'));
 const r=await f.run(f.make(),{action:'session_state'});
 assert.deepEqual(JSON.parse(r.output).data.control.recovered.unresolvedOperations,[]);
});
test('torn append is separated before the next event, preserving subsequent durable records',async t=>{
 const f=setup(t);fs.writeFileSync(f.file,f.event('uncertain','action_start')+'{"version":1,"broken":');
 await f.run(f.make(),{action:'session_state'});
 const text=fs.readFileSync(f.file,'utf8');assert.ok(text.includes('"broken":\n{"version":1'));
 const r=await f.run(f.make(),{action:'session_state'});const recovered=JSON.parse(r.output).data.control.recovered;
 assert.equal(recovered.journalIntegrity,'partial');assert.ok(recovered.unresolvedOperations.some(op=>op.operationId==='uncertain'));
});
test('compact model output carries recovery warning after observation, not hidden only in metadata',async t=>{
 const f=setup(t);fs.writeFileSync(f.file,f.event('lost-submit','action_start'));
 const agent=new DesktopAgent(process.cwd(),false,f.dir);
 // Inject only the already tested session transport; no native desktop action is issued.
 agent.control=f.make();t.after(()=>agent.close());
 const r=await agent.execute({action:'observe'},undefined,{owner:'recovery-owner',operationId:'observe-after-restart'});
 assert.equal(r.success,true);assert.match(r.output,/lost-submit/);assert.match(r.output,/恢复警告/);assert.match(r.output,/不要重复提交/);
});

test('durable intent is visible and fsynced before the transport receives a mutating action',async t=>{
 let synced=false;const original=fs.fsyncSync;
 const f=setup(t,async args=>{
  if(args.action==='click_element'){
   const last=fs.readFileSync(f.file,'utf8').trim().split('\n').map(JSON.parse).at(-1);
   assert.equal(last.phase,'action_start');assert.equal(last.inputMayHaveExecuted,true);assert.equal(last.dispatchedActions,1);assert.equal(synced,true);
  }
 });
 const session=f.make();await f.run(session,{action:'observe'});
 t.mock.method(fs,'fsyncSync',function(fd){synced=true;return original.call(fs,fd);});
 const r=await f.run(session,{action:'click',target:{name:'Send'},background:true});assert.equal(r.success,true,r.output);
});
test('failed durable intent flush blocks transport; no action is silently dispatched without a journal',async t=>{
 const f=setup(t);const session=f.make();await f.run(session,{action:'observe'});
 t.mock.method(fs,'fsyncSync',()=>{throw Error('Injected disk flush failure');});
 const r=await f.run(session,{action:'click',target:{name:'Send'},background:true});
 assert.equal(r.success,false);assert.match(r.output,/disk flush failure/);assert.equal(f.calls.includes('click_element'),false);
});
test('partial batch persists both completed-step count and uncertain second dispatch',async t=>{
 let clicks=0;const f=setup(t,async args=>args.action==='click_element'&&++clicks===2?{success:false,output:'Transport disconnected after second dispatch'}:undefined);
 const session=f.make();await f.run(session,{action:'observe'});
 const r=await f.run(session,{action:'batch',background:true,actions:[{action:'click',target:{name:'Send'}},{action:'click',target:{name:'Send'}}]});
 assert.equal(r.success,false);assert.equal(r.metadata.desktop.completedSteps,1);assert.equal(r.metadata.desktop.dispatchedActions,2);
 const restarted=await f.run(f.make(),{action:'session_state'});const pending=JSON.parse(restarted.output).data.control.recovered.unresolvedOperations;
 assert.ok(pending.some(op=>op.operationId===r.metadata.desktop.operationId&&op.completedSteps===1&&op.dispatchedActions===2));
 assert.equal(clicks,2);
});
test('bounded recovery preview explicitly reports omitted uncertainty and malformed-record integrity',async t=>{
 const f=setup(t);
 fs.writeFileSync(f.file,Array.from({length:40},(_,i)=>f.event('pending-'+i,'action_start')).join('')+'X'.repeat(200000)+'\n'+f.event('new-observe','completed',{action:'observe'}));
 const r=await f.run(f.make(),{action:'session_state'});const recovery=JSON.parse(r.output).data.control.recovered;
 assert.equal(recovery.unresolvedOperationCount,40);assert.equal(recovery.unresolvedOperations.length,32);assert.equal(recovery.unresolvedOperationsTruncated,true);assert.equal(recovery.journalIntegrity,'partial');
});
