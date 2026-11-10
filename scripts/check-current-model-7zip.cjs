'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {createSupervisor,processTable}=require('./helpers/acceptance-supervisor.cjs');
const {runCurrentModelAcceptance}=require('./helpers/current-model-acceptance.cjs');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
 const runId=randomUUID(),out=path.join(root,'.iexa-artifacts/desktop-autonomy-20261110','sevenzip-'+Date.now()),fixture=path.join(out,'task-files'),source=path.join(fixture,'payload'),restored=path.join(fixture,'restored'),archive=path.join(fixture,'bundle-'+runId.slice(0,8)+'.zip');
 fs.mkdirSync(path.join(source,'子目录'),{recursive:true});
 const payload={'说明.txt':'IEXA archive acceptance\nREF_'+randomUUID()+'\n中文文件内容应完整保留。\n','numbers.csv':'item,quantity\nalpha,17\nbeta,29\n','子目录/nested.txt':'NESTED_'+randomUUID()+'\n'};
 const originals=Object.entries(payload).map(([name,text])=>{const bytes=Buffer.from(text);fs.writeFileSync(path.join(source,name),bytes);return{name,bytes:bytes.length,sha256:hash(bytes)};});
 const report={runId,status:'running',startedAt:new Date().toISOString(),scope:'Current selected model; packaged production backend; desktop_control only; real 7-Zip GUI creates/tests/extracts ZIP; independent read-only byte oracle',fixture:{source,restored,archive,originals}};
 const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 const appRoot=path.join(root,'release/IEXA-preview-20261109'),exe='C:\\Program Files\\7-Zip\\7zFM.exe';
 const supervisor=createSupervisor({output:out,maximumDurationMs:600000,allowFixtureCleanup:true,observeProcess:p=>/^7z(?:FM|G)?\.exe$/i.test(p.Name)});
 let app,evaluate,sessionId,pending=new Map();
 try{
  const existing=(await processTable()).filter(p=>/^(IEXA|electron|7zFM|7zG)\.exe$/i.test(p.Name));if(existing.length)throw Error('Existing application prevents exclusive acceptance: '+existing.map(p=>p.Name+':'+p.ProcessId));
  await supervisor.begin();
  try{await fetch('http://127.0.0.1:17891/health',{signal:AbortSignal.timeout(400)});throw Error('Desktop helper port occupied');}catch(e){if(e.message==='Desktop helper port occupied')throw e;}
  report.packageManifestSHA256=hash(fs.readFileSync(path.join(appRoot,'build-manifest.json')));
  const host=path.join(root,'scripts/helpers/model-backend-host.cjs'),fd=fs.openSync(path.join(out,'application.log'),'w'),started=Date.now();
  app=spawn(path.join(appRoot,'IEXA.exe'),['--max-old-space-size=384',host,path.join(appRoot,'resources/app')],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',IEXA_WORKSPACE:path.join(root,'workspace')},windowsHide:true,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);
  let sequence=0;
  const ready=new Promise((resolve,reject)=>{app.once('error',reject);app.on('message',m=>{if(m.ready)return resolve(m);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value);}else if(m.error)reject(Error(m.error));});});
  evaluate=expression=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Acceptance host timeout'));},20000);pending.set(id,{resolve,reject,timer});app.send({id,expression});});
  const identity=await supervisor.claimSpawn(app,host,started),info=await Promise.race([ready,supervisor.failure]);report.app={pid:identity.ProcessId,created:identity.CreationDate};
  report.goal=`执行真实 7-Zip 桌面任务，只使用 desktop_control，backend=native、controlMode=foreground，必要时显式activate。启动 ${exe}，通过应用界面把 ${source} 文件夹（3个文件，含中文文件名及子目录）创建为 ZIP 压缩包 ${archive}；在 7-Zip 中打开并测试压缩包，检查无错误；通过应用界面将其解压到新目录 ${restored}，保留 payload 文件夹和全部层级。重新在7-Zip浏览解压后的文件确认结构，最后报告准确压缩包路径、解压路径和实际验证结果，并关闭你启动的7-Zip窗口。所有业务操作必须由GUI完成，不得使用shell、命令行、脚本、文件写入工具或地址栏执行代码；不要通过文本编辑器复制内容重建文件。仅操作本轮 ${fixture}，不动其他文件或用户设置。已有源文件是验收输入，不得修改。创建压缩包、测试、解压及核对各阶段需读取实际截图并观察当前控件，遇到失效目标先重新observe，使用最新elementId定位，别盲目重放输入。明确授权启动7-Zip及写入本轮输出目录。最多60次工具调用、8分钟，遇阻如实说明。`;
  save();const setup=await evaluate('('+runCurrentModelAcceptance.toString()+')('+JSON.stringify({runId,goal:report.goal,originalSessionId:info.originalSessionId,maxTools:60,maxRuntimeMs:480000})+')');report.setup=setup;sessionId=setup.sessionId;save();
  let savedImages=0,lastCount=0;
  while(true){
   const state=await evaluate('(()=>{const s=window.__iexaAcceptance;return {status:s.status,done:s.done,model:s.model,toolCalls:s.toolCalls,answer:s.answer,events:s.events,imageCount:s.images.length}})()');report.modelState=state;save();
   if(state.toolCalls!==lastCount){lastCount=state.toolCalls;console.log(JSON.stringify({toolCalls:lastCount,status:state.status}));}
   if(state.imageCount>savedImages){const images=await evaluate('window.__iexaAcceptance.images.slice('+savedImages+')');for(const img of images)fs.writeFileSync(path.join(out,`model-frame-${savedImages++}.png`),Buffer.from(img.base64,'base64'));await evaluate('window.__iexaAcceptance.images.slice(0,'+savedImages+').forEach(i=>i.base64="");true');}
   if(state.done)break;await Promise.race([sleep(2500),supervisor.failure]);
  }
  const state=await evaluate('window.__iexaAcceptance');report.modelState={...state,images:undefined};report.imageIndex=state.images.map((im,i)=>({toolCallId:im.toolCallId,receivedAt:im.receivedAt,path:path.join(out,`model-frame-${i}.png`)}));
  for(const [i,im]of state.images.entries())if(im.base64)fs.writeFileSync(path.join(out,`model-frame-${i}.png`),Buffer.from(im.base64,'base64'));
  const rows=originals.map(o=>{const original=path.join(source,o.name),output=path.join(restored,'payload',o.name);return{...o,sourceUnchanged:hash(fs.readFileSync(original))===o.sha256,restoredExists:fs.existsSync(output),restoredSHA256:fs.existsSync(output)?hash(fs.readFileSync(output)):null};});
  let zip;
  if(fs.existsSync(archive)){
   // Reads ZIP contents only; no extraction or archive mutation in the oracle.
   const py='import sys,zipfile,hashlib,json\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({"badCRC":z.testzip(),"files":[{"name":i.filename,"sha256":hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist() if not i.is_dir()]},ensure_ascii=True))';
   zip=JSON.parse(execFileSync('python',['-c',py,archive],{windowsHide:true,encoding:'utf8',timeout:15000}));
  }
  const checks={modelCompleted:state.status==='completed'&&state.done,desktopToolsOnly:state.calls.length>0&&state.calls.every(c=>c.name==='desktop_control'),screenshots:state.images.length>0,archiveExists:fs.existsSync(archive),archiveCRC:!!zip&&zip.badCRC===null,archiveExactContents:!!zip&&zip.files.length===originals.length&&originals.every(o=>zip.files.some(e=>e.name.replace(/\\/g,'/')==='payload/'+o.name&&e.sha256===o.sha256)),sourcesUnchanged:rows.every(r=>r.sourceUnchanged),extractedExactContents:rows.every(r=>r.restoredSHA256===r.sha256)};
  report.oracle={checks,files:rows,zip,archiveSHA256:fs.existsSync(archive)?hash(fs.readFileSync(archive)):null};report.status=Object.values(checks).every(Boolean)?'passed':'failed';
 }catch(error){report.status='failed';report.error=error.stack;}
 finally{
  if(evaluate&&sessionId)try{await evaluate(`fetch('/api/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:${JSON.stringify(sessionId)}})}).then(r=>r.json())`);}catch(e){report.cancelError=e.message;}
  if(app?.connected)app.send({quit:true});if(app)for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await sleep(100);
  for(const p of pending.values())clearTimeout(p.timer);pending.clear();
  try{report.resources=await supervisor.finish();}catch(e){report.status='failed';report.resourceError=e.message;}
  report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,error:report.error,checks:report.oracle?.checks,resourceError:report.resourceError,out}));process.exitCode=report.status==='passed'?0:1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
