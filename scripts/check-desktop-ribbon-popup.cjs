'use strict';
// Fixed GUI regression, not a model benchmark. All GUI actions use the packaged
// production DesktopAgent worker; no existing application is claimed or closed.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const {createSupervisor,processTable}=require('./helpers/acceptance-supervisor.cjs');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function rpc(child){
 let sequence=0,resolveReady,rejectReady;const pending=new Map();
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
 const fail=error=>{rejectReady(error);for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
 child.once('error',fail);child.once('exit',code=>fail(Error('Production worker exited: '+code)));
 child.on('message',message=>{if(message.ready)return resolveReady();const item=pending.get(message.id);if(!item)return;clearTimeout(item.timer);pending.delete(message.id);message.error?item.reject(Error(message.error)):item.resolve(message);});
 return {ready,request(args){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);child.connected&&child.send({cancel:true});reject(Error('GUI action timeout'));},25000);pending.set(id,{resolve,reject,timer});child.send({id,args},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});});},dispose(){fail(Error('RPC disposed'));}};
}
async function main(){
 const packageRoot=path.resolve(process.env.IEXA_TEST_PACKAGE||path.join(root,'release/IEXA-preview-20261109')),appRoot=path.join(packageRoot,'resources/app');
 const out=path.join(root,'.iexa-artifacts/desktop-comparison-20261110','ribbon-popup-'+Date.now());fs.mkdirSync(out,{recursive:true});
 const report={status:'running',scope:'Fixed GUI: new blank Paint File ribbon popup entry and ESC return through production controller; no model',startedAt:new Date().toISOString(),packageRoot,actions:[],checks:[]};
 const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 const supervisor=createSupervisor({output:out,maximumDurationMs:90000,allowFixtureCleanup:true,observeProcess:row=>/^mspaint\.exe$/i.test(row.Name)});
 let child,client,timer,deadlineReject,closed=false;
 const deadline=new Promise((_,reject)=>{deadlineReject=reject;});deadline.catch(()=>{});
 try{
  await supervisor.begin();
  const baseline=await processTable();assert.equal(baseline.filter(row=>/^mspaint\.exe$/i.test(row.Name)).length,0,'Existing Paint process prevents test; leave it untouched');
  const worker=path.join(root,'scripts/check-desktop-keyboard-regression.cjs');
  report.workerSHA256=sha(worker);report.controllerSHA256=sha(path.join(appRoot,'dist/main/tools/DesktopAgent.js'));report.packageManifestSHA256=sha(path.join(packageRoot,'build-manifest.json'));save();
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const fd=fs.openSync(path.join(out,'controller.log'),'w'),spawnedAt=Date.now();
  child=spawn(path.join(packageRoot,'IEXA.exe'),['--max-old-space-size=384',worker,'__worker',appRoot,path.join(out,'journal'),'http://127.0.0.1:'+port],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);client=rpc(child);
  await supervisor.claimSpawn(child,worker,spawnedAt);
  timer=setTimeout(()=>{child?.connected&&child.send({cancel:true});deadlineReject(Error('Fixed GUI regression exceeded 90 seconds'));},90000);
  await Promise.race([client.ready,supervisor.failure,deadline]);
  const run=async args=>{
   assert.ok(report.actions.length<16,'Bounded fixed GUI call count');
   const payload={backend:'native',controlMode:'foreground',focusPolicy:'stop',detail:'raw',...args};
   const response=await Promise.race([client.request(payload),supervisor.failure,deadline]);
   const item={args:payload,result:response.result,at:Date.now()};
   if(response.imageBase64){item.image='frame-'+(report.actions.length+1)+'.png';fs.writeFileSync(path.join(out,item.image),Buffer.from(response.imageBase64,'base64'));}
   report.actions.push(item);save();assert.equal(response.result.success,true,response.result.output);return JSON.parse(response.result.output).data;
  };
  const listed=await run({action:'list_windows',process:'mspaint',includeHidden:true,limit:100});assert.ok(Array.isArray(listed.windows));assert.equal(listed.windows.length,0,'Existing Paint windows prevent test');
  const baselineHandles=new Set(listed.windows.map(window=>window.handle));
  const launchAt=Date.now(),launch=await run({action:'launch',app:'C:\\Windows\\System32\\mspaint.exe',forceNew:true});
  assert.equal(launch.launched,true,'A new Paint instance must be launched');assert.ok(launch.window?.handle);assert.match(launch.window.process,/^mspaint$/i);assert.equal(baselineHandles.has(launch.window.handle),false);
  const owner=launch.window;report.owner=owner;
  const claimed=await supervisor.claimFixture([owner.pid],'mspaint');assert.equal(claimed.length,1);assert.equal(claimed[0].ProcessId,owner.pid);assert.ok(Date.parse(claimed[0].CreationDate)>=launchAt,'Only this run-created process can be cleaned');report.ownedPaint={pid:owner.pid,created:claimed[0].CreationDate};save();
  const observed=await run({action:'observe',handle:owner.handle,limit:160,captureFrame:true});
  assert.equal(observed.session.handle,owner.handle);
  const file=observed.elements.find(element=>['button','tabitem','menuitem'].includes(element.role)&&/^(文件|File)$|文件.*选项卡|File.*tab/i.test(element.selector?.name||element.text||''));
  assert.ok(file,'Current observation must identify the File ribbon control');report.fileControl={id:file.id,selector:file.selector};save();
  const opened=await run({action:'click_element',elementId:file.id,captureFrame:true});
  const popup=opened.postObservation;assert.ok(popup?.handle&&popup.handle!==owner.handle,'Successful action automatically observes a different popup HWND');
  assert.equal(popup.window?.pid,owner.pid,'Popup belongs to exact Paint PID');
  const popupListed=await run({action:'list_windows',handle:popup.handle,includeHidden:true,limit:1});assert.equal(popupListed.windows.length,1);
  const popupWindow=popupListed.windows[0];assert.equal(popupWindow.handle,popup.handle);assert.equal(popupWindow.pid,owner.pid);assert.equal(popupWindow.ownerHandle,owner.handle);assert.equal(popupWindow.className,'Net UI Tool Window Layered');
  report.popup=popupWindow;report.checks.push({name:'File action succeeds and automatically binds same-PID owned NetUI popup',passed:true});save();
  const ocrObserved=await run({action:'observe',handle:popup.handle,includeOcr:true,captureFrame:true,limit:160});
  assert.equal(ocrObserved.session?.handle,popup.handle,'OCR observation stays on the exact accepted popup');
  assert.equal(ocrObserved.frame?.trust,'foreground');assert.equal(ocrObserved.ocr?.status,'ok');assert.ok(ocrObserved.ocr.count>0,'Native OCR must report actual recognized text');
  const retainedOcr=(ocrObserved.elements||[]).filter(element=>element.source==='ocr'&&String(element.text||'').trim());
  assert.ok(retainedOcr.length>=2,'Multiple nonempty OCR menu elements survive the merged semantic observation');
  assert.ok(report.actions.at(-1).image,'OCR observation includes its matching screenshot');
  report.popupOcr={status:ocrObserved.ocr.status,count:ocrObserved.ocr.count,retainedCount:retainedOcr.length,elements:retainedOcr.map(element=>({id:element.id,text:element.text,bounds:element.bounds}))};
  report.checks.push({name:'Foreground ribbon OCR returns multiple retained menu text elements and screenshot',passed:true});save();
  const escaped=await run({action:'key',key:'ESC',captureFrame:true});
  assert.equal(escaped.postObservation?.handle,owner.handle,'ESC automatically returns observation to original Paint owner');assert.equal(escaped.postObservation?.window?.pid,owner.pid);
  const state=await run({action:'session_state'});assert.equal(state.handle,owner.handle);assert.equal(state.foreground,true);
  report.checks.push({name:'ESC succeeds and returns session to exact original owner',passed:true});save();
  const identity=(await processTable()).find(row=>row.ProcessId===owner.pid);assert.ok(identity);assert.equal(identity.CreationDate,report.ownedPaint.created,'Verify process identity immediately before closing');
  const close=await run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true});assert.equal(close.windowClosed,true);assert.equal(close.closedHandle,owner.handle);
  const absent=await run({action:'list_windows',handle:owner.handle,includeHidden:true,limit:1});assert.deepEqual(absent.windows,[]);closed=true;
  report.checks.push({name:'ALT+F4 succeeds and exact original HWND is absent including hidden windows',passed:true});report.status='passed';
 }catch(error){report.status='failed';report.error=error.stack;}
 finally{
  clearTimeout(timer);report.guiClosed=closed;
  if(child?.connected)child.send({quit:true});
  if(child){const until=Date.now()+5000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<until)await pause(100);}
  client?.dispose();
  try{report.resources=await supervisor.finish();}catch(error){report.resourceError=error.message;report.status='failed';}
  report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,out,error:report.error,resourceError:report.resourceError}));process.exitCode=report.status==='passed'?0:1;
 }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
