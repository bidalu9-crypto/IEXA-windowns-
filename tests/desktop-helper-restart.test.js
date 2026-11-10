'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DesktopControlSession}=require('../dist/main/tools/desktop/DesktopControlSession');
const {DesktopControlScheduler}=require('../dist/main/tools/desktop/DesktopControlScheduler');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
function fixture(options={}){
 let nonce='instance-before-0001',bound=0,token=0,foreground=true,identity={handle:10,pid:7,process:'fixture',title:'fixture'};
 const calls=[];const transport=async args=>{
  calls.push(args);let data={};
  if(args.action==='list_windows')data={windows:[identity]};
  if(args.action==='observe'){bound=10;token++;data={session:{handle:10,observationToken:'t'+token},foreground:identity,frame:{trust:'foreground'},elements:[{id:'button-'+nonce,role:'button',text:'Save',selector:{automationId:'save'}}]};}
  if(args.action==='session_state')data={handle:bound,foreground,observationToken:'t'+token};
  if(args.action==='click_element'){
   if(options.restartBeforeDispatch)return {success:false,output:'Desktop helper restarted before input dispatch. Fresh observe is required.',metadata:{helperRestarted:true,noInputDispatched:true,nativeInstanceNonce:'third-instance'}};
   data={foregroundVerified:true};
   if(options.restartAfterAck){nonce='instance-after-0002';bound=0;}
  }
  return {success:true,output:JSON.stringify({ok:true,data}),metadata:{nativeInstanceNonce:nonce}};
 };
 const session=new DesktopControlSession(transport,new DesktopControlScheduler());
 return {calls,run:args=>session.execute(args,undefined,{owner:'restart'}),restart(){nonce='instance-after-0002';bound=0;},expire(){session.owners.get('restart').snapshot.capturedAt=Date.now()-61_000;},changeIdentity(change){identity={...identity,...change};},loseFocus(){foreground=false;}};
}
test('idle restart refreshes exact window read-only and resolves a new semantic ID before first input',async()=>{
 const f=fixture();await f.run({action:'observe',handle:10,controlMode:'foreground'});f.restart();
 const result=await f.run({action:'click',target:{automationId:'save'}});assert.equal(result.success,true,result.output);
 const inputs=f.calls.filter(call=>call.action==='click_element');assert.equal(inputs.length,1);assert.equal(inputs[0].elementId,'button-instance-after-0002');assert.equal(inputs[0].expectedNativeInstanceNonce,'instance-after-0002');
 assert.equal(result.metadata.desktop.helperRecovery.refreshedBeforeFirstDispatch,true);assert.equal(result.metadata.desktop.helperRecovery.inputReplayed,false);
 assert.equal(f.calls.some(call=>call.action==='activate'),false);
 assert.ok(f.calls.some(call=>call.action==='list_windows'&&call.handle===10&&call.includeHidden===true&&call.limit===1));
});
test('restart rejects stale explicit IDs, tokens, coordinates and keyboard focus before input',async()=>{
 for(const action of [{action:'click_element',elementId:'button-instance-before-0001'},
  {action:'click',target:{elementId:'button-instance-before-0001'}},
  {action:'click',target:{automationId:'save'},observationToken:'t1'},
  {action:'click',relativeX:10,relativeY:10}, {action:'key',key:'ENTER'}]){
  const f=fixture();await f.run({action:'observe',handle:10,controlMode:'foreground'});f.restart();const result=await f.run(action);
  assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);assert.match(result.output,/Fresh observe/);
  assert.deepEqual(result.metadata.desktop.helperRecovery.nextObservation,{action:'observe',handle:10});
  assert.equal(f.calls.filter(call=>call.action==='observe').length,1);assert.equal(f.calls.some(call=>['click','click_element','key','activate'].includes(call.action)),false);
 }
});
test('restart never reacquires another identity or activates a window whose focus changed',async()=>{
 for(const change of [{pid:99},{handle:11},{title:'different'},'focus']){
  const f=fixture();await f.run({action:'observe',handle:10,controlMode:'foreground',focusPolicy:'activate'});f.restart();
  if(change==='focus')f.loseFocus();else f.changeIdentity(change);
  const result=await f.run({action:'click',target:{automationId:'save'}});assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);
  assert.equal(f.calls.some(call=>['click_element','activate'].includes(call.action)),false);
 }
});
test('helper restart does not extend an already expired observation capability',async()=>{
 const f=fixture();await f.run({action:'observe',handle:10,controlMode:'foreground'});f.expire();f.restart();
 const result=await f.run({action:'click',target:{automationId:'save'}});assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);
 assert.equal(f.calls.filter(call=>call.action==='observe').length,1);
});
test('a second restart before dispatch is not counted as input and an acknowledged action is never replayed',async()=>{
 const blocked=fixture({restartBeforeDispatch:true});await blocked.run({action:'observe',handle:10,controlMode:'foreground'});
 const rejected=await blocked.run({action:'click',target:{automationId:'save'}});assert.equal(rejected.success,false);assert.equal(rejected.metadata.desktop.dispatchedActions,0);assert.equal(rejected.metadata.desktop.acknowledgedActions,0);
 const f=fixture({restartAfterAck:true});await f.run({action:'observe',handle:10,controlMode:'foreground'});
 const result=await f.run({action:'click',target:{automationId:'save'}});assert.equal(result.success,false);assert.equal(result.metadata.desktop.acknowledgedActions,1);assert.equal(f.calls.filter(call=>call.action==='click_element').length,1);
});
test('native health nonce change blocks an old expected nonce before POST dispatch',async t=>{
 const originalFetch=global.fetch;let posts=0,nonce='first-instance-0001';
 global.fetch=async(url,options)=>{if(options?.method==='POST'){posts++;throw Error('must not dispatch');}return {ok:true,json:async()=>({product:'IEXA Desktop Agent',protocolVersion:6,lifecycle:{version:1},automationEngine:'FlaUI 5',instanceNonce:nonce})};};
 t.after(()=>{global.fetch=originalFetch;});
 const agent=new DesktopAgent(process.cwd());assert.equal(await agent.healthy(),true);assert.equal(agent.nativeInstanceNonce,nonce);
 nonce='second-instance-0002';
 const result=await agent.executeNative({action:'key',key:'ENTER',background:false,expectedNativeInstanceNonce:'first-instance-0001'});
 assert.equal(result.success,false);assert.equal(result.metadata.noInputDispatched,true);assert.equal(result.metadata.helperRestarted,true);assert.equal(posts,0);agent.close();
});
test('model arguments cannot inject the internal expected helper nonce',async()=>{
 const f=fixture();const result=await f.run({action:'observe',expectedNativeInstanceNonce:'forged'});
 assert.equal(result.success,false);assert.equal(f.calls.length,0);assert.match(result.output,/internal transport field/);
});
