/* Actual Windows compositor capture and pause contract; no user software input. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),net=require('node:net');
const sharp=require('sharp');
const {spawn}=require('node:child_process');const {randomBytes,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');const out=path.join(root,'.iexa-artifacts','desktop-freeze-guard','capture-'+Date.now());fs.mkdirSync(out,{recursive:true});
const exe=path.resolve(process.env.IEXA_CAPTURE_TEST_HELPER || path.join(root,'.iexa-artifacts/desktop-freeze-guard/native-build/Iexa.DesktopAgent.exe'));
const children=[];const report={cases:[],scope:'capture/preview safety, not input or WeChat task completion'};let endpoint;
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(out,name),'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
async function until(fn,label){for(let i=0;i<100;i++){const value=await fn();if(value)return value;await sleep(75);}throw Error(label);}
function launch(exe,args,env=process.env){const log=fs.openSync(path.join(out,`child-${children.length}.log`),'a');const child=spawn(exe,args,{windowsHide:true,stdio:['ignore',log,log],env});fs.closeSync(log);children.push(child);return child;}
async function main(){
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});endpoint=`http://127.0.0.1:${port}`;
 const native=launch(exe,[],{...process.env,IEXA_DESKTOP_PORT:String(port)});
 const health=await until(async()=>{try{const r=await fetch(endpoint+'/health',{signal:AbortSignal.timeout(300)});return await r.json();}catch{return null;}},'helper readiness');assert.equal(health.pid,native.pid);assert.equal(path.resolve(health.executablePath).toLowerCase(),exe.toLowerCase());assert.equal(health.cachedPreview,true);report.health=health;
 report.dllSha256=createHash('sha256').update(fs.readFileSync(exe.replace(/\.exe$/,'.dll'))).digest('hex');
 const fixture=launch('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/desktop-compositor-audit.ps1'),'-Title','IEXA capture audit '+randomBytes(4).toString('hex'),'-OutputDirectory',out,'-HelperPid',String(native.pid)]);
 const ready=await until(()=>read('ready.json'),'fixture readiness');report.initial=ready;assert.equal(read('helper-dpi.json')?.awareness,2);report.cases.push({name:'Native capture process is per-monitor DPI-aware (OS query)',status:'passed'});await until(()=>read('state.json'),'audit readiness');
 const observe=await fetch(endpoint+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'observe',handle:ready.handle,pid:fixture.pid,background:true,includeElements:false}),signal:AbortSignal.timeout(6000)});report.observe=await observe.json();save();assert.equal(report.observe.ok,true);assert.equal(report.observe.data.frame.trust,'background-compositor',JSON.stringify(report.observe.data.frame));
 report.cases.push({name:'Actual nonforeground capture supplied by Windows compositor',status:'passed'});
 const token=report.observe.data.session.observationToken;
 const frame=await fetch(endpoint+'/frame?cached=1&observationToken='+encodeURIComponent(token));assert.equal(frame.status,200,await frame.clone().text());assert.equal(frame.headers.get('x-iexa-frame-mode'),'cached-observation');fs.writeFileSync(path.join(out,'frame.png'),Buffer.from(await frame.arrayBuffer()));
 // Independent screen coordinates from the fixture, not the capture implementation.
 async function checkPixels(observation, file) {
  const geometry=await until(()=>read('geometry.json'),'fixture geometry');
  const bounds=observation.data.session.bounds;
  const {data,info}=await sharp(file).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const x=geometry.markerX-bounds.left,y=geometry.markerY-bounds.top;
  const pixel=(dx,dy)=>{const n=((y+dy)*info.width+x+dx)*info.channels;return Array.from(data.subarray(n,n+3));};
  for(const [dx,dy] of [[1,1],[22,1],[1,22],[22,22]])assert.deepEqual(pixel(dx,dy),[229,17,191]);
  assert.notDeepEqual(pixel(-1,12),[229,17,191]);assert.notDeepEqual(pixel(24,12),[229,17,191]);
 }
 await checkPixels(report.observe,path.join(out,'frame.png'));
 report.cases.push({name:'Decorated window pixels match independent screen coordinates without scaling',status:'passed'});
 const captures=[];
 for(let i=0;i<8;i++){const r=await fetch(endpoint+'/frame?cached=1');assert.equal(r.status,200);captures.push(r.headers.get('x-captured-at'));await r.arrayBuffer();}
 assert.ok(captures.every(value=>value===captures[0]));assert.equal(fs.readFileSync(path.join(out,'paint-requests.txt'),'utf8'),'0');
 report.cases.push({name:'Repeated cached preview never asks target to handle WM_PRINT/WM_PRINTCLIENT',status:'passed',paintRequests:0,capturedAt:captures[0]});
 // Exercise new capture only on our own fixture; no user software is touched.
 for(const mode of ['move','borderless','hide']) {
  fs.writeFileSync(path.join(out,'command.txt'),mode);
  const geometry=await until(()=>{const g=read('geometry.json');return g?.mode===mode?g:null;},'fixture '+mode);
  await sleep(100);
  const response=await fetch(endpoint+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'observe',handle:geometry.handle,pid:fixture.pid,background:true,includeElements:false}),signal:AbortSignal.timeout(6000)});
  const result=await response.json();report[mode]=result;assert.equal(result.ok,true,JSON.stringify(result));
  if(mode==='hide') {
   assert.equal(result.data.frame.trust,'background-unverified');assert.match(result.data.frame.diagnostic,/hidden/);
   assert.equal(read('geometry.json').visible,false);
  } else {
   assert.equal(result.data.frame.trust,'background-compositor',JSON.stringify(result.data.frame));
   const r=await fetch(endpoint+'/frame?cached=1&observationToken='+result.data.session.observationToken);assert.equal(r.status,200);
   const file=path.join(out,mode+'.png');fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));await checkPixels(result,file);
  }
  report.cases.push({name:mode==='hide'?'Hidden target fails explicitly without showing it':mode+' capture preserves exact pixel-to-screen mapping',status:'passed'});
 }
 assert.equal((await fetch(endpoint+'/pause',{method:'POST'})).status,200);
 for(const suffix of ['?cached=1','?full=1','']){const r=await fetch(endpoint+'/frame'+suffix);assert.equal(r.status,423);await r.arrayBuffer();}
 assert.equal(fs.readFileSync(path.join(out,'paint-requests.txt'),'utf8'),'0');report.cases.push({name:'Pause rejects cached, explicit and screen captures',status:'passed'});
 const state=read('state.json');assert.equal(state.foreground,ready.foreground);const events=fs.existsSync(path.join(out,'foreground-events.jsonl'))?fs.readFileSync(path.join(out,'foreground-events.jsonl'),'utf8').trim():'';assert.equal(events,'');report.cases.push({name:'No input and no foreground transitions',status:'passed',foregroundEvents:0});
 // Resume is observation-only; it must not replay any action or cause WM_PRINT.
 assert.equal((await fetch(endpoint+'/resume',{method:'POST'})).status,200);
 await sleep(100);
 assert.equal(fs.readFileSync(path.join(out,'paint-requests.txt'),'utf8'),'0');
 assert.equal(fs.existsSync(path.join(out,'receipt.txt')),false);
 report.cases.push({name:'Resume emits no input replay and no target paint request',status:'passed'});
 report.status='passed';save();console.log(JSON.stringify({out,status:report.status,cases:report.cases},null,2));
}
main().catch(e=>{report.status='failed';report.error=e.stack;process.exitCode=1;console.error(e.message);}).finally(async()=>{
 fs.writeFileSync(path.join(out,'stop'),'');if(endpoint)try{await fetch(endpoint+'/shutdown',{method:'POST',signal:AbortSignal.timeout(1000)});}catch{}
 for(const child of children){for(let i=0;i<40&&child.exitCode===null&&child.signalCode===null;i++)await sleep(50);if(child.exitCode===null&&child.signalCode===null)child.kill();}
 report.children=children.map(c=>({pid:c.pid,exitCode:c.exitCode,signal:c.signalCode}));save();
});
