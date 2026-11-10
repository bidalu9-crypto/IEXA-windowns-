'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers/desktop-component-harness.cjs');
async function main(){
 const source=process.argv.includes('--source'), label=source?'source':'packaged';
 const output=path.resolve('.iexa-artifacts/cross-app-preview-20261109',`preview-${label}-${Date.now()}`);
 const hidden=!process.argv.includes('--visible');
 const h=await createHarness({source,hidden,output,timeout:180000,packageRoot:process.env.IEXA_PREVIEW_PACKAGE,
  prepareProject(project){
   fs.unlinkSync(path.join(project,'index.html'));
   fs.writeFileSync(path.join(project,'pelican-ride.html'),'<!doctype html>\n<meta charset="utf-8">\n<link rel="stylesheet" href="theme.css">\n<h1 id="receipt">PELICAN_INITIAL</h1>\n<script>document.body.dataset.script="executed"</script>\n');
   fs.writeFileSync(path.join(project,'theme.css'),'body{background:rgb(22,32,48);color:white;font:24px system-ui;padding:32px}h1{color:rgb(40,200,120)}');
   fs.writeFileSync(path.join(project,'second 中文.htm'),'<meta charset="utf-8"><h1 id="receipt">SECOND_中文</h1>');
   fs.writeFileSync(path.join(project,'binary.dat'),Buffer.from([0,1,2,3]));
  }});
 const read=h.read,click=h.clickSelector,key=h.keySelector, editor='#ideMonaco .monaco-editor';
 const snap=()=>read('IexaIDE.snapshot()');
 async function capture(name){
  // A hidden WebContentsView has no Chromium surface on this Windows build.
  // Record the missing visual oracle explicitly, without failing DOM/input checks.
  if(process.argv.includes('--defer-visual')){(h.report.pendingVisualChecks ||= []).push(name);h.save();return;}
  return h.screenshot(name);
 }
 async function file(name){await click('#ideViewFiles'); await click('#ideTree [data-path='+JSON.stringify(name)+']');await h.until(async()=>(await snap()).activeFile===name,'Selected '+name);}
 async function menu(id){await click('#ideRunMenu');await click('#'+id);}
 try{
  await h.start();assert.equal(h.report.window.visible,!hidden,'Expected test window visibility');
  h.report.scope=(hidden?'Hidden':'Visible')+' production IEXA renderer and native WebContentsView; UI input through production DesktopAgent; DOM/disk/screenshot oracles; no model request';
  await click('[data-workbench-view="ide"]');await h.until(()=>read('IexaIDE.snapshot().workspaceId'),'IDE ready');
  await file('pelican-ride.html');
  await h.check('real Monaco cursor, total lines, edits and undo',async()=>{
   assert.equal(await read('document.getElementById("ideCursor").textContent'),'行 1/6，列 1');
   const original=await read('IexaIDE.context().content');
   await click(editor);await key(editor,['CTRL','END']);
   await h.until(()=>read('document.getElementById("ideCursor").textContent==="行 6/6，列 1"'),'Cursor reaches final empty line');
   await h.selectorAction('insert_text',editor,{text:'<!-- line seven -->\n',replace:false});
   await h.until(()=>read('document.getElementById("ideCursor").textContent==="行 7/7，列 1"'),'Unsaved line count');
   await key(editor,['CTRL','Z']);
   await h.until(async()=>await read('IexaIDE.context().content')===original,'One undo restores the whole inserted block');
   await key(editor,['CTRL','Y']);await h.until(()=>read('document.getElementById("ideCursor").textContent.includes("/7")'),'Redo line count');
   await key(editor,['CTRL','Z']);
   await capture('cursor-total');return{status:await read('document.getElementById("ideCursor").textContent')};
  });
  await h.check('preview tab renders selected non-index HTML with actual CSS and JavaScript',async()=>{
   assert.equal((await snap()).server.status,'stopped');await click('#ideViewPreview');
   const state=await h.until(async()=>{const s=await snap();return s.server.status==='running'&&s.previewAttached&&s;},'Attached automatic HTML preview');
   assert.match(state.server.url,/pelican-ride.html$/);
   const result=await h.withTarget(state.server.url,async()=>{await h.until(()=>read('document.querySelector("#receipt")?.textContent==="PELICAN_INITIAL"'),'Rendered HTML');await capture('pelican-rendered');return read('({text:document.querySelector("#receipt").textContent,color:getComputedStyle(document.querySelector("h1")).color,script:document.body.dataset.script})');});
   assert.equal(result.color,'rgb(40, 200, 120)');assert.equal(result.script,'executed');return result;
  });
  await h.check('second HTML reuses server and navigates to encoded filename',async()=>{
   const first=(await snap()).server.url;await file('second 中文.htm');await click('#ideViewPreview');
   const state=await h.until(async()=>{const s=await snap();return s.server.url.includes('second%20')&&s.previewAttached&&s;},'Second HTML navigation');
   assert.equal(new URL(state.server.url).origin,new URL(first).origin);
   const text=await h.withTarget(state.server.url,()=>read('document.querySelector("#receipt")?.textContent'));
   assert.equal(text,'SECOND_中文');return{url:state.server.url,text};
  });
  await h.check('binary read error clears on healthy HTML and code tab hides preview',async()=>{
   await click('#ideViewFiles');await click('#ideTree [data-path="binary.dat"]');
   await h.until(()=>read('IexaIDE.snapshot().error.includes("二进制")'),'Actual binary error');
   await file('pelican-ride.html');await click('#ideViewCode');
   await h.until(()=>read('IexaIDE.snapshot().previewAttached===""'),'Native preview hidden');
   assert.equal((await snap()).error,'');return{error:(await snap()).error};
  });
  await h.check('desktop editor save updates actual rendered HTML',async()=>{
   await click(editor);await key(editor,['CTRL','A']);
   const html='<!doctype html>\n<meta charset="utf-8">\n<h1 id="receipt">PELICAN_SAVED_中文</h1>\n';
   await h.selectorAction('insert_text',editor,{text:html,replace:false});await key(editor,['CTRL','S']);
   await h.until(()=>fs.readFileSync(path.join(h.report.fixture.project,'pelican-ride.html'),'utf8').replace(/\r\n/g,'\n')===html,'Saved exact HTML');
   await click('#ideViewPreview');const url=(await snap()).server.url;
   await h.withTarget(url,async()=>{await h.until(()=>read('document.querySelector("#receipt")?.textContent==="PELICAN_SAVED_中文"'),'Preview contains saved content');await capture('saved-rendered');});return{url,html};
  });
  await h.check('stop releases HTTP listener and preview tab restarts selected HTML',async()=>{
   const before=(await snap()).server.url;await menu('ideStop');await h.until(async()=>(await snap()).server.status==='stopped','Preview stopped');
   await assert.rejects(fetch(before,{signal:AbortSignal.timeout(2000)}));
   await click('#ideViewCode');await click('#ideViewPreview');await h.until(async()=>(await snap()).server.status==='running','Restart via preview tab');
   await menu('ideRestart');await h.until(async()=>(await snap()).server.status==='running','Manual restart selected HTML');
   assert.match((await snap()).server.url,/pelican-ride.html$/);await menu('ideStop');await click('#ideViewCode');return{server:(await snap()).server.status};
  });
 }catch(error){h.report.error=error.stack;h.save();}
 finally{const report=await h.finish();console.log(JSON.stringify({status:report.status,checks:report.checks.map(c=>({name:c.name,passed:c.passed,error:c.error})),error:report.error,output}));process.exitCode=report.status==='passed'?0:1;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
