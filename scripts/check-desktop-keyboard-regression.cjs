'use strict';
// Focused real-GUI regression, not a model benchmark. Parent runs serially after
// publishing the candidate package. Fixture creation/read-only oracles may use
// files; all editing, saving, selection and calculation use production DesktopAgent.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {createSupervisor}=require('./helpers/acceptance-supervisor.cjs');
const {readRtf}=require('./fixtures/desktop-comparison-tasks.cjs');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function until(read,label,timeout=10000){const end=Date.now()+timeout;do{if(await read())return;await sleep(150);}while(Date.now()<end);throw Error(label);}
async function worker(appRoot,journal,endpoint){
 const {DesktopAgent}=require(path.join(appRoot,'dist/main/tools/DesktopAgent'));
 const agent=new DesktopAgent(appRoot,false,journal,endpoint);let active;
 process.on('message',async m=>{
  if(m.quit){active?.abort();agent.close();setTimeout(()=>process.exit(0),100).unref();return;}
  if(m.cancel){active?.abort();return;}
  if(active){process.send({id:m.id,error:'Concurrent GUI action rejected'});return;}
  active=new AbortController();
  try{
   const r=await agent.execute(m.args,active.signal,{owner:'keyboard-regression',operationId:randomUUID()});
   const image=r.imageData;process.send({id:m.id,result:{success:r.success,output:r.output,metadata:r.metadata},imageBase64:typeof image==='string'?image:image?Buffer.from(image).toString('base64'):undefined});
  }catch(e){process.send({id:m.id,error:e.stack});}finally{active=undefined;}
 });
 process.send({ready:true});
}
function rpc(child){
 let id=0,resolveReady,rejectReady;const pending=new Map();
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
 const rejectAll=e=>{rejectReady(e);for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
 child.once('error',rejectAll);child.once('exit',code=>rejectAll(Error('Controller exited '+code)));
 child.on('message',m=>{if(m.ready)return resolveReady();const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m);});
 return{ready,request(args){return new Promise((resolve,reject)=>{const current=++id,timer=setTimeout(()=>{pending.delete(current);child.connected&&child.send({cancel:true});reject(Error('Desktop action timed out'));},25000);pending.set(current,{resolve,reject,timer});child.send({id:current,args},e=>{if(e){clearTimeout(timer);pending.delete(current);reject(e);}});});},dispose(){rejectAll(Error('RPC disposed'));}};
}
function validateRtf(file,title,marker){
 const raw=fs.readFileSync(file,'latin1'),chars=readRtf(raw),text=chars.map(c=>c.ch).join(''),lines=text.trim().split(/\n/).map(s=>s.trim()),start=text.indexOf(title),heading=chars.slice(start,start+title.length);
 assert.match(raw,/^\{\\rtf/);assert.deepEqual(lines,[title,'STATUS '+marker],'saved document has exactly the required two lines');
 assert.equal(heading.length,title.length);assert.ok(heading.filter(c=>c.ch.trim()).every(c=>c.bold),'every title character is bold');
 return {text,titleEntirelyBold:true,outputSHA256:hash(file)};
}
async function main(kind){
 assert.ok(['wordpad','calculator'].includes(kind),'Usage: node scripts/check-desktop-keyboard-regression.cjs wordpad|calculator');
 const reuseHandle=kind==='calculator'&&process.env.IEXA_REUSE_CALCULATOR_HANDLE?Number(process.env.IEXA_REUSE_CALCULATOR_HANDLE):null;
 if(reuseHandle!==null)assert.ok(Number.isSafeInteger(reuseHandle)&&reuseHandle>0,'IEXA_REUSE_CALCULATOR_HANDLE must be an exact positive HWND');
 const packageRoot=path.resolve(process.env.IEXA_TEST_PACKAGE||path.join(root,'release/IEXA-preview-20261109')),appRoot=path.join(packageRoot,'resources/app');
 const out=path.join(root,'.iexa-artifacts/desktop-comparison-20261110','regression-'+kind+'-'+Date.now()),directory=path.join(out,'task-files');fs.mkdirSync(directory,{recursive:true});
 const token=randomUUID().slice(0,8),title='REFERENCE REF_'+token,marker='DONE_'+token,input=path.join(directory,'source-'+token+'.rtf'),output=path.join(directory,'result-'+token+'.rtf');
 if(kind==='wordpad')fs.writeFileSync(input,'{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 '+title+'\\par STATUS PENDING\\par}');
 const report={status:'running',kind,startedAt:new Date().toISOString(),scope:'Fixed GUI regression through packaged production controller; no model, no business output written by scripts',packageRoot,actions:[],checks:[],fixture:kind==='wordpad'?{input,output,title,marker,originalSHA256:hash(input)}:null};
 if(kind==='calculator')Object.assign(report,{existingWindowAuthorized:reuseHandle!==null,windowMode:reuseHandle!==null?'authorized-existing-preserved':'fresh-window-isolated',authorizedExistingHandle:reuseHandle,closeRegressionApplicable:reuseHandle===null});
 const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 const names=new Set(kind==='wordpad'?['wordpad.exe']:['calculatorapp.exe','calculator.exe','calc.exe']);
 const supervisor=createSupervisor({output:out,maximumDurationMs:180000,allowFixtureCleanup:true,observeProcess:r=>names.has(String(r.Name).toLowerCase())});
 let child,client,run,activeHandle,baselineHandles=new Set();const ownedHandles=new Set();
 try{
  await supervisor.begin();
  report.packageManifestSHA256=hash(path.join(packageRoot,'build-manifest.json'));
  report.controllerSHA256=hash(path.join(appRoot,'dist/main/tools/DesktopAgent.js'));save();
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const endpoint='http://127.0.0.1:'+port,fd=fs.openSync(path.join(out,'controller.log'),'w'),started=Date.now();
  child=spawn(path.join(packageRoot,'IEXA.exe'),['--max-old-space-size=384',__filename,'__worker',appRoot,path.join(out,'journal'),endpoint],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);client=rpc(child);
  await supervisor.claimSpawn(child,__filename,started);await Promise.race([client.ready,supervisor.failure,new Promise((_,reject)=>setTimeout(()=>reject(Error('Controller readiness timed out')),15000))]);
  run=async(args,allowFailure=false,cleanup=false)=>{
   assert.ok(report.actions.length<70,'bounded GUI call count');
   const payload={backend:'native',controlMode:'foreground',focusPolicy:'activate',...args,detail:'raw'},startedAt=Date.now();
   const work=client.request(payload),response=await(cleanup?work:Promise.race([work,supervisor.failure])),r=response.result;
   const entry={args:payload,startedAt,completedAt:Date.now(),success:r.success,output:r.output};
   if(response.imageBase64){entry.image='frame-'+(report.actions.length+1)+'.png';fs.writeFileSync(path.join(out,entry.image),Buffer.from(response.imageBase64,'base64'));}
   report.actions.push(entry);save();if(!r.success){if(allowFailure)return null;throw Error(r.output);}return JSON.parse(r.output).data;
  };
  const baseline=await run({action:'list_windows'});assert.ok(Array.isArray(baseline.windows));baselineHandles=new Set(baseline.windows.map(w=>w.handle));
  const existingTargets=baseline.windows.filter(w=>kind==='wordpad'?/^wordpad$/i.test(w.process||''):/计算器|Calculator/i.test(w.title||''));
  if(reuseHandle!==null){
   const authorizedTargets=existingTargets.filter(w=>w.handle===reuseHandle);
   assert.equal(authorizedTargets.length,1,'Baseline contains exactly the authorized Calculator HWND');
   report.otherObservedCalculatorWindows=existingTargets.filter(w=>w.handle!==reuseHandle);
   const exact=await run({action:'list_windows',handle:reuseHandle,includeHidden:true,limit:1});
   assert.ok(Array.isArray(exact.windows));assert.equal(exact.windows.length,1);assert.equal(exact.windows[0].handle,reuseHandle);
   assert.match(exact.windows[0].title||'',/^(计算器|Calculator)$/i);assert.match(exact.windows[0].process||'',/^(ApplicationFrameHost|CalculatorApp|Calculator)(\.exe)?$/i);
   report.authorizedExistingBaseline=exact.windows[0];
  }else assert.equal(existingTargets.length,0,'Existing target windows prevent isolated regression; leave them untouched');
  report.baselineHandles=[...baselineHandles];
  const launch=async file=>{
   const data=await run({action:'launch',app:kind==='wordpad'?'C:\\Program Files\\Windows NT\\Accessories\\wordpad.exe':'C:\\Windows\\System32\\calc.exe',...(file?{arguments:'"'+file+'"'}:{})});
   assert.ok(data.window?.handle);assert.ok(!baselineHandles.has(data.window.handle),'Only a new test window can be claimed');
   if(file)assert.ok(String(data.window.title).includes(path.basename(file)),'Exact fixture document title');
   activeHandle=data.window.handle;ownedHandles.add(activeHandle);return run({action:'observe',handle:activeHandle,limit:80,captureFrame:true});
  };
  const openSaveAs=async()=>{
   const filenameIn=state=>state?.elements?.find(e=>e.selector?.automationId==='FileNameControlHost')
    ||state?.elements?.find(e=>['edit','combobox'].includes(e.role)&&(e.selector?.automationId==='1148'||/文件名|File name/i.test(e.selector?.name||e.text||'')));
   let current,documentPid;const observedOwners=new Set([activeHandle]);
   const observe=async()=>{
    current=await run({action:'observe',limit:120,captureFrame:true});
    documentPid??=current.windows?.find(w=>w.handle===activeHandle)?.pid;
    // Ribbon menus are separate owned Net UI popup HWNDs. The document UIA
    // tree cannot describe them. Explicitly bind the currently observed popup
    // before interpreting its controls, instead of repeating the menu action.
    for(let depth=0;depth<3;depth++){
     const actual=current.session?.actualForeground;
     const popup=(current.relatedWindows||[]).find(w=>w.handle===actual?.handle&&w.handle!==current.session?.handle
      &&observedOwners.has(Number(w.ownerHandle))&&/^wordpad(?:\.exe)?$/i.test(w.process||'')&&Number(w.pid)===Number(actual.pid)&&Number(w.pid)===Number(documentPid));
     if(!popup)break;
     observedOwners.add(popup.handle);report.saveAsPopupTransitions??=[];
     report.saveAsPopupTransitions.push({from:current.session.handle,to:popup.handle,ownerHandle:popup.ownerHandle,pid:popup.pid,className:popup.className});save();
     current=await run({action:'observe',handle:popup.handle,limit:160,captureFrame:true,includeOcr:true});
     assert.equal(current.session?.handle,popup.handle,'Explicit observation binds the current owned popup');
    }
    return filenameIn(current);
   };
   const clickObserved=async element=>{
    if(String(element.source||'').toLowerCase().includes('ocr')){
     const b=element.bounds,window=current.session?.bounds;
     assert.ok(b&&window&&current.session?.observationToken,'OCR menu target has current geometry and observation token');
     const x=Number(b.centerX??(b.left+b.width/2))-window.left,y=Number(b.centerY??(b.top+b.height/2))-window.top;
     assert.ok(x>=0&&y>=0&&x<window.width&&y<window.height,'OCR target is within explicitly observed popup');
     await run({action:'click',relativeX:Math.round(x),relativeY:Math.round(y),observationToken:current.session.observationToken},true);
    }else await run({action:'click_element',elementId:element.id},true);
   };
   const inspect=async()=>{
    for(let n=0;n<3;n++){const filename=await observe();if(filename)return filename;if(n<2)await sleep(200);}
    return null;
   };
   report.saveAsAttempts=[];
   // A successful key dispatch is not evidence that a dialog opened. Inspect
   // after each distinct route and only type after observing a filename field.
   for(const [route,args] of [['F12',{action:'key',key:'F12'}],['Ctrl+Shift+S',{action:'hotkey',keys:['CTRL','SHIFT','S']}]]){
    await run(args,true);const filename=await inspect();report.saveAsAttempts.push({route,filenameObserved:!!filename});save();if(filename)return filename;
    assert.ok(current.elements?.some(e=>e.role==='document'&&String(e.text).includes(title)),
     'Save As shortcut did not open a known dialog or retain the exact test document; stop rather than send another shortcut into an unknown window');
   }
   const fileTab=current.elements?.find(e=>e.role==='button'&&/文件.*选项卡|File.*tab|^文件$|^File$/i.test(e.selector?.name||e.text||''));
   assert.ok(fileTab,'Current fixture window has an observed File tab');
   await clickObserved(fileTab);await observe();
   let saveAs=current.elements?.find(e=>/^(另存为|Save as)/i.test((e.selector?.name||e.text||'').trim()));
   if(!saveAs){
    current=await run({action:'observe',handle:current.session.handle,limit:160,captureFrame:true,includeOcr:true});
    saveAs=current.elements?.find(e=>/另存为|Save\s*as/i.test(e.text||e.selector?.name||''));
   }
   assert.ok(saveAs,'File menu exposes an observed Save As command');
   await clickObserved(saveAs);let filename=await inspect();
   if(!filename){
    const richText=current.elements?.find(e=>/RTF|Rich Text|RTF 文档|丰富文本|富文本/i.test(e.selector?.name||e.text||'')&&(['button','menuitem','listitem'].includes(e.role)||String(e.source||'').toLowerCase().includes('ocr')));
    assert.ok(richText,'Save As submenu exposes an observed RTF format command');
    await clickObserved(richText);filename=await inspect();
   }
   report.saveAsAttempts.push({route:'Observed File menu -> Save As -> RTF if needed',filenameObserved:!!filename});save();
   assert.ok(filename,'Save As filename field actually observed');return filename;
  };
  const close=async()=>{
   const closing=activeHandle;
   await run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true});
   const state=await run({action:'list_windows',handle:closing,includeHidden:true,limit:1});
   assert.ok(Array.isArray(state.windows));assert.ok(!state.windows.some(w=>w.handle===closing),'Exact HWND disappeared, including last application window');activeHandle=undefined;
   report.checks.push({name:'Last-window close returns success and exact HWND is absent',passed:true,handle:closing});save();
  };
  if(kind==='wordpad'){
   const observed=await launch(input),document=observed.elements?.find(e=>e.role==='document'&&String(e.text).includes(title));assert.ok(document,'Fixture document editor observed');
   // One click establishes editor focus only. No mouse selection, alternate
   // selection shortcut or fallback may replace the tested Shift sequences.
   await run({action:'click_element',elementId:document.id,count:1});
   await run({action:'hotkey',keys:['CTRL','HOME']});
   await run({action:'hotkey',keys:['SHIFT','END'],captureFrame:true});
   await run({action:'hotkey',keys:['CTRL','B']});
   await run({action:'key',key:'RIGHT'});await run({action:'key',key:'DOWN'});await run({action:'key',key:'HOME'});
   const repeated=await run({action:'hotkey',keys:['SHIFT','RIGHT'],count:14,captureFrame:true});
   assert.equal(repeated.count,14,'Native hotkey receipt records all 14 repetitions');
   await run({action:'type',text:'STATUS '+marker,replace:false,captureFrame:true});
   const filename=await openSaveAs();
   await run({action:'type_element',elementId:filename.id,text:output,replace:true});
   await run({action:'observe',limit:100,captureFrame:true});
   await run({action:'click_element',target:{automationId:'1',role:'Button'},expectWindowClosed:true});
   await until(()=>fs.existsSync(output),'GUI saved output RTF');
   report.artifact=validateRtf(output,title,marker);assert.equal(hash(input),report.fixture.originalSHA256,'Source file unchanged');
   await run({action:'observe',handle:activeHandle,limit:80,captureFrame:true});await close();
   const reopened=await launch(output);assert.ok(reopened.elements?.some(e=>e.role==='document'&&String(e.text).includes(title)&&String(e.text).includes('STATUS '+marker)),'Reopened editor contains both expected lines');
   report.reopenFrame=report.actions.at(-1).image;report.artifactAfterReopen=validateRtf(output,title,marker);await close();
   report.checks.push({name:'Extended CtrlHome/ShiftEnd select whole title; ShiftRight count14 replaces exactly STATUS PENDING; GUI RTF preserves bold after reopen',passed:true});
  }else{
   if(reuseHandle!==null){
    activeHandle=reuseHandle;
    await run({action:'activate',handle:reuseHandle});
    let ready=false;
    for(let attempt=0;attempt<6;attempt++){
     const observed=await run({action:'observe',handle:reuseHandle,limit:80,captureFrame:true});
     ready=['clearButton','num8Button','num9Button','CalculatorResults'].every(id=>observed.elements?.some(e=>e.selector?.automationId===id));
     report.calculatorActivation={handle:reuseHandle,observations:attempt+1,controlsReady:ready};save();
     if(ready)break;
     if(attempt<5)await sleep(250);
    }
    assert.ok(ready,'Explicitly activated authorized Calculator exposes current digit/result controls before input');
   }
   else await launch();
   await run({action:'click_element',target:{automationId:'clearButton'}});
   await run({action:'observe',limit:80,captureFrame:true});
   const eight=await run({action:'click_element',target:{automationId:'num8Button'}});
   // Deliberately no observe between clicks. Nine must resolve from automatic
   // post-observation retaining the explicit observation budget of 80.
   const nine=await run({action:'click_element',target:{automationId:'num9Button'}});
   const result=await run({action:'observe',limit:80,captureFrame:true});
   const display=result.elements?.find(e=>e.selector?.automationId==='CalculatorResults');assert.ok(display,'Calculator result control observed');
   assert.match(String(display.text).replace(/[\u200e\u200f]/g,''),/^(?:(?:显示为|Display is)\s*)?89$/i,'Actual calculator display is exactly 89');
   report.automaticObservations={afterEight:eight.postObservation,afterNine:nine.postObservation};report.display=display;report.resultFrame=report.actions.at(-1).image;
   report.checks.push({name:'observe80 -> click8 -> click9 succeeds without intervening observe and actual display is 89',passed:true});
   if(reuseHandle!==null){
    await run({action:'click_element',target:{automationId:'clearButton'}});
    const cleared=await run({action:'observe',handle:reuseHandle,limit:80,captureFrame:true});
    const displayAfter=cleared.elements?.find(e=>e.selector?.automationId==='CalculatorResults');
    assert.match(String(displayAfter?.text).replace(/[\u200e\u200f]/g,''),/^(?:(?:显示为|Display is)\s*)?0$/i,'Clear only current test input');
    const retained=await run({action:'list_windows',handle:reuseHandle,includeHidden:true,limit:1});
    assert.ok(Array.isArray(retained.windows)&&retained.windows.length===1&&retained.windows[0].handle===reuseHandle&&retained.windows[0].pid===report.authorizedExistingBaseline.pid,'Authorized user window remains open with same HWND and PID');
    report.existingWindowPreserved=true;report.testInputCleared=true;activeHandle=undefined;
   }else await close();
  }
  report.status='passed';
 }catch(error){report.status='failed';report.error=error.stack;}
 finally{
  if(reuseHandle!==null&&run&&report.authorizedExistingBaseline)try{
   // Baseline HWND is never added to ownedHandles or claimed as an owned PID.
   // On failure preserve it as-is; do not close it or dispatch blind cleanup.
   const retained=await run({action:'list_windows',handle:reuseHandle,includeHidden:true,limit:1},false,true);
   report.existingWindowPreserved=Array.isArray(retained.windows)&&retained.windows.length===1&&retained.windows[0].handle===reuseHandle&&retained.windows[0].pid===report.authorizedExistingBaseline.pid;
   if(!report.existingWindowPreserved){report.status='failed';report.existingWindowError='Authorized baseline window no longer present with exact HWND and PID';}
  }catch(e){report.status='failed';report.existingWindowError=e.message;}
  // Failure recovery closes only an HWND claimed from this test. A dirty RTF
  // may require supervisor cleanup; that remains a failure, never a pass.
  if(run&&activeHandle&&ownedHandles.has(activeHandle))try{
   const state=await run({action:'list_windows',handle:activeHandle,includeHidden:true,limit:1},false,true);
   if(state.windows?.some(w=>w.handle===activeHandle)){
    await run({action:'observe',handle:activeHandle},false,true);
    await run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true},true,true);
    const after=await run({action:'list_windows',handle:activeHandle,includeHidden:true,limit:1},false,true);report.failureCleanupWindowAbsent=Array.isArray(after.windows)&&!after.windows.some(w=>w.handle===activeHandle);
   }
  }catch(e){report.closeError=e.stack;report.status='failed';}
  if(kind==='wordpad'){report.fixture.finalSHA256=hash(input);if(report.fixture.finalSHA256!==report.fixture.originalSHA256){report.status='failed';report.sourceError='Source changed';}}
  if(child?.connected)child.send({quit:true});
  if(child)try{await until(()=>child.exitCode!==null,'Controller exit',5000);}catch(e){report.controllerCloseError=e.message;report.status='failed';}
  client?.dispose();
  try{report.resources=await supervisor.finish();}catch(e){report.resourceError=e.message;report.status='failed';}
  report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,out,error:report.error,resourceError:report.resourceError}));process.exitCode=report.status==='passed'?0:1;
 }
}
if(process.argv[2]==='__worker')worker(...process.argv.slice(3)).catch(e=>{console.error(e);process.exitCode=1;});
else main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
