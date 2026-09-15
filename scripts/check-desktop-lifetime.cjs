// Native process-lifetime acceptance. No desktop observation or user input.
const {fork}=require('node:child_process');
const net=require('node:net'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const exe=path.resolve(process.argv[2]||'desktop-agent/publish/Iexa.DesktopAgent.exe');
const output=process.argv[3];
const report={executable:exe,cases:[],scope:'process lifetime only; no desktop input'};
const owners=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error(label);}
async function setup(idle){
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const owner=fork(path.join(__dirname,'fixtures/desktop-lifetime-owner.cjs'),[exe,String(port),idle||''],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});owners.push(owner);
 const {pid,error}=await new Promise((resolve,reject)=>{owner.once('message',resolve);owner.once('error',reject);owner.once('exit',()=>reject(Error('owner exited before spawn')));});assert.ok(!error,error);
 const endpoint='http://127.0.0.1:'+port;
 let health;await until(async()=>{try{health=await (await fetch(endpoint+'/health',{signal:AbortSignal.timeout(250)})).json();return true;}catch{return false;}},'native readiness');
 assert.equal(health.pid,pid);assert.equal(health.lifecycle.ownerPipe,true);assert.equal(health.lifecycle.version,1);
 return {owner,pid,endpoint,health};
}
async function main(){
 for(const mode of ['close','exit','crash']){
  const f=await setup();const began=Date.now();
  if(mode==='crash')f.owner.kill('SIGKILL');else f.owner.send(mode);
  await until(()=>!alive(f.pid),'helper survived owner '+mode);
  report.cases.push({name:mode==='close'?'Explicit application shutdown releases helper while owner remains alive':mode==='exit'?'Owner normal process exit releases helper':'Owner forced termination releases helper without JS cleanup',status:'passed',exitMs:Date.now()-began});
  if(mode==='close')assert.equal(f.owner.exitCode,null);
  if(f.owner.exitCode===null&&f.owner.signalCode===null)f.owner.kill();
 }
 const f=await setup();assert.equal(f.health.lifecycle.idleTimeoutMs,30000);const began=Date.now();let polls=0;
 await until(async()=>{if(!alive(f.pid))return true;try{await fetch(f.endpoint+'/health',{signal:AbortSignal.timeout(200)});await fetch(f.endpoint+'/frame?cached=1',{signal:AbortSignal.timeout(200)});polls++;}catch{}return !alive(f.pid);},'health/preview kept native process resident',35000);
 assert.ok(Date.now()-began>=28000);report.cases.push({name:'Default 30-second idle timeout exits despite health and cached-preview polling',status:'passed',exitMs:Date.now()-began,polls});
 f.owner.kill();
 const renewed=await setup('1500');await sleep(900);
 const response=await fetch(renewed.endpoint+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'session_state'}),signal:AbortSignal.timeout(1000)});assert.equal(response.status,200);
 await sleep(900);assert.equal(alive(renewed.pid),true);await until(()=>!alive(renewed.pid),'idle renewal did not expire',2000);renewed.owner.kill();
 report.cases.push({name:'An explicit read-only desktop request renews idle lease; polling does not',status:'passed'});
 report.status='passed';
}
main().catch(e=>{report.status='failed';report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 for(const owner of owners)if(owner.exitCode===null&&owner.signalCode===null)owner.kill();
 await sleep(250);if(output)fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
});
