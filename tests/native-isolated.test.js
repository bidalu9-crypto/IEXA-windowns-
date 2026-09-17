const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
const {DesktopControlSession}=require('../dist/main/tools/desktop/DesktopControlSession');
const {DesktopControlScheduler}=require('../dist/main/tools/desktop/DesktopControlScheduler');
const {NativeIsolatedWorkspace}=require('../dist/main/tools/desktop/NativeIsolatedWorkspace');
function fixture(){
 const calls=[];const session=new DesktopControlSession(async args=>{
  calls.push(args);let data={};
  if(args.action==='launch')data={window:{handle:10}};
  if(args.action==='list_windows')data={windows:[{handle:10,pid:1,title:'owned',process:'owned'}]};
  if(args.action==='observe')data={session:{handle:10,observationToken:'token'},frame:{trust:'background-window-rendered'},elements:[]};
  if(args.action==='session_state')data={handle:10,foreground:false,observationToken:'token'};
  return {success:true,output:JSON.stringify({ok:true,data})};
 },new DesktopControlScheduler());
 return {calls,run:args=>session.execute(args,undefined,{owner:'test'})};
}
test('isolated launch stays in the isolated transport and returns a new owner observation',async()=>{
 const f=fixture();const r=await f.run({action:'launch',backend:'native-isolated',app:'notepad'});
 assert.equal(r.success,true,r.output);assert.equal(f.calls[0].action,'launch');assert.equal(f.calls[0].background,true);
 assert.ok(f.calls.every(c=>c.backend==='native-isolated'));assert.equal(f.calls.at(-1).action,'observe');
 assert.equal(r.metadata.desktop.dispatchedActions,1);
});
test('isolated backend never widens generic background launch or permits an explicit foreground downgrade',async()=>{
 for(const args of [{action:'launch',backend:'native',background:true},{action:'launch',backend:'native-isolated',background:false},{action:'activate',backend:'native-isolated'},{action:'launch',backend:'native-isolated',autoActivate:true}]){
  const f=fixture();assert.equal((await f.run(args)).success,false);assert.equal(f.calls.length,0);
 }
});
test('changing to isolated backend invalidates an existing snapshot before attempted input',async()=>{
 const f=fixture();await f.run({action:'observe',backend:'native'});const before=f.calls.length;
 const r=await f.run({action:'click',backend:'native-isolated',elementId:'old'});
 assert.equal(r.success,false);assert.match(r.output,/Fresh observe/);assert.equal(f.calls.length,before);
});
test('isolated worker loss never restarts a normal foreground native helper on its endpoint',async()=>{
 const agent=new DesktopAgent(process.cwd(),false,undefined,'http://127.0.0.1:17997',{expectedDesktopName:'IEXA-Owned-test'});
 let starts=0;agent.healthy=async()=>false;agent.start=async()=>{starts++;};
 const r=await agent.executeNative({action:'list_windows',background:true});
 assert.equal(r.success,false);assert.match(r.output,/no foreground fallback/);assert.equal(starts,0);agent.close();
});
test('unknown backend and mixed isolated/CDP routing fail before any fallback transport',async()=>{
 const agent=new DesktopAgent(process.cwd());let started=0;agent.ensureStarted=async()=>{started++;};
 assert.equal((await agent.executeNative({action:'observe',backend:'misspelled-backend'})).success,false);
 assert.equal((await agent.executeNative({action:'observe',backend:'native-isolated',cdpEndpoint:'http://127.0.0.1:9222'})).success,false);
 assert.equal(started,0);agent.close();
});
test('an old or replaced helper must have a matching isolation capability hash before launch',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-isolation-capability-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^iexa-isolation-capability-/);fs.rmSync(dir,{recursive:true,force:true});});
 const exe=path.join(dir,'Iexa.DesktopAgent.exe'),dll=exe.replace(/\.exe$/,'.dll'),marker=path.join(dir,'isolated-desktop-capability.json');
 fs.writeFileSync(exe,'inert test executable');fs.writeFileSync(dll,'source-build-A');
 const host=new NativeIsolatedWorkspace(dir,exe);
 assert.throws(()=>host.executable(),/matching capability/);
 fs.writeFileSync(marker,JSON.stringify({version:1,sha256:'wrong'}));assert.throws(()=>host.executable(),/matching capability/);
 fs.writeFileSync(marker,JSON.stringify({version:1,sha256:createHash('sha256').update(fs.readFileSync(dll)).digest('hex')}));assert.equal(host.executable(),exe);
 fs.writeFileSync(dll,'source-build-B');assert.throws(()=>host.executable(),/matching capability/);
 host.close();await assert.rejects(host.ensureStarted(),/closed or lost/);
});
test('pre-cancelled isolated workspace startup has no directory, process or executable lookup',async()=>{
 const host=new NativeIsolatedWorkspace(process.cwd());let lookedUp=false;host.executable=()=>{lookedUp=true;throw Error('should not run');};
 const abort=new AbortController();abort.abort();await assert.rejects(host.ensureStarted(abort.signal),/cancelled/);
 assert.equal(lookedUp,false);assert.equal(host.diagnostics().directory,undefined);host.close();
});

test('cancelled in-progress isolated startup cleans the attempt without poisoning retries',async()=>{
 const host=new NativeIsolatedWorkspace(process.cwd());const abort=new AbortController();
 host.start=async signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Isolated workspace creation cancelled.')),{once:true}));
 const first=host.ensureStarted(abort.signal);abort.abort();await assert.rejects(first,/cancelled/);
 assert.equal(host.diagnostics().failed,false);assert.equal(host.diagnostics().closed,false);assert.equal(host.diagnostics().directory,undefined);
 const ready={desktopName:'fixture',pid:1,hostPid:2,port:3,jobBound:true};host.start=async()=>{host.ready=ready;return ready;};
 assert.deepEqual(await host.ensureStarted(),ready);host.close();
});

test('operator takeover aborts the active lease, rejects queued/future work, and resume never replays it',async()=>{
 const q=new DesktopControlScheduler();let began,finish;const started=new Promise(r=>began=r),cleanup=new Promise(r=>finish=r);let ranSecond=false,aborted=false;
 const first=q.run('one','first',undefined,async lease=>{began();await new Promise(r=>lease.signal.addEventListener('abort',r,{once:true}));aborted=true;await cleanup;});
 const queued=q.run('two','second',undefined,async()=>{ranSecond=true;});const rejected=assert.rejects(queued,/User takeover/);
 await started;q.pause();await rejected;assert.equal(aborted,true);assert.equal(ranSecond,false);assert.equal(q.snapshot().paused,true);assert.ok(q.snapshot().active);
 await assert.rejects(q.run('new','blocked',undefined,async()=>{}),/paused/);
 q.resume();let ranAfter=false;const after=q.run('new','after',undefined,async()=>{ranAfter=true;});
 await new Promise(r=>setImmediate(r));assert.equal(ranAfter,false);finish();await Promise.all([first,after]);assert.equal(ranAfter,true);assert.equal(ranSecond,false);
});
