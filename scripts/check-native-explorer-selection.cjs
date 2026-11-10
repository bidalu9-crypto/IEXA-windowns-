'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {createSupervisor}=require('./helpers/acceptance-supervisor.cjs');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+12000;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch{}await wait(150);}throw Error(label);}
async function main(){
 const out=path.join(root,'.iexa-artifacts/desktop-autonomy-20261110','selection-'+Date.now()),fixture=path.join(out,'fixture'),name='select-'+randomUUID().slice(0,8),childDir=path.join(fixture,name),marker='entered-'+randomUUID().slice(0,8)+'.txt';
 fs.mkdirSync(childDir,{recursive:true});fs.writeFileSync(path.join(childDir,marker),'Selection and activation are different operations.');
 const report={status:'running',actions:[],checks:[]},save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 const supervisor=createSupervisor({output:out,maximumDurationMs:90000});let helper,agent,endpoint,handle;
 try{
  await supervisor.begin();const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});endpoint='http://127.0.0.1:'+port;
  const fd=fs.openSync(path.join(out,'native.log'),'w'),started=Date.now();helper=spawn(path.join(root,'desktop-agent/publish/Iexa.DesktopAgent.exe'),[],{cwd:root,env:{...process.env,IEXA_DESKTOP_PORT:String(port)},windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);await supervisor.claimSpawn(helper,'Iexa.DesktopAgent.exe',started);
  await until(async()=>{const h=await(await fetch(endpoint+'/health')).json();return h.pid===helper.pid;},'helper readiness');
  const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');agent=new DesktopAgent(root,false,path.join(out,'journal'),endpoint);
  const run=async args=>{const r=await agent.execute({...args,detail:'raw'},undefined,{owner:'selection',operationId:randomUUID()});report.actions.push({args,success:r.success,output:r.output});if(r.imageData)fs.writeFileSync(path.join(out,'frame-'+report.actions.length+'.png'),r.imageData);save();assert.equal(r.success,true,r.output);return JSON.parse(r.output).data;};
  const launched=await run({action:'launch',backend:'native',controlMode:'foreground',focusPolicy:'activate',app:'explorer.exe',arguments:'"'+fixture+'"'});handle=launched.window.handle;
  let observed=await run({action:'observe',handle,captureFrame:true,limit:120});
  const item=observed.elements.find(e=>e.role==='listitem'&&e.text===name);assert.ok(item,'new fixture folder visible');
  const selected=await run({action:'click_element',elementId:item.id,count:1});assert.equal(selected.method,'uia_select_focus');
  observed=await run({action:'key',key:'F2',captureFrame:true});
  observed=await run({action:'observe',captureFrame:true,limit:120});
  const focused=await run({action:'read_focused'});
  assert.equal(focused.role,'edit','F2 focuses the rename editor');
  assert.equal(focused.text,name,'rename editor contains the selected folder name');
  report.checks.push({name:'Single click selects without opening and F2 opens rename editor',passed:true});save();
  await run({action:'key',key:'ESC'});
  observed=await run({action:'observe',limit:120});const again=observed.elements.find(e=>e.role==='listitem'&&e.text===name);assert.ok(again);
  await run({action:'click_element',elementId:again.id,count:2});
  observed=await until(async()=>{const o=await run({action:'observe',captureFrame:true,limit:120});return o.elements.some(e=>e.text.includes(marker.replace(/\.txt$/,'')))&&o;},'double click enters the folder');
  assert.ok(fs.existsSync(childDir));assert.deepEqual(fs.readdirSync(fixture),[name]);
  report.checks.push({name:'Explicit double click opens folder, cancelled rename leaves filesystem unchanged',passed:true});report.status='passed';
 }catch(error){report.status='failed';report.error=error.stack;}
 finally{
  if(agent&&handle){try{await agent.execute({action:'observe',handle,controlMode:'foreground',focusPolicy:'activate'},undefined,{owner:'selection'});await agent.execute({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true},undefined,{owner:'selection'});const r=await agent.execute({action:'list_windows',handle,detail:'raw'},undefined,{owner:'selection'});const data=JSON.parse(r.output).data;report.windowClosed=!(data.windows||[]).some(w=>w.handle===handle);if(!report.windowClosed)report.status='failed';}catch(error){report.closeError=error.message;report.status='failed';}}
  agent?.close();if(helper){try{await fetch(endpoint+'/shutdown',{method:'POST'});await until(()=>helper.exitCode!==null,'helper exit');}catch(error){report.closeError=error.message;report.status='failed';}}
  try{report.resources=await supervisor.finish();}catch(error){report.resourceError=error.message;report.status='failed';}save();console.log(JSON.stringify({status:report.status,error:report.error,closeError:report.closeError,resourceError:report.resourceError,out}));process.exitCode=report.status==='passed'?0:1;
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
