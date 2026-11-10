'use strict';
// Run under scripts/run-bounded.cjs. No applications are opened or controlled.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts/cross-app-preview-20261109','helper-startup-'+Date.now());
fs.mkdirSync(out,{recursive:true});
const app=path.join(root,'release/IEXA-preview-20261109/resources/app');
const {DesktopAgent}=require(path.join(app,'dist/main/tools/DesktopAgent'));
const {closeDesktopHelpers}=require(path.join(app,'dist/main/tools/desktop/DesktopHelperLifetime'));
const report={status:'running',scope:'Packaged module loaded from unrelated cwd/workspace; normal helper cold start, idle restart and isolated helper startup; no app input',cases:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 let agent;
 try{
  try{await fetch('http://127.0.0.1:17891/health',{signal:AbortSignal.timeout(300)});throw Error('Helper port occupied before test');}catch(e){if(e.message==='Helper port occupied before test')throw e;}
  process.chdir(out);agent=new DesktopAgent(path.join(out,'unrelated-workspace'));
  const run=async backend=>{const r=await agent.execute({action:'list_windows',backend,detail:'raw'},undefined,{owner:backend});assert.equal(r.success,true,r.output);};
  await run('native');const first=await(await fetch('http://127.0.0.1:17891/health')).json();
  assert.equal(path.resolve(first.executablePath).toLowerCase(),path.join(app,'desktop-agent/publish/Iexa.DesktopAgent.exe').toLowerCase());
  report.cases.push({name:'Bundled native cold start from unrelated workspace',status:'passed',pid:first.pid,executablePath:first.executablePath});save();
  await wait(32000);
  let exited=false;try{await fetch('http://127.0.0.1:17891/health',{signal:AbortSignal.timeout(500)});}catch{exited=true;}assert.equal(exited,true,'helper should reclaim idle resources');
  await run('native');const second=await(await fetch('http://127.0.0.1:17891/health')).json();assert.notEqual(second.instanceNonce,first.instanceNonce);
  assert.equal(second.executablePath,first.executablePath);
  report.cases.push({name:'Idle reclamation followed by successful packaged restart',status:'passed',pid:second.pid,executablePath:second.executablePath});save();
  await run('native-isolated');const info=agent.isolatedWorkspace.diagnostics().ready;assert.ok(info.jobBound);
  report.cases.push({name:'Packaged isolated capability verification and worker startup',status:'passed',pid:info.pid});report.status='passed';
 }catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;}
 finally{agent?.close();closeDesktopHelpers();await wait(6000);save();console.log(JSON.stringify({status:report.status,error:report.error,output:out}));}
}
main();
