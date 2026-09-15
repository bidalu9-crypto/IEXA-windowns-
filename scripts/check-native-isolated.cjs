// Real installed Windows Notepad on a separate, never-switched desktop.
// Initial semantic-operation probe; not a claim about existing user apps or model autonomy.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts','native-isolated',`${Date.now()}-${randomUUID().slice(0,8)}`);
const wait=ms=>new Promise(r=>setTimeout(r,ms));const report={scope:'real Win32 Notepad on an owned non-input desktop; deterministic semantic operations',cases:[],actions:[]};
const children=[];let agent;const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
function json(file){try{return JSON.parse(fs.readFileSync(path.join(out,file),'utf8').replace(/^\uFEFF/,''));}catch{return null;}}
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(json('isolated-error.json'))throw Error(JSON.stringify(json('isolated-error.json')));await wait(100);}throw Error(label);}
function launch(exe,args){const fd=fs.openSync(path.join(out,`child-${children.length}.log`),'a');const p=spawn(exe,args,{windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);p.on('error',e=>{report.launchError=e.stack;save();});children.push(p);return p;}
function focusEvents(){try{return fs.readFileSync(path.join(out,'focus-events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
async function main(){
 fs.mkdirSync(out,{recursive:true});save();
 const build=path.join(out,'native-build'),obj=path.join(out,'native-obj')+path.sep;
 try { fs.writeFileSync(path.join(out,'native-build.log'),execFileSync('dotnet',['build','desktop-agent/Iexa.DesktopAgent.csproj','-c','Debug','-o',build,'-p:BaseIntermediateOutputPath='+obj],{cwd:root,windowsHide:true,encoding:'utf8'})); }
 catch(e){fs.writeFileSync(path.join(out,'native-build.log'),String(e.stdout||'')+String(e.stderr||''));throw e;}
 const exe=path.join(build,'Iexa.DesktopAgent.exe');
 report.binary={path:exe,dllSha256:createHash('sha256').update(fs.readFileSync(exe.replace(/\.exe$/,'.dll'))).digest('hex')};
 const port=await new Promise(resolve=>{const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const endpoint=`http://127.0.0.1:${port}`,document=path.join(out,'owned-note.txt');fs.writeFileSync(document,'IEXA baseline');
 launch('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/foreground-audit.ps1'),'-OutputDirectory',out]);
 report.focusInitial=await until(()=>json('focus-ready.json'),'Foreground hook readiness');
 if(process.argv.includes('--model')){
  report.model=await require('./helpers/native-isolated-model.cjs').nativeIsolatedModel({root,out,exe,document});
  report.host=report.model.host;report.hostEnded=report.model.hostEnded;
  fs.writeFileSync(path.join(out,'stop-monitor'),'');report.focusFinal=await until(()=>json('focus-ended.json'),'Model foreground audit stop');report.focusEvents=focusEvents();
  assert.equal(report.model.status,'passed',JSON.stringify({error:report.model.error,businessVerified:report.model.businessVerified,metrics:report.model.metrics}));
  assert.deepEqual(report.focusEvents,[]);assert.equal(report.focusInitial.foreground,report.focusFinal.foreground);
  report.cases.push({name:'Real model autonomous Notepad launch/edit/save with independent disk receipt and zero foreground events',status:'passed'});
  report.status='passed';return;
 }

 agent=new DesktopAgent(root,false,path.join(out,'journal'),undefined,{executable:exe});
 const run=async args=>{const r=await agent.execute({backend:'native-isolated',...args,detail:'raw'},undefined,{owner:'isolated-notepad'});report.actions.push({args,success:r.success,output:r.output,desktop:r.metadata?.desktop});save();assert.equal(r.success,true,r.output);return JSON.parse(r.output).data;};
 await run({action:'list_windows',background:true});
 report.host=agent.isolatedWorkspace.diagnostics();
 const ready=report.host.ready;assert.ok(ready?.jobBound);
 report.health=await(await fetch(`http://127.0.0.1:${ready.port}/health`)).json();
 assert.equal(report.health.pid,ready.pid);assert.equal(report.health.isolatedDesktop.verified,true);
 const launched=await run({action:'launch',app:'notepad',arguments:'"'+document+'"',background:true});
 const pad={pid:launched.startedPid};
 const windows=await until(async()=>{const data=await run({action:'list_windows',background:true});return data.windows?.some(w=>w.pid===pad.pid)?data.windows:null;},'Actual Notepad window readiness');
 const matches=windows.filter(w=>w.pid===pad.pid);assert.equal(matches.length,1);report.window=matches[0];
 const observed=await run({action:'observe',handle:report.window.handle,pid:pad.pid,background:true,includeElements:true,captureFrame:true});
 for(const request of [{action:'key',key:'A',background:false},{action:'click_element',elementId:'foreign',forcePointer:true,background:true},...(report.focusInitial.foreground?[{action:'observe',handle:report.focusInitial.foreground,background:true}]:[])]){
  const response=await fetch(`http://127.0.0.1:${ready.port}/execute`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
  const data=await response.json();report.actions.push({rawNativeBoundary:request,status:response.status,result:data});save();
  assert.equal(data.ok,false);assert.match(data.error,request.action==='observe'?/another desktop|No valid target window/i:/isolated/i);
 }
 report.cases.push({name:'Native worker itself rejects physical input, pointer fallback and foreign-desktop observation',status:'passed'});

 report.observation=observed;
 assert.ok(observed.elements.some(e=>['edit','document'].includes(e.role)&&e.selector?.className==='Edit'),'Native editor exposes semantic UIA target');
 assert.deepEqual(focusEvents(),[],'Foreground changed before background input');
 const edits=observed.elements.filter(e=>['edit','document'].includes(e.role)&&e.selector?.className==='Edit');assert.equal(edits.length,1,'Use only unambiguous real editor');
 const text='IEXA native background '+randomUUID();report.expectedText=text;
 const typed=await run({action:'type_element',elementId:edits[0].id,text,background:true,verifyText:text});
 assert.equal(typed.verified,true);report.cases.push({name:'Real Notepad semantic background editing and post-action text verification',status:'passed'});
 const after=await run({action:'observe',handle:report.window.handle,background:true});
 assert.ok(after.elements.some(e=>e.text.includes(text)));report.cases.push({name:'Independent later native UIA observation contains exact edited text',status:'passed'});
 const saveItems=after.elements.filter(e=>e.role==='menucommand'&&/( > 保存\(| > Save$)/.test(e.text)&&!/另存|Save As/.test(e.text));
 assert.equal(saveItems.length,1,'Actual native Save command is unambiguous');
 await run({action:'click_element',elementId:saveItems[0].id,background:true});
 await until(()=>fs.readFileSync(document,'utf8').replace(/^\uFEFF/,'')===text,'Independent Notepad disk save receipt');
 report.savedFile={path:document,sha256:createHash('sha256').update(fs.readFileSync(document)).digest('hex')};
 report.cases.push({name:'Native File menu and Save invoke persist exact text to independently read disk file',status:'passed'});
 agent.close();report.hostEnded=await until(()=>{try{return JSON.parse(fs.readFileSync(path.join(report.host.directory,'ended.json'),'utf8'));}catch{return null;}},'Owned desktop shutdown');
 assert.equal(report.hostEnded.desktopClosed,true);assert.equal(report.hostEnded.workerExited,true);
 fs.writeFileSync(path.join(out,'stop-monitor'),'');report.focusFinal=await until(()=>json('focus-ended.json'),'Foreground audit stop');report.focusEvents=focusEvents();
 assert.deepEqual(report.focusEvents,[]);assert.equal(report.focusInitial.foreground,report.focusFinal.foreground);
 report.cases.push({name:'No foreground transition across creation, real native edit, and owned-process cleanup',status:'passed'});
 report.status='passed';
}
main().catch(e=>{report.status='failed';report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 agent?.close();fs.writeFileSync(path.join(out,'stop-host'),'');
 if(report.host?.directory)for(let i=0;i<60;i++){try{report.hostEnded=JSON.parse(fs.readFileSync(path.join(report.host.directory,'ended.json'),'utf8'));break;}catch{await wait(100);}}
 fs.writeFileSync(path.join(out,'stop-monitor'),'');await wait(200);
 report.focusEvents=focusEvents();report.hostEnded=report.hostEnded||json('isolated-ended.json');report.focusFinal=json('focus-ended.json');save();
 for(const child of children){if(child.exitCode===null&&child.signalCode===null)try{child.kill();}catch{}}
 console.log(JSON.stringify({out,status:report.status,cases:report.cases,error:report.error,focusEvents:report.focusEvents,hostEnded:report.hostEnded},null,2));
});
