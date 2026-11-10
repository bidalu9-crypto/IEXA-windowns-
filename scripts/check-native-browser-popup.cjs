'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const {createSupervisor}=require('./helpers/acceptance-supervisor.cjs');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
async function until(fn,label){const end=Date.now()+12000;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{}await pause(150);}throw Error(label);}
async function main(){const out=path.join(root,'.iexa-artifacts/cross-app-preview-20261109','popup-real-'+Date.now());fs.mkdirSync(out,{recursive:true});const report={status:'running',actions:[]},save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const supervisor=createSupervisor({output:out,maximumDurationMs:90000});let helper,server,agent,endpoint,browserIdentity;
try{await supervisor.begin();const port=await freePort();endpoint='http://127.0.0.1:'+port;
 const fd=fs.openSync(path.join(out,'helper.log'),'w'),started=Date.now();helper=spawn(path.join(root,'desktop-agent/publish/Iexa.DesktopAgent.exe'),[],{cwd:root,env:{...process.env,IEXA_DESKTOP_PORT:String(port)},windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);await supervisor.claimSpawn(helper,'Iexa.DesktopAgent.exe',started);
 await until(async()=>{const r=await fetch(endpoint+'/health');return(await r.json()).pid===helper.pid;},'Native helper ready');
 server=http.createServer((q,s)=>{if(q.url==='/download'){s.writeHead(200,{'Content-Type':'application/rtf','Content-Disposition':'attachment; filename=popup-test.rtf'});s.end('{\\rtf1 popup test}');return;}s.setHeader('Content-Type','text/html');s.end('<!doctype html><title>IEXA popup regression</title><style>body{font:24px system-ui;padding:50px}</style><h1>OWNED_POPUP_RECEIPT</h1><a href="/download">Download popup test</a>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');agent=new DesktopAgent(root,false,path.join(out,'journal'),endpoint);
 const run=async args=>{const r=await agent.execute({...args,detail:'raw'},undefined,{owner:'popup-'+out,operationId:require('node:crypto').randomUUID()});report.actions.push({args,success:r.success,output:r.output,desktop:r.metadata?.desktop});save();assert.equal(r.success,true,r.output);if(r.imageData)fs.writeFileSync(path.join(out,'frame-'+report.actions.length+'.png'),r.imageData);return JSON.parse(r.output).data;};
 const url='http://127.0.0.1:'+server.address().port+'/';
 await run({action:'launch',backend:'native',controlMode:'foreground',focusPolicy:'activate',app:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',arguments:'--user-data-dir="'+path.join(out,'chrome-profile')+'" --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --disable-gpu --force-renderer-accessibility --renderer-process-limit=2 '+url});
 const before=await until(async()=>{const s=await run({action:'observe',captureFrame:true,limit:150});return s.elements.some(e=>e.text==='OWNED_POPUP_RECEIPT')&&s;},'Test page loads');const parent=before.session.handle;
 [browserIdentity]=await supervisor.claimFixture([before.foreground.pid],path.join(out,'chrome-profile'));
 // This deterministic fixture's link was located in the actual captured frame.
 await run({action:'click',relativeX:175,relativeY:300});
 await pause(1000);await run({action:'observe'});
 await run({action:'click',relativeX:1063,relativeY:63});
 const popup=await run({action:'observe',captureFrame:true});assert.notEqual(popup.session.handle,parent,'Native menu must become the bound target');
 const explicit=await run({action:'observe',handle:popup.session.handle,includeElements:true});assert.equal(explicit.session.handle,popup.session.handle);
 assert.ok(explicit.elements.length>1,'Actual popup controls observed');
 await run({action:'key',key:'ESC'});const returned=await run({action:'observe'});assert.equal(returned.session.handle,parent,'Popup dismissal returns to exact original parent');
 report.parent=parent;report.popup=popup.session.handle;report.menuItems=explicit.elements.filter(e=>/menuitem/i.test(e.role)).map(e=>e.text);report.status='passed';
 await run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true}).catch(e=>{report.closeObservation=e.message;});
}catch(e){report.status='failed';report.error=e.stack;}finally{agent?.close();
 if(browserIdentity){const {processTable}=require('./helpers/acceptance-supervisor.cjs'),{descendants}=require('./helpers/owned-processes.cjs');const alive=await supervisor.living([browserIdentity]);if(alive.length){const rows=descendants(await processTable(),browserIdentity);await supervisor.claimFixture(rows.map(p=>p.ProcessId),'chrome-profile');await supervisor.terminate(rows);report.fixtureBrowserClosedByExactIdentity=true;}}
 if(helper?.exitCode===null){try{await fetch(endpoint+'/shutdown',{method:'POST'});await until(()=>helper.exitCode!==null,'Helper exit');}catch(e){report.cleanupError=e.message;}}
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}try{report.resources=await supervisor.finish();}catch(e){report.resourceError=e.message;report.status='failed';}save();console.log(JSON.stringify({status:report.status,error:report.error,resourceError:report.resourceError,output:out}));process.exitCode=report.status==='passed'?0:1;}}
main().catch(e=>{console.error(e);process.exitCode=1;});
