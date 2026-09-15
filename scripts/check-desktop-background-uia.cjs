/* Native background regression, not autonomous/Chromium/product completion.
 * Builds and fingerprints the tested binary. Starts a NON-activating owned form.
 * Never activates/restores the user's foreground. WinEvent records transitions.
 * A rejected provider action is NOT counted as successful background business input.
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const net = require('node:net');
const { DesktopAgent } = require('../dist/main/tools/DesktopAgent');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.iexa-artifacts', 'desktop-background-audit', `${Date.now()}-${randomBytes(4).toString('hex')}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const observeOnly = process.argv.includes('--observe-only');
const report = { observeOnly, scope: 'native background regression only; not autonomous or Chromium acceptance', cases: [], actions: [] };
const children = []; let endpoint;
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
async function until(fn, label) { for (let i=0;i<100;i++) { const value = await fn(); if(value) return value; await wait(100); } throw new Error(label); }
async function check(name, fn) { try { const evidence = await fn(); report.cases.push({name,status:'passed',evidence}); } catch(e) { report.cases.push({name,status:'failed',error:e.stack}); } save(); }
function launch(file,args,env=process.env) {
 const log = fs.openSync(path.join(out,`child-${children.length}.log`),'a');
 const child=spawn(file,args,{env,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);child.on('error',e=>{report.launchError=e.message;save();});children.push(child);return child;
}
function readJson(name) { try {return JSON.parse(fs.readFileSync(path.join(out,name),'utf8').replace(/^\uFEFF/,''));}catch{return null;} }
function events() { return fs.existsSync(path.join(out,'foreground-events.jsonl')) ? fs.readFileSync(path.join(out,'foreground-events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
async function main() {
 fs.mkdirSync(out,{recursive:true});save();
 fs.writeFileSync(path.join(out,'build.log'),execFileSync('dotnet',['build','desktop-agent/Iexa.DesktopAgent.csproj','--no-restore'],{cwd:root,windowsHide:true,encoding:'utf8'}));
 const dir=path.join(root,'desktop-agent/bin/Debug/net8.0-windows10.0.19041.0');
 const exe=path.join(dir,'Iexa.DesktopAgent.exe');
 report.binary={path:exe,dllSha256:createHash('sha256').update(fs.readFileSync(path.join(dir,'Iexa.DesktopAgent.dll'))).digest('hex')};
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 endpoint=`http://127.0.0.1:${port}`;
 const native=launch(exe,[],{...process.env,IEXA_DESKTOP_PORT:String(port)});
 const health=await until(async()=>{try{const r=await fetch(endpoint+'/health',{signal:AbortSignal.timeout(400)});return r.ok?await r.json():null;}catch{return null;}},'Native readiness');
 assert.equal(health.pid,native.pid);assert.equal(path.normalize(health.executablePath).toLowerCase(),path.normalize(exe).toLowerCase());report.health=health;
 const title='IEXA Background Audit '+randomBytes(4).toString('hex');
 const fixture=launch('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/desktop-background-audit.ps1'),'-Title',title,'-OutputDirectory',out]);
 const ready=await until(()=>readJson('ready.json'),'Nonactivating fixture readiness');report.initial=ready;
 await until(()=>readJson('state.json'),'Foreground monitor readiness');
 const agent=new DesktopAgent(root,false,path.join(out,'journal'),endpoint);
 async function run(args,owner='audit') { const r=await agent.execute({...args,detail:'raw'},undefined,{owner});report.actions.push({action:args.action,success:r.success,output:r.output,desktop:r.metadata?.desktop});save();return r; }
 async function observe(){const r=await run({action:'observe',handle:ready.handle,pid:fixture.pid,includeElements:true});assert.equal(r.success,true,r.output);return JSON.parse(r.output).data;}
 await check('Nonactivating fixture preserves existing foreground',async()=>{assert.equal(readJson('state.json').foreground,ready.foreground);assert.deepEqual(events(),[]);return readJson('state.json');});
 await check('Actual background PrintWindow returns per-capture trust without HDC errors',async()=>{const data=await observe();assert.equal(data.frame.foreground,false);assert.equal(data.frame.trust,'background-window-rendered');assert.equal(data.frame.renderedHandle,ready.handle);const frame=await fetch(endpoint+'/frame?full=0');assert.equal(frame.status,200);assert.equal(frame.headers.get('x-iexa-capture-scope'),'bound-window');assert.equal(frame.headers.get('x-iexa-capture-trust'),'background-window-rendered');fs.writeFileSync(path.join(out,'background.png'),Buffer.from(await frame.arrayBuffer()));return data.frame;});
 await check('Native background bind does not activate; frame token matches exact observation and rejects stale tokens',async()=>{
  const bind=await fetch(endpoint+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'bind_window',handle:ready.handle,background:true})});
  assert.equal(bind.status,200);await wait(100);assert.equal(readJson('state.json').foreground,ready.foreground);assert.deepEqual(events(),[]);
  const snapshot=await observe();const token=snapshot.session.observationToken;
  const frame=await fetch(endpoint+'/frame?full=0&observationToken='+encodeURIComponent(token));
  assert.equal(frame.status,200);assert.equal(frame.headers.get('x-iexa-observation-token'),token);assert.equal(Number(frame.headers.get('x-captured-at')),snapshot.frame.capturedAt);
  await observe();const stale=await fetch(endpoint+'/frame?full=0&observationToken='+encodeURIComponent(token));assert.equal(stale.status,400);
  return {tokenBoundFrame:true,staleHttpStatus:stale.status,foregroundTransitions:events().length};
 });
 await check('Native rejects physical/activation requests before effects including nested batch',async()=>{
  for(const action of ['click','type','key','hotkey','drag','move','scroll','activate','launch','minimize','click_element']){
   const r=await fetch(endpoint+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,background:true,forcePointer:action==='click_element',text:'NO-INPUT',key:'A'})});
   const body=await r.json();assert.equal(r.status,400);assert.match(body.error,/Background/);
  }
  const r=await fetch(endpoint+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'batch',actions:[{action:'click',background:true}]})});assert.equal(r.status,400);
  assert.equal(fs.existsSync(path.join(out,'receipt.txt')),false);return {denied:12};
 });
 if (!observeOnly) await check('Real background Value then Invoke reaches independent receipt, zero foreground transitions',async()=>{
  await observe();const value='BACKGROUND-'+randomBytes(6).toString('hex');
  const typed=await run({action:'type',target:{automationId:'AuditInput'},text:value,background:true,verifyText:value});assert.equal(typed.success,true,typed.output);
  const clicked=await run({action:'click',target:{automationId:'AuditApply'},background:true,verifyText:'Applied '+value});assert.equal(clicked.success,true,clicked.output);
  assert.equal(fs.readFileSync(path.join(out,'receipt.txt'),'utf8'),value+'\n');await wait(200);
  assert.equal(readJson('state.json').foreground,ready.foreground);assert.deepEqual(events(),[]);
  return {receipt:'receipt.txt',foregroundTransitions:events().length,verified:clicked.metadata.desktop.verified};
 });
 if (observeOnly) report.cases.push({name:'Real background Value then Invoke',status:'not-run',reason:'Known WinForms provider focus change; retain failed full-run evidence, do not count a rejection as acceptance.'});
 await check('Closed bound window frame rejects rather than capturing other software',async()=>{
  fs.writeFileSync(path.join(out,'stop'),'');await until(()=>fixture.exitCode!==null,'Owned fixture close');
  const frame=await fetch(endpoint+'/frame?full=0');assert.equal(frame.status,400);assert.match((await frame.json()).error,/No|no/);return {httpStatus:frame.status};
 });
 report.foregroundTransitions=events();save();
 console.log(JSON.stringify({out,cases:report.cases,binary:report.binary},null,2));
 if(report.cases.some(c=>c.status==='failed'))process.exitCode=1;
}
main().catch(e=>{report.setupError=e.stack;console.error(e);process.exitCode=1;}).finally(async()=>{
 fs.mkdirSync(out,{recursive:true});save();fs.writeFileSync(path.join(out,'stop'),'');
 for(const child of children) {try{if(child.exitCode===null)child.kill();}catch{}}
});
