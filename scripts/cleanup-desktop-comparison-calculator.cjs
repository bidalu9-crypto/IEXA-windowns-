'use strict';
// Explicit GUI cleanup of one failed acceptance run. No target process is claimed
// or terminated: only its proven launch HWND may receive one ALT+F4.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const {createSupervisor,processTable}=require('./helpers/acceptance-supervisor.cjs');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function rpc(child){
 let sequence=0,readyResolve,readyReject;const pending=new Map();
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
 const fail=error=>{readyReject(error);for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
 child.once('error',fail);child.once('exit',code=>fail(Error('Cleanup worker exited: '+code)));
 child.on('message',message=>{if(message.ready)return readyResolve();const item=pending.get(message.id);if(!item)return;clearTimeout(item.timer);pending.delete(message.id);message.error?item.reject(Error(message.error)):item.resolve(message);});
 return {ready,request(args){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);child.connected&&child.send({cancel:true});reject(Error('Cleanup GUI action timed out'));},25000);pending.set(id,{resolve,reject,timer});child.send({id,args});});},dispose(){fail(Error('Cleanup RPC disposed'));}};
}
function successfulLaunch(report){
 const calls=new Map((report.calls||[]).map(call=>[call.id,call]));
 const launches=[];
 for(const event of report.events||[]){
  if(event.event!=='tool_result'||event.data?.success!==true)continue;
  const call=calls.get(event.data.id);if(call?.args?.action!=='launch')continue;
  for(const line of String(event.data.output||'').split('\n')){
   let data;try{const value=JSON.parse(line);data=value.data||value;}catch{continue;}
   if(data.launched===true&&data.window?.handle&&/calc\.exe$/i.test(data.executable||''))launches.push({callId:call.id,...data});
  }
 }
 assert.equal(launches.length,1,'Exactly one successful new Calculator launch receipt is required');return launches[0];
}
async function main(input){
 assert.ok(input,'Usage: node scripts/cleanup-desktop-comparison-calculator.cjs <run-directory>');
 const source=path.resolve(input),sourceReport=path.join(source,'report.json'),watchdogFile=path.join(source,'resource-watchdog.json');
 const original=JSON.parse(fs.readFileSync(sourceReport,'utf8')),watchdog=JSON.parse(fs.readFileSync(watchdogFile,'utf8'));
 assert.equal(original.kind,'calculator');assert.equal(original.mode,'iexa');assert.notEqual(original.comparisonMode,'authorized-existing');
 const launch=successfulLaunch(original),handle=Number(launch.window.handle);
 assert.ok(Number.isSafeInteger(handle)&&handle>0);assert.match(launch.window.title,/^(计算器|Calculator)$/i);
 const observed=(watchdog.observedProcesses||[]).filter(row=>/^CalculatorApp\.exe$/i.test(row.name));
 assert.equal(observed.length,1,'Exactly one observed Calculator process is required');const app=observed[0];
 assert.equal((watchdog.baselineObservedProcesses||[]).some(row=>row.identity===app.identity),false,'Never close a baseline application');
 assert.ok(Date.parse(app.created)>=Date.parse(original.startedAt),'Target process must have started during this run');
 const originalText=JSON.stringify(original.events||[]);
 assert.ok(originalText.includes('\\"processId\\":'+app.pid),'Successful report must link the UIA Calculator controls to the observed PID');
 const packageRoot=path.resolve(process.env.IEXA_TEST_PACKAGE||path.join(root,'release/IEXA-preview-20261109')),appRoot=path.join(packageRoot,'resources/app');
 const out=path.join(source,'gui-cleanup-'+Date.now());fs.mkdirSync(out,{recursive:true});
 const report={status:'running',scope:'One exact run-launched Calculator HWND; GUI ALT+F4 only; no target PID ownership or termination',sourceReport,sourceSHA256:sha(sourceReport),watchdogSHA256:sha(watchdogFile),launch,app,actions:[],startedAt:new Date().toISOString()};
 const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 const supervisor=createSupervisor({output:out,maximumDurationMs:120000,allowFixtureCleanup:true,observeProcess:row=>Number(row.ProcessId)===app.pid});
 let child,client;
 try{
  await supervisor.begin();
  const worker=path.join(root,'scripts/check-desktop-keyboard-regression.cjs');
  report.workerSHA256=sha(worker);report.packageManifestSHA256=sha(path.join(packageRoot,'build-manifest.json'));report.controllerSHA256=sha(path.join(appRoot,'dist/main/tools/DesktopAgent.js'));
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
  const fd=fs.openSync(path.join(out,'controller.log'),'w'),started=Date.now();
  child=spawn(path.join(packageRoot,'IEXA.exe'),['--max-old-space-size=384',worker,'__worker',appRoot,path.join(out,'journal'),'http://127.0.0.1:'+port],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);client=rpc(child);
  await supervisor.claimSpawn(child,worker,started);await Promise.race([client.ready,supervisor.failure]);
  const run=async args=>{
   assert.ok(report.actions.length<8,'Cleanup bounded to eight GUI calls');
   const payload={backend:'native',controlMode:'foreground',focusPolicy:'stop',detail:'raw',...args};
   const response=await Promise.race([client.request(payload),supervisor.failure]);
   report.actions.push({args:payload,result:response.result,at:Date.now()});
   if(response.imageBase64)fs.writeFileSync(path.join(out,'frame-'+report.actions.length+'.png'),Buffer.from(response.imageBase64,'base64'));save();
   assert.equal(response.result.success,true,response.result.output);return JSON.parse(response.result.output).data;
  };
  const exact=await run({action:'list_windows',handle,includeHidden:true,limit:1});assert.ok(Array.isArray(exact.windows));
  if(exact.windows.length===0){report.status='already-absent';report.closedHandle=handle;return;}
  assert.equal(exact.windows.length,1);assert.equal(exact.windows[0].handle,handle);assert.equal(exact.windows[0].pid,launch.window.pid);assert.equal(exact.windows[0].process,launch.window.process);assert.match(exact.windows[0].title,/^(计算器|Calculator)$/i);
  const validateProcess=async()=>{const rows=await processTable();const current=rows.find(row=>row.ProcessId===app.pid);assert.ok(current,'Original Calculator process must still exist');assert.equal(current.CreationDate,app.created,'Exact creation timestamp prevents PID reuse');assert.equal(current.Name,app.name);return current;};
  report.currentApp=await validateProcess();
  const observation=await run({action:'observe',handle,limit:100,captureFrame:true});
  assert.equal(observation.session?.handle,handle);assert.equal(observation.foreground?.pid,launch.window.pid);
  assert.ok(observation.elements?.some(element=>element.selector?.automationId==='CalculatorResults'&&element.selector?.processId===app.pid),'Current exact HWND exposes Calculator controls from the same proven application PID');
  await validateProcess();
  await run({action:'activate',handle});
  await validateProcess();
  const closed=await run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true});assert.equal(closed.windowClosed,true);assert.equal(closed.closedHandle,handle);
  const after=await run({action:'list_windows',handle,includeHidden:true,limit:1});assert.deepEqual(after.windows,[]);
  report.status='passed';report.closedHandle=handle;
 }catch(error){report.status='failed';report.error=error.stack;}
 finally{
  if(child?.connected)child.send({quit:true});
  if(child){const until=Date.now()+5000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<until)await pause(100);}
  client?.dispose();
  try{report.resources=await supervisor.finish();}catch(error){report.resourceError=error.message;report.status='failed';}
  report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,out,error:report.error,resourceError:report.resourceError}));process.exitCode=['passed','already-absent'].includes(report.status)?0:1;
 }
}
main(process.argv[2]).catch(error=>{console.error(error.stack);process.exitCode=1;});
