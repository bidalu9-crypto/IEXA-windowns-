// Real headless Chromium acceptance: commit receipt -> force controller-process exit -> reconnect.
// No model-planning claim; no user profile, settings, foreground input, or production agent is touched.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn,fork}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts','desktop-recovery',`${Date.now()}-${randomUUID().slice(0,8)}`);
const journal=path.join(out,'desktop'),reference='RECOVER-'+randomUUID().slice(0,12),owner='crash-recovery-owner';
const report={scope:'Real headless Chromium, abrupt controller-process loss after independent HTTP commit; deterministic fault injection, not model autonomy',cases:[],receipts:[],actions:[],workerMessages:[]};
const wait=ms=>new Promise(r=>setTimeout(r,ms));let browser,worker,server;const agents=[];
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const until=async(fn,label,timeout=12000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await fn();if(value)return value;await wait(80);}throw Error(label);};
async function port(){return new Promise(resolve=>{const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function check(name,fn){const started=Date.now();await fn();report.cases.push({name,status:'passed',durationMs:Date.now()-started});save();}
async function main(){
 fs.mkdirSync(out,{recursive:true});save();
 const appPort=await port(),cdpPort=await port(),url=`http://127.0.0.1:${appPort}/`,endpoint=`http://127.0.0.1:${cdpPort}`;
 let committed;const receipt=new Promise(resolve=>committed=resolve);
 server=http.createServer(async(req,res)=>{
  if(req.url==='/submit'&&req.method==='POST'){
   let body='';for await(const part of req)body+=part;
   report.receipts.push({body:JSON.parse(body),receivedAt:Date.now()});save();res.end('committed');committed();return;
  }
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end(`<!doctype html><title>IEXA Recovery ${appPort}</title><label>Reference<input aria-label="Reference" id="reference"></label><button aria-label="Send" id="send">Send</button><p role="status" id="status">Ready</p><script>
  document.querySelector('#send').onclick=()=>{
    const value=document.querySelector('#reference').value;
    const xhr=new XMLHttpRequest();xhr.open('POST','/submit',false);xhr.send(JSON.stringify({value}));
    // Test-only deterministic fault window: controller dies while Runtime.callFunctionOn is pending.
    const end=performance.now()+2000;while(performance.now()<end){}
    document.querySelector('#status').textContent='Submitted '+value;
  };</script>`);
 });await new Promise(resolve=>server.listen(appPort,'127.0.0.1',resolve));
 const exe=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);assert.ok(exe,'Chromium executable missing');
 const fd=fs.openSync(path.join(out,'browser.log'),'a');
 browser=spawn(exe,['--headless=new',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${path.join(out,'profile')}`,'--no-first-run','--no-default-browser-check','--disable-background-networking',url],{windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);
 browser.on('error',e=>{report.browserError=e.stack;save();});report.browser={exe,pid:browser.pid,visible:false};
 const target=await until(async()=>{try{return (await(await fetch(endpoint+'/json/list')).json()).find(t=>t.type==='page'&&t.url===url);}catch{return null;}},'Owned page readiness');
 report.target={id:target.id};
 const workerLog=fs.openSync(path.join(out,'worker.log'),'a');
 worker=fork(path.join(__dirname,'fixtures/desktop-recovery-worker.cjs'),[root,journal,endpoint,target.id,reference],{windowsHide:true,stdio:['ignore',workerLog,workerLog,'ipc']});fs.closeSync(workerLog);
 worker.on('message',message=>{report.workerMessages.push(message);save();});
 worker.on('error',e=>{report.workerError=e.stack;save();});
 const exited=new Promise(resolve=>worker.once('exit',(code,signal)=>{report.workerExit={code,signal,timestamp:Date.now()};resolve();}));
 await check('Independent server commit occurs while controller input has no terminal outcome',async()=>{
  let timer;try{await Promise.race([receipt,exited.then(()=>{throw Error('Controller exited before commit');}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Commit timeout')),20000))]);}finally{clearTimeout(timer);}
  assert.equal(report.receipts.length,1);assert.equal(report.receipts[0].body.value,reference);
  report.killRequestedAt=Date.now();assert.equal(worker.kill(),true);await exited;
  const file=path.join(journal,createHash('sha256').update(owner).digest('hex')+'.jsonl');
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.operationId==='crash-submit');
  report.crashSubmitEvents=rows;assert.equal(rows.at(-1).phase,'action_start');assert.equal(rows.at(-1).inputMayHaveExecuted,true);
  assert.equal(rows.some(e=>['action_end','completed','cancelled','failed'].includes(e.phase)),false);
 });
 const base={backend:'chromium-cdp',cdpEndpoint:endpoint,cdpTargetId:target.id,background:true};
 const make=()=>{const agent=new DesktopAgent(root,false,journal);agents.push(agent);return agent;};
 const execute=async(agent,args)=>{const result=await agent.execute({...base,...args},undefined,{owner,operationId:randomUUID()});report.actions.push({action:args.action,success:result.success,output:result.output,desktop:result.metadata?.desktop});save();return result;};
 const agent=make();
 await check('New controller rejects input before a fresh observation; crash risk survives restart',async()=>{
  const denied=await execute(agent,{action:'click',target:{name:'Send',role:'button'},detail:'raw'});
  assert.equal(denied.success,false);assert.match(denied.output,/Fresh observe/);
  assert.ok(denied.metadata.desktop.recovered.unresolvedOperations.some(op=>op.operationId==='crash-submit'&&op.interrupted&&op.inputMayHaveExecuted));
  assert.equal(report.receipts.length,1);
 });
 await check('Read-only reconnection verifies exact committed UI and independent receipt without resubmitting',async()=>{
  let observed;
  await until(async()=>{
   observed=await execute(agent,{action:'observe',detail:'raw'});
   if(!observed.success){assert.match(observed.output,/page changed during capture/);return false;}
   return JSON.parse(observed.output).data.elements.some(e=>e.role==='status'&&e.text==='Submitted '+reference);
  },'Post-crash exact UI status',15000);
  assert.ok(observed.metadata.desktop.recovered.unresolvedOperations.some(op=>op.operationId==='crash-submit'));
  report.businessVerified=true;assert.equal(report.receipts.length,1);
  agent.close();
 });
 await check('Second reconnection and compact model output retain older uncertainty after newer successful observations',async()=>{
  const second=make();const state=await execute(second,{action:'session_state',detail:'raw'});assert.equal(state.success,true,state.output);
  const recovery=JSON.parse(state.output).data.control.recovered;
  assert.equal(recovery.journalIntegrity,'complete');assert.ok(recovery.unresolvedOperations.some(op=>op.operationId==='crash-submit'));
  const observed=await execute(second,{action:'observe'});assert.equal(observed.success,true,observed.output);
  assert.match(observed.output,/恢复警告/);assert.match(observed.output,/crash-submit/);assert.match(observed.output,/不要重复提交/);
  assert.equal(report.receipts.length,1);
  const text=fs.readFileSync(path.join(journal,createHash('sha256').update(owner).digest('hex')+'.jsonl'),'utf8');
  assert.equal(text.includes(reference),false);assert.equal(text.includes('observationToken'),false);assert.equal(text.includes(endpoint),false);
 });
 if(process.argv.includes('--model-resume'))await check('Actual configured model reads recovered uncertainty, verifies current result and does not repeat submission',async()=>{
  report.modelRecovery=await require('./helpers/desktop-recovery-model.cjs').checkRecoveryModel({root,out,endpoint,targetId:target.id,owner,reference});
  assert.equal(report.modelRecovery.status,'passed',JSON.stringify({error:report.modelRecovery.error,evidence:report.modelRecovery.evidence,warning:report.modelRecovery.recoveryWarningReceived}));
  assert.equal(report.receipts.length,1,'Model repeated a committed submission');
 });
 report.status='passed';report.duplicateSubmissions=report.receipts.length-1;save();
}
main().catch(e=>{report.status='failed';report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 for(const agent of agents)agent.close();
 if(worker&&worker.exitCode===null&&worker.signalCode===null)worker.kill();
 if(browser&&browser.exitCode===null&&browser.signalCode===null){
  await new Promise(resolve=>{const killer=spawn('taskkill.exe',['/PID',String(browser.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('exit',resolve);killer.once('error',resolve);});
 }
 server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());
 save();console.log(JSON.stringify({out,status:report.status,cases:report.cases,error:report.error,duplicateSubmissions:report.duplicateSubmissions},null,2));
});
