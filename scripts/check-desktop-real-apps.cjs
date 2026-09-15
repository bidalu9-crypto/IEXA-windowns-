/* Real-app control benchmark. Explicitly NOT a score for autonomous model planning.
 * Runner uses only desktop_control for task input; server receipts/files are independent oracles.
 * No personal browser profile, existing document, or production helper is used. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),{randomBytes}=require('node:crypto');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
const root=path.resolve(__dirname,'..'),seed=process.env.IEXA_BENCHMARK_SEED||randomBytes(4).toString('hex');
if(!/^[a-zA-Z0-9-]{1,32}$/.test(seed))throw new Error('Invalid benchmark seed');
const out=path.join(root,'.iexa-artifacts','desktop-real-apps',`${Date.now()}-${seed}`);
const endpoint='http://127.0.0.1:17984',children=[],cases=[],events=[],receipts=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));let server,agent,helperStarted=false;
function record(){fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({seed,scope:'real-app control integration; NOT autonomous LLM benchmark',cases,receipts,events},null,2));}
async function raw(args,owner='benchmark',signal){const result=await agent.execute({...args,detail:'raw'},signal,{owner});events.push({action:args.action,owner,success:result.success,output:result.output,desktop:result.metadata?.desktop});record();return result;}
async function run(args,owner){const result=await raw(args,owner);assert.equal(result.success,true,result.output);return JSON.parse(result.output).data;}
async function check(name,fn){const started=Date.now();try{const evidence=await fn();cases.push({name,status:'passed',durationMs:Date.now()-started,evidence});}catch(e){cases.push({name,status:'failed',durationMs:Date.now()-started,error:e.stack});console.error(`${name}: ${e.message}`);}record();}
async function windows(filter){return (await run({action:'list_windows',includeHidden:true,...filter,limit:100})).windows;}
async function waitWindow(filter){for(let i=0;i<40;i++){const found=await windows(filter);if(found.length)return found[0];await wait(200);}throw new Error('Owned application window did not appear: '+JSON.stringify(filter));}
function launch(file,args){const child=spawn(file,args,{windowsHide:true,stdio:'ignore'});child.on('error',e=>events.push({launchError:e.message}));children.push(child);return child;}
function perturb(action,win,extra=[]){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'fixtures/desktop-perturb.ps1'),'-Action',action,'-Handle',String(win.handle),'-ExpectedPid',String(win.pid),...extra],{windowsHide:true,encoding:'utf8'}));}
async function activate(win){await run({action:'activate',handle:win.handle,pid:win.pid});}
async function observe(){return run({action:'observe',limit:150});}
async function editDocument(text){const snapshot=await observe();const edits=snapshot.elements.filter(e=>['edit','document'].includes(e.role)&&e.enabled!==false);assert.equal(edits.length,1,'Document editing target must be unique, not guessed');await run({action:'type_element',elementId:edits[0].id,text,replace:true});}
async function waitFor(predicate,label){for(let i=0;i<40;i++){if(await predicate())return;await wait(100);}throw new Error(label);}
async function screenshot(name){const frame=await raw({action:'frame'});assert.equal(frame.success,true,frame.output);fs.writeFileSync(path.join(out,name+'.png'),frame.imageData);}
async function main(){
 fs.mkdirSync(out,{recursive:true});
 try{await fetch(endpoint+'/health',{signal:AbortSignal.timeout(300)});throw new Error('Benchmark port already occupied');}catch(e){if(e.message==='Benchmark port already occupied')throw e;}
 const native=await require('./helpers/desktop-native-test.cjs').startNativeTestHelper(root,endpoint,out);children.push(native);
 agent=new DesktopAgent(root,false,path.join(out,'journal'),endpoint);await run({action:'list_windows'});helperStarted=true;
 const basename=`task-${seed}.txt`,first=path.join(out,'first',basename),second=path.join(out,'second',basename);
 for(const file of [first,second]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'BASELINE');}
 const padA=launch('notepad.exe',[first]),a=await waitWindow({pid:padA.pid});
 const content=`IEXA real app ${seed}\r\nSaved through Notepad UI\r\n`;
 await check('Notepad: edit and Ctrl+S, verify actual file bytes',async()=>{await activate(a);await editDocument(content);await run({action:'hotkey',keys:['CTRL','S']});await waitFor(()=>fs.readFileSync(first,'utf8').replace(/^\uFEFF/,'')===content,'Notepad file did not contain expected bytes');await screenshot('notepad-saved');return {file:path.relative(out,first),bytes:fs.statSync(first).size};});
 const padB=launch('notepad.exe',[second]),b=await waitWindow({pid:padB.pid});
 await check('Two same-title Notepad windows: ambiguous activation rejected',async()=>{const candidates=await windows({window:basename,process:'notepad'});assert.equal(candidates.length,2,'Ambiguity precondition did not hold');const result=await raw({action:'activate',window:basename,process:'notepad'});assert.equal(result.success,false,'Ambiguous title was resolved by arbitrarily choosing a window');return {candidateHandles:candidates.map(w=>w.handle)};});
 await check('Verified external foreground change: input stops before dispatch',async()=>{await activate(a);const focus=perturb('foreground',b);const state=await run({action:'session_state'});assert.equal(state.handle,a.handle,'External helper must not rebind desktop owner');assert.equal(state.foreground,false,'Focus precondition missing');const result=await raw({action:'type',text:'MUST-NOT-LEAK'});assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);await activate(b);const snapshot=await observe();assert.equal(snapshot.elements.some(e=>e.text.includes('MUST-NOT-LEAK')),false);return focus;});
 await check('Move/resize after observation: stale geometry rejected, fresh observe recovers',async()=>{await activate(a);const bounds=(await observe()).foreground.bounds;const moved=perturb('move',a,['-X',String(bounds.left+37),'-Y',String(bounds.top+29),'-Width','730','-Height','470']);const result=await raw({action:'key',key:'END'});assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);await observe();await run({action:'key',key:'END'});return moved;});
 await check('Closed target window: no fallback typing into another app',async()=>{await activate(b);padB.kill();await wait(300);const result=await raw({action:'type',text:'NO-FALLBACK'});assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);assert.equal(fs.readFileSync(second,'utf8'),'BASELINE');return {closedHandle:b.handle};});
 // Independent local web application with randomized labels/IDs and server-side oracle.
 const label=`Reference ${seed}`,next=`Review ${seed}`,confirm=`Commit ${seed}`;
 server=http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/submit'){let body='';for await(const part of req)body+=part;const data=JSON.parse(body);receipts.push(data);fs.writeFileSync(path.join(out,'browser-receipts.json'),JSON.stringify(receipts,null,2));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><title>IEXA browser task ${seed}</title><style>body{font:18px system-ui;padding:48px}input,button{font:inherit;margin:12px;padding:10px}</style></head><body><h1>Transfer a reference</h1><section id="stage"><label>${label}<input aria-label="${label}" id="field-${randomBytes(4).toString('hex')}"></label><button>${next}</button></section><script>let value;document.querySelector('button').onclick=()=>{value=document.querySelector('input').value;setTimeout(()=>{document.querySelector('section').replaceChildren();let p=document.createElement('p');p.textContent='Review '+value;let b=document.createElement('button');b.textContent='${confirm}';b.onclick=async()=>{await fetch('/submit',{method:'POST',body:JSON.stringify({reference:value,seed:'${seed}'})});document.querySelector('section').textContent='Submitted '+value};document.querySelector('section').append(p,b)},350)};</script></body></html>`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browserPath=['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(fs.existsSync);assert.ok(browserPath,'Real browser binary not found');
 const browser=launch(browserPath,[`--user-data-dir=${path.join(out,'browser-profile')}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--force-renderer-accessibility',`--app=http://127.0.0.1:${server.address().port}/`]);
 const browserWin=await waitWindow({window:`IEXA browser task ${seed}`});
 await check('Real browser + Notepad: transfer random reference, delayed review, independent receipt',async()=>{
  await activate(a);await editDocument(seed);await run({action:'hotkey',keys:['CTRL','S']});assert.equal(fs.readFileSync(first,'utf8').replace(/^\uFEFF/,''),seed);
  await activate(browserWin);await observe();await run({action:'type',target:{name:label,role:'edit'},text:seed});
  await run({action:'click',target:{name:next,role:'button'}});
  await waitFor(async()=>{const o=await observe();return o.elements.some(e=>e.text===confirm);},'Delayed review button missing');
  await run({action:'click',target:{name:confirm,role:'button'}});await waitFor(()=>receipts.length===1,'Server did not receive form submission');
  assert.deepEqual(receipts,[{reference:seed,seed}]);await screenshot('browser-submitted');return {receiptFile:'browser-receipts.json',browser:path.basename(browserPath)};
 });
 await check('Cross-owner queue + cancellation: no foreign input; next observe recovers',async()=>{
  await activate(a);const controller=new AbortController();const waiting=raw({action:'wait',text:'NEVER-'+seed,timeoutMs:20000},'benchmark',controller.signal);
  await wait(100);const other=raw({action:'type',text:'FOREIGN'},'second-agent');setTimeout(()=>controller.abort(),200);
  const [cancelled,denied]=await Promise.all([waiting,other]);assert.equal(cancelled.cancelled,true);assert.equal(denied.success,false);assert.equal(denied.metadata.desktop.dispatchedActions,0);await observe();return {cancelled:true,foreignInputDispatched:0};
 });
 console.log(JSON.stringify({out,seed,passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length},null,2));
 if(cases.some(c=>c.status==='failed'))process.exitCode=1;
}
main().catch(e=>{console.error(e);cases.push({name:'benchmark setup',status:'failed',error:e.stack});process.exitCode=1;}).finally(async()=>{fs.mkdirSync(out,{recursive:true});record();for(const child of children){try{child.kill();}catch{}}if(helperStarted)try{await fetch(endpoint+'/shutdown',{method:'POST',signal:AbortSignal.timeout(500)});}catch{}server?.closeAllConnections();server?.close();});
