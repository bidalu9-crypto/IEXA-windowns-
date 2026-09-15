/* Opt-in real Windows UIA smoke; isolated helper port, disposable fixture process only. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { DesktopAgent } = require('../dist/main/tools/DesktopAgent');
const root = path.resolve(__dirname, '..');
const out = process.env.IEXA_DESKTOP_EVIDENCE || path.join(root, '.iexa-artifacts', 'desktop-control-validation');
const endpoint = 'http://127.0.0.1:17983';
const wait = ms => new Promise(r => setTimeout(r, ms));
let fixture, takeoverFixture, nativeHelper; const evidence = [];
async function main() {
 fs.mkdirSync(out, {recursive:true});
 // Never reuse or shut down a helper owned by another run.
 try { await fetch(endpoint+'/health',{signal:AbortSignal.timeout(300)}); throw new Error('Test port already occupied.'); } catch (e) { if(e.message==='Test port already occupied.') throw e; }
 nativeHelper = await require('./helpers/desktop-native-test.cjs').startNativeTestHelper(root,endpoint,out);
 fixture = spawn('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/desktop-control.ps1')],{windowsHide:true,stdio:'ignore'});
 await wait(1800);
 const agent = new DesktopAgent(root, false, path.join(out,'journal'), endpoint);
 async function run(args, owner='fixture', signal) {
   const r=await agent.execute({...args,detail:'raw'}, signal,{owner});
   evidence.push({action:args.action,owner,success:r.success,output:r.output,desktop:r.metadata?.desktop});
   fs.writeFileSync(path.join(out,'native-checks.json'),JSON.stringify(evidence,null,2)); return r;
 }
 const listed=await run({action:'list_windows',pid:fixture.pid}); assert.equal(listed.success,true,listed.output);
 const activated=await run({action:'activate',pid:fixture.pid,window:'IEXA Desktop Control Fixture'}); assert.equal(activated.success,true,activated.output);
 const observed=await run({action:'observe',includeElements:true,limit:100}); assert.equal(observed.success,true,observed.output);
 const elements=JSON.parse(observed.output).data.elements;
 assert.ok(elements.some(e=>e.selector?.automationId==='FixtureInput'),JSON.stringify(elements));
 const typed=await run({action:'type',target:{automationId:'FixtureInput'},text:'IEXA-CONTROL-OK',verifyText:'IEXA-CONTROL-OK',timeoutMs:15000}); assert.equal(typed.success,true,typed.output); assert.equal(typed.metadata.desktop.verified,true);
 const clicked=await run({action:'click',target:{automationId:'FixtureApply'},verifyText:'Applied IEXA-CONTROL-OK'}); assert.equal(clicked.success,true,clicked.output); assert.equal(clicked.metadata.desktop.verified,true);
 const image=await run({action:'frame'}); assert.equal(image.success,true,image.output); fs.writeFileSync(path.join(out,'native-fixture.png'),image.imageData);
 const denied=await run({action:'type',text:'FOREIGN-OWNER'},'other-agent'); assert.equal(denied.success,false);
 // A newly opened disposable window takes foreground without rebinding the helper.
 takeoverFixture=spawn('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/desktop-control.ps1'),'-Title','IEXA Desktop Takeover Fixture'],{windowsHide:true,stdio:'ignore'});
 await wait(1500);
 const takeoverWindows=JSON.parse((await run({action:'list_windows',pid:takeoverFixture.pid,window:'IEXA Desktop Takeover Fixture',includeHidden:true})).output).data.windows;
 assert.equal(takeoverWindows.length,1,'Takeover fixture window must exist');
 const takeoverWindow=takeoverWindows[0];
 const focus=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'fixtures/desktop-perturb.ps1'),'-Action','foreground','-Handle',String(takeoverWindow.handle),'-ExpectedPid',String(takeoverWindow.pid)],{windowsHide:true,encoding:'utf8'}));
 assert.equal(focus.after,takeoverWindow.handle,'Actual foreground switch is mandatory');
 const lostFocus=await run({action:'type',text:'MUST-NOT-BE-TYPED'});assert.equal(lostFocus.success,false,lostFocus.output);assert.equal(lostFocus.metadata.desktop.userTakeover,true);
 takeoverFixture.kill();takeoverFixture=undefined;
 assert.equal((await run({action:'activate',pid:fixture.pid,window:'IEXA Desktop Control Fixture'})).success,true);
 // Native pause simulates the user's stop button; managed input must report takeover.
 await fetch(endpoint+'/pause',{method:'POST'});
 const paused=await run({action:'click',target:{automationId:'FixtureApply'}}); assert.equal(paused.success,false); assert.equal(paused.metadata.desktop.userTakeover,true);
 await fetch(endpoint+'/resume',{method:'POST'});
 assert.equal((await run({action:'observe'})).success,true);
 const controller=new AbortController(); const cancelled=run({action:'wait',text:'NEVER-APPEARS-IN-FIXTURE',timeoutMs:20000},'fixture',controller.signal); setTimeout(()=>controller.abort(),250);
 const cancelledResult=await cancelled; assert.equal(cancelledResult.success,false); assert.equal(cancelledResult.cancelled,true);
 const recovered=await run({action:'observe'}); assert.equal(recovered.success,true,recovered.output);
 console.log('PASS: real Windows semantic typing/click + text verification + owner isolation + pause + cancellation + fresh recovery.');
}
main().catch(e=>{evidence.push({error:e.stack}); console.error(e);process.exitCode=1;}).finally(async()=>{
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'native-checks.json'),JSON.stringify(evidence,null,2));
 if(nativeHelper && nativeHelper.exitCode===null) nativeHelper.kill();
 if(takeoverFixture) takeoverFixture.kill();
 if(fixture) fixture.kill();
});
