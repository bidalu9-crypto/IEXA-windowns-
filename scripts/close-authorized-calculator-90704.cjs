'use strict';
// Explicit user authorization covers this exact existing Calculator identity.
// It is observed and closed through GUI only; never claimed or terminated.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process');
const {createHash}=require('node:crypto');
const {createSupervisor}=require('./helpers/acceptance-supervisor.cjs');
const root=path.resolve(__dirname,'..'),worker=path.join(__dirname,'check-desktop-keyboard-regression.cjs');
const authorizedPid=90704,authorizedCreated='2026-11-10T05:00:18.0685180Z';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function readIdentityAndRelations(handles){
 for(const h of handles)assert.ok(Number.isSafeInteger(h)&&h>0);
 const script=`$ErrorActionPreference='Stop'
$target=Get-CimInstance Win32_Process -Filter 'ProcessId = 90704'
if($null -eq $target){throw 'Authorized Calculator PID is absent'}
$created=$target.CreationDate.ToUniversalTime().ToString('O')
if($created -cne '${authorizedCreated}' -or $target.Name -ine 'CalculatorApp.exe'){throw 'Authorized Calculator process identity mismatch'}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CalculatorRelations {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 public static object Read(long frame){
  var h=new IntPtr(frame); uint owner; GetWindowThreadProcessId(h,out owner);
  if(!IsWindow(h))throw new InvalidOperationException("Frame HWND is gone");
  var children=new List<object>();
  EnumChildWindows(h,(child,data)=>{uint pid;GetWindowThreadProcessId(child,out pid);if(pid==90704&&IsChild(h,child))children.Add(new{handle=child.ToInt64(),pid});return true;},IntPtr.Zero);
  return new{handle=frame,pid=owner,visible=IsWindowVisible(h),parent=GetParent(h).ToInt64(),root=GetAncestor(h,2).ToInt64(),rootOwner=GetAncestor(h,3).ToInt64(),ownerHandle=GetWindow(h,4).ToInt64(),calculatorChildren=children};
 }
}
'@
$frames=@(${handles.map(h=>`[CalculatorRelations]::Read(${h})`).join(';')})
@{pid=[int]$target.ProcessId;name=$target.Name;executable=$target.ExecutablePath;createdUtc=$created;frames=$frames}|ConvertTo-Json -Depth 8 -Compress`;
 const stdout=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
  {windowsHide:true,timeout:12000,encoding:'utf8',maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
 const result=JSON.parse(stdout.replace(/^\uFEFF/,''));
 assert.equal(result.pid,authorizedPid);assert.equal(result.createdUtc,authorizedCreated);assert.match(result.name,/^CalculatorApp\.exe$/i);
 assert.ok(typeof result.executable==='string'&&/\\CalculatorApp\.exe$/i.test(result.executable));
 assert.ok(Array.isArray(result.frames));return result;
}
function rpc(child){
 let id=0,readyResolve,readyReject;const pending=new Map();
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
 const dispose=error=>{readyReject(error);for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 child.once('error',dispose);child.once('exit',code=>dispose(Error('Controller exited '+code)));
 child.on('message',m=>{if(m.ready)return readyResolve();const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m);});
 return{ready,dispose:()=>dispose(Error('RPC disposed')),request(args){return new Promise((resolve,reject)=>{const current=++id,timer=setTimeout(()=>{pending.delete(current);if(child.connected)child.send({cancel:true});reject(Error('Action timed out; no replay'));},20000);pending.set(current,{resolve,reject,timer});child.send({id:current,args},error=>{if(error){clearTimeout(timer);pending.delete(current);reject(error);}});});}};
}
async function main(){
 const packageRoot=path.resolve(process.env.IEXA_TEST_PACKAGE||path.join(root,'release/IEXA-preview-20261109')),appRoot=path.join(packageRoot,'resources/app');
 const out=path.join(root,'.iexa-artifacts/desktop-comparison-20261110','authorized-calculator-close-'+Date.now());fs.mkdirSync(out,{recursive:true});
 const report={status:'running',startedAt:new Date().toISOString(),authorization:{pid:authorizedPid,createdUtc:authorizedCreated,process:'CalculatorApp.exe',action:'GUI close only; no process termination or ownership claim'},actions:[]};
 const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 const supervisor=createSupervisor({output:out,maximumDurationMs:90000,allowFixtureCleanup:true,observeProcess:r=>Number(r.ProcessId)===authorizedPid});
 let child,client;
 try{
  await supervisor.begin();
  report.initialIdentity=await Promise.race([readIdentityAndRelations([]),supervisor.failure]);
  report.packageManifestSHA256=hash(path.join(packageRoot,'build-manifest.json'));report.controllerSHA256=hash(path.join(appRoot,'dist/main/tools/DesktopAgent.js'));save();
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const fd=fs.openSync(path.join(out,'controller.log'),'w'),started=Date.now();
  child=spawn(path.join(packageRoot,'IEXA.exe'),['--max-old-space-size=384',worker,'__worker',appRoot,path.join(out,'journal'),'http://127.0.0.1:'+port],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);client=rpc(child);
  await supervisor.claimSpawn(child,worker,started);
  let readyTimer;try{await Promise.race([client.ready,supervisor.failure,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(Error('Controller readiness timed out')),15000);})]);}finally{clearTimeout(readyTimer);}
  const run=async (args,allowFailure=false)=>{
   assert.ok(report.actions.length<18,'Bounded desktop calls');
   const payload={backend:'native',controlMode:'foreground',focusPolicy:'stop',...args,detail:'raw'},startedAt=Date.now();
   const response=await Promise.race([client.request(payload),supervisor.failure]),entry={args:payload,startedAt,completedAt:Date.now(),...response.result};
   if(response.imageBase64){entry.image='frame-'+(report.actions.length+1)+'.png';fs.writeFileSync(path.join(out,entry.image),Buffer.from(response.imageBase64,'base64'));}
   report.actions.push(entry);save();if(!entry.success&&allowFailure)return null;assert.equal(entry.success,true,entry.output);return JSON.parse(entry.output).data;
  };
  // One authorized shell launch may resume a cloaked/suspended UWP instance.
  // Its returned window is not identity evidence and is never adopted directly.
  report.resumeAttempt={app:'C:\\Windows\\System32\\calc.exe',attempts:1,requestedAt:Date.now()};save();
  const resumed=await run({action:'launch',app:'C:\\Windows\\System32\\calc.exe',waitForWindowMs:10000},true);
  report.resumeAttempt.result=resumed;
  report.resumeAttempt.success=report.actions.at(-1).success;save();
  if(resumed?.window&&/^CalculatorApp(?:\.exe)?$/i.test(resumed.window.process||'')&&resumed.window.pid!==authorizedPid){
   report.unrelatedLaunchWindow=resumed.window;save();
   throw Error('Launch returned a different Calculator PID; it is not the authorized PID90704 and will not be closed by this script');
  }
  report.afterResumeIdentity=await Promise.race([readIdentityAndRelations([]),supervisor.failure]);save();
  // Modern Calculator can own its top-level CoreWindow directly. Prefer the
  // authorized PID's actual top-level HWND before considering hosted windows.
  const direct=await run({action:'list_windows',pid:authorizedPid,includeHidden:true,limit:100});
  assert.ok(Array.isArray(direct.windows));
  const directCandidates=direct.windows.filter(w=>w.pid===authorizedPid&&/^(计算器|Calculator)$/i.test(w.title||'')&&/^CalculatorApp(?:\.exe)?$/i.test(w.process||''));
  let candidates,relations,linked;
  if(directCandidates.length){
   assert.ok(directCandidates.length<=4,'Bounded direct Calculator candidates');
   relations=await Promise.race([readIdentityAndRelations(directCandidates.map(w=>w.handle)),supervisor.failure]);
   candidates=directCandidates;
   linked=candidates.filter(w=>relations.frames.some(f=>f.handle===w.handle&&f.pid===authorizedPid&&f.root===w.handle&&f.parent===0&&f.visible===true));
   report.windowRelationship='direct-authorized-pid-top-level';
  }else{
  const listed=await run({action:'list_windows',process:'ApplicationFrameHost',includeHidden:true,limit:100});
  assert.ok(Array.isArray(listed.windows));
  candidates=listed.windows.filter(w=>/^(计算器|Calculator)$/i.test(w.title||'')&&/^ApplicationFrameHost(?:\.exe)?$/i.test(w.process||''));
  assert.ok(candidates.length>0&&candidates.length<=4,'Bounded candidate Calculator frame windows');
  relations=await Promise.race([readIdentityAndRelations(candidates.map(w=>w.handle)),supervisor.failure]);
  linked=candidates.filter(w=>relations.frames.some(f=>f.handle===w.handle&&f.pid===w.pid&&Array.isArray(f.calculatorChildren)&&f.calculatorChildren.some(c=>c.pid===authorizedPid)));
  report.windowRelationship='framehost-authorized-pid-descendant';
  }
  report.relations=relations;save();
  assert.equal(linked.length,1,'Exactly one top-level window is linked by direct PID ownership or verified descendant ownership; title alone grants nothing');
  const frame=linked[0];report.authorizedFrame=frame;save();
  const observed=await run({action:'observe',handle:frame.handle,limit:160,captureFrame:true});
  assert.equal(observed.session.handle,frame.handle);
  report.uiaProcessEvidence=(observed.elements||[]).filter(e=>e.selector?.processId===authorizedPid).map(e=>({id:e.id,role:e.role,selector:e.selector}));
  // Revalidate original PID creation time and the live HWND descendant chain
  // immediately before the first foreground mutation.
  const finalProof=await Promise.race([readIdentityAndRelations([frame.handle]),supervisor.failure]);
  assert.equal(finalProof.frames.length,1);assert.equal(finalProof.frames[0].pid,frame.pid);
  if(report.windowRelationship==='direct-authorized-pid-top-level'){
   assert.equal(finalProof.frames[0].pid,authorizedPid);assert.equal(finalProof.frames[0].root,frame.handle);assert.equal(finalProof.frames[0].parent,0);assert.equal(finalProof.frames[0].visible,true);
  }else assert.ok(finalProof.frames[0].calculatorChildren.some(c=>c.pid===authorizedPid));
  report.preActivationProof=finalProof;save();
  await run({action:'activate',handle:frame.handle});
  const focused=await run({action:'observe',handle:frame.handle,limit:160,captureFrame:true});
  assert.equal(focused.session.foreground,true);assert.equal(focused.session.handle,frame.handle);
  const closed=await run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true});
  assert.equal(closed.windowClosed,true,'Packaged production controller confirmed exact HWND closure');
  const after=await run({action:'list_windows',handle:frame.handle,includeHidden:true,limit:1});
  assert.ok(Array.isArray(after.windows)&&after.windows.length===0,'Exact authorized Calculator HWND absent including hidden windows');
  report.windowClosed=true;report.status='passed';
 }catch(error){report.status='failed';report.error=error.stack;}
 finally{
  // Never retry a close, close a guessed HWND, claim PID90704, or terminate it.
  if(child?.connected)child.send({quit:true});
  if(child){const deadline=Date.now()+4000;while(child.exitCode===null&&Date.now()<deadline)await pause(100);if(child.exitCode===null){report.status='failed';report.controllerCloseError='Controller did not exit';}}
  client?.dispose();
  try{report.resources=await supervisor.finish();}catch(error){report.status='failed';report.resourceError=error.message;}
  report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,out,error:report.error,resourceError:report.resourceError}));process.exitCode=report.status==='passed'?0:1;
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
