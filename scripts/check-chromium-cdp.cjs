/* Real CDP acceptance: deterministic tasks, not model planning. Default headless Edge;
 * --visible uses an isolated visible Electron/Chromium window with ShowInactive and
 * independent WinEvent foreground monitoring. No activation or pointer restoration. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
const {ChromiumCdpAdapter}=require('../dist/main/tools/desktop/ChromiumCdpAdapter');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts','chromium-cdp',`${Date.now()}-${randomUUID().slice(0,8)}`);
const visible=process.argv.includes('--visible'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const children=[],agents=[],receipts=[],report={scope:visible?'visible Electron/Chromium CDP with foreground hook':'headless Chromium CDP',cases:[],actions:[],receipts};
let server,endpoint,probe,focusMonitor,monitoring;const controller=new AbortController();
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
function launch(exe,args,env=process.env){const fd=fs.openSync(path.join(out,`child-${children.length}.log`),'a');const child=spawn(exe,args,{env,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(child);child.on('error',e=>{report.launchError=e.message;save();});return child;}
async function until(fn,label){for(let i=0;i<100;i++){const v=await fn();if(v)return v;await wait(75);}throw Error(label);}
function json(file){try{return JSON.parse(fs.readFileSync(path.join(out,file),'utf8').replace(/^\uFEFF/,''));}catch{return null;}}
function focusEvents(){try{return fs.readFileSync(path.join(out,'focus-events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
async function port(){return await new Promise(resolve=>{const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function check(name,fn){const started=Date.now();try{assert.equal(controller.signal.aborted,false,'External foreground activity interrupted acceptance');const evidence=await fn();report.cases.push({name,status:'passed',durationMs:Date.now()-started,evidence});}catch(e){report.cases.push({name,status:'failed',error:e.stack});}save();}
// Independent test disturbance channel. Task actions themselves ONLY use DesktopAgent.
async function connectProbe(target){const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});let seq=0;const pending=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});return {close:()=>socket.close(),send:(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('Disturbance command timed out'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));})};}
async function main(){
 fs.mkdirSync(out,{recursive:true});save();
 const appPort=await port(),cdpPort=await port();
 server=http.createServer(async(req,res)=>{
  if(req.url==='/submit'&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;receipts.push(JSON.parse(body));save();res.end('ok');return;}
  res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><title>IEXA CDP ${appPort}</title><label>Reference<input aria-label="Reference" id="reference"></label><button aria-label="Send" id="send">Send</button><p id="status">Ready</p><script>document.querySelector('#send').onclick=async()=>{const value=document.querySelector('#reference').value;await fetch('/submit',{method:'POST',body:JSON.stringify({value})});setTimeout(()=>document.querySelector('#status').textContent='Submitted '+value,240)};</script>`);
 });await new Promise(resolve=>server.listen(appPort,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${appPort}/`;endpoint=`http://127.0.0.1:${cdpPort}`;
 if(visible){
  focusMonitor=launch('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/foreground-audit.ps1'),'-OutputDirectory',out]);
  report.focusInitial=await until(()=>json('focus-ready.json'),'Foreground monitor readiness');
  const env={...process.env,IEXA_CDP_TEST_OUT:out,IEXA_CDP_TEST_URL:url,IEXA_CDP_TEST_PORT:String(cdpPort)};delete env.ELECTRON_RUN_AS_NODE;
  launch(require('electron'),[path.join(__dirname,'fixtures/chromium-visible.cjs')],env);
  report.visibleHost=await until(()=>json('visible-ready.json'),'Visible Chromium readiness');assert.equal(report.visibleHost.focused,false);assert.equal(report.visibleHost.visible,true);
 }else{
  const exe=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);assert.ok(exe,'Chromium missing');
  report.browser=exe;launch(exe,['--headless=new',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${path.join(out,'profile')}`,'--no-first-run','--no-default-browser-check','--disable-background-networking',url]);
 }
 const target=await until(async()=>{try{const rows=await(await fetch(endpoint+'/json/list')).json();return rows.find(t=>t.type==='page'&&t.url===url);}catch{return null;}},'Specific page target readiness');
 report.target={id:target.id,url:target.url};probe=await connectProbe(target);
 const mutate=async expression=>{const r=await probe.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.equal(!!r.exceptionDetails,false,JSON.stringify(r.exceptionDetails));return r.result?.value;};
 await until(()=>mutate("document.readyState === 'complete' && !!document.querySelector('#reference')"),'Page application readiness');
 if(visible)monitoring=setInterval(()=>{if(focusEvents().length)controller.abort();},30);
 const agent=new DesktopAgent(root,false,path.join(out,'journal'),'http://127.0.0.1:17996');agents.push(agent);
 const raw=async(args,owner='cdp',signal=controller.signal)=>{const r=await agent.execute({...args,detail:'raw'},signal,{owner,operationId:randomUUID()});report.actions.push({action:args.action,success:r.success,output:r.output,trace:r.metadata?.desktop});save();return r;};
 const run=async args=>{const r=await raw(args);assert.equal(r.success,true,r.output);return JSON.parse(r.output).data;};
 const observe=async()=>{
  for(let attempt=0;attempt<3;attempt++){
   const r=await raw({backend:'chromium-cdp',cdpEndpoint:endpoint,cdpTargetId:target.id,background:true,action:'observe',captureFrame:true});
   if(r.success)return JSON.parse(r.output).data;
   if(!/page changed during capture/.test(r.output)||attempt===2)throw Error(r.output);
   await wait(80); // Read-only recapture only; never retry a dispatched input.
  }
 };
 await check('Actual page screenshot and value append, delayed submission, independent receipt',async()=>{
  const snapshot=await observe();assert.equal(snapshot.frame.trust,'background-window-rendered');assert.ok(snapshot.frame.width>0&&snapshot.frame.height>0);
  const frame=await raw({action:'frame',background:true});assert.equal(frame.success,true,frame.output);fs.writeFileSync(path.join(out,'page.png'),frame.imageData);
  const value='CDP-'+randomUUID();await run({action:'type',background:true,target:{name:'Reference',role:'edit'},text:value,replace:true});
  await run({action:'type',background:true,target:{name:'Reference',role:'edit'},text:'-append',replace:false,verifyText:value+'-append'});
  await run({action:'click',background:true,target:{name:'Send',role:'button'},verifyText:'Submitted '+value+'-append'});
  assert.deepEqual(receipts,[{value:value+'-append'}]);return {receipt:receipts[0],frame:'page.png'};
 });
 await check('Replacing a node at identical ID/path rejects old snapshot before input',async()=>{
  await observe();const count=receipts.length;await mutate("{const e=document.querySelector('#send');const clone=e.cloneNode(true);clone.onclick=()=>fetch('/submit',{method:'POST',body:JSON.stringify({value:'WRONG-REPLACEMENT'})});e.replaceWith(clone)}");
  const r=await raw({action:'click',background:true,target:{automationId:'send'}});assert.equal(r.success,false);assert.equal(r.metadata.desktop.dispatchedActions,0);assert.equal(receipts.length,count);return {dispatched:0};
 });
 await check('User value change rejects stale typing instead of overwriting it',async()=>{
  await observe();await mutate("document.querySelector('#reference').value='USER-EDIT'");
  const r=await raw({action:'type',background:true,target:{automationId:'reference'},text:'WRONG'});assert.equal(r.success,false);assert.equal(r.metadata.desktop.dispatchedActions,0);assert.equal(await mutate("document.querySelector('#reference').value"),'USER-EDIT');return {userValuePreserved:true};
 });
 await check('A new observation invalidates old element IDs even when order matches',async()=>{
  const first=await observe();const id=first.elements.find(e=>e.selector?.automationId==='reference').id;await observe();
  const r=await raw({action:'type_element',background:true,elementId:id,text:'WRONG'});assert.equal(r.success,false);assert.equal(r.metadata.desktop.dispatchedActions,0);return {oldIdRejected:true};
 });
 await check('find_element and cancellable wait require no elementId',async()=>{
  await observe();const found=await run({action:'find_element',background:true,text:'USER-EDIT'});assert.ok(found.elements.length);
  const abort=new AbortController();const task=raw({action:'wait',background:true,text:'NEVER-'+randomUUID(),timeoutMs:5000},'cdp',abort.signal);setTimeout(()=>abort.abort(),120);
  const r=await task;assert.equal(r.cancelled,true,r.output);const after=await observe();assert.ok(after.session.observationToken);return {cancelled:true,reobserved:true};
 });
 await check('Reload invalidates old document capability and requires fresh observation',async()=>{
  await observe();await probe.send('Page.reload');await until(()=>mutate("document.readyState==='complete' && !!document.querySelector('#reference')"),'Reload readiness');
  const r=await raw({action:'type',background:true,target:{automationId:'reference'},text:'WRONG'});assert.equal(r.success,false);assert.equal(r.metadata.desktop.dispatchedActions,0);await observe();return {reloadRejectedOldInput:true};
 });
 await check('Multiple pages require explicit target; reconnect never chooses first page',async()=>{
  let created;
  if(visible){
   fs.writeFileSync(path.join(out,'create-second'),'');
   await until(()=>fs.existsSync(path.join(out,'second-ready')),'Second Electron page readiness');
   const rows=await(await fetch(endpoint+'/json/list')).json();created={targetId:rows.find(t=>t.url===url+'second').id};
  }else created=await probe.send('Target.createTarget',{url:url+'second',background:true});
  try{
   await until(async()=>{const rows=await(await fetch(endpoint+'/json/list')).json();return rows.some(t=>t.id===created.targetId);},'Second page readiness');
   const other=new ChromiumCdpAdapter(endpoint);agents.push(other);const ambiguous=await other.execute({action:'observe'});assert.equal(ambiguous.success,false);assert.match(ambiguous.output,/ambiguous/);
   const listed=await other.execute({action:'list_windows'});assert.equal(JSON.parse(listed.output).data.windows.length>=2,true);
   const selected=await observe();assert.equal(selected.session.handle,(await run({action:'list_windows'})).windows.find(w=>w.cdpTargetId===target.id).handle);
   return {ambiguityRejected:true,explicitTargetRetained:true};
  }finally{if(visible)fs.writeFileSync(path.join(out,'close-second'),'');else await probe.send('Target.closeTarget',{targetId:created.targetId});}
 });
 if(monitoring)clearInterval(monitoring);
 if(visible){
  await wait(100);report.focusEvents=focusEvents();fs.writeFileSync(path.join(out,'stop-monitor'),'');report.focusFinal=await until(()=>json('focus-ended.json'),'Foreground monitor stop');
  report.cases.push({name:'Visible background task leaves user foreground unchanged for full measured interval',status:report.focusEvents.length===0&&report.focusInitial.foreground===report.focusFinal.foreground?'passed':'failed',evidence:{initial:report.focusInitial,final:report.focusFinal,events:report.focusEvents}});
 }
 save();console.log(JSON.stringify({out,scope:report.scope,cases:report.cases},null,2));if(report.cases.some(c=>c.status!=='passed'))process.exitCode=1;
}
main().catch(e=>{report.setupError=e.stack;console.error(e);process.exitCode=1;}).finally(async()=>{
 fs.mkdirSync(out,{recursive:true});save();if(monitoring)clearInterval(monitoring);probe?.close();for(const agent of agents)agent.close();
 fs.writeFileSync(path.join(out,'stop-monitor'),'');fs.writeFileSync(path.join(out,'stop'),'');await wait(200);
 for(const child of children){try{if(child.exitCode===null)child.kill();}catch{}}
 server?.closeAllConnections();server?.close();
});
