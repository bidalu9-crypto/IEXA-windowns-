'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn,execFile}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {createSupervisor,processTable}=require('./helpers/acceptance-supervisor.cjs');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function until(fn,label,ms=20000){const end=Date.now()+ms;let error;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){error=e;}await sleep(250);}throw Error(label+(error?': '+error.message:''));}
async function connect(url){const ws=new WebSocket(url),pending=new Map();let seq=0;await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data)),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});return{close:()=>ws.close(),send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}};}
async function evaluate(c,expression){const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
async function main(){
 const backendOnly=process.argv.includes('--backend-only');
 const runId=randomUUID(),out=path.join(root,'.iexa-artifacts/desktop-autonomy-20261110','model-'+Date.now()),fixture=path.join(out,'task-files');fs.mkdirSync(fixture,{recursive:true});
 const report={runId,startedAt:new Date().toISOString(),scope:'Current selected real model; production /api/chat and desktop_control only; browser download, Explorer rename, WPS edit/save; no credential file access',status:'running',events:[]};
 const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));save();
 // WPS cloud/plugin processes can intentionally outlive their document windows.
 // Explicit fixture cleanup is part of this benchmark, and remains audited.
 const supervisor=createSupervisor({output:out,maximumDurationMs:600000,allowFixtureCleanup:true,observeProcess:row=>String(row.CommandLine||'').toLowerCase().includes('d:\\mystudio\\wps office\\')});let app,helper,web,page,inspector,sessionId,appIdentity,helperIdentity;
 const appRoot=path.join(root,'release/IEXA-preview-20261109'),chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',wps='D:\\MyStudio\\WPS Office\\12.1.0.28505\\office6\\wps.exe';
 try{
  report.packageManifestSHA256=createHash('sha256').update(fs.readFileSync(path.join(appRoot,'build-manifest.json'))).digest('hex');save();
  const existing=(await processTable()).filter(p=>/^(IEXA|electron|wps|et)\.exe$/i.test(p.Name));
  // Background preview/addon servers may be created through DCOM rather than
  // our parent tree. Observe their memory, never claim or terminate them.
  const background=existing.filter(p=>/^wps\.exe$/i.test(p.Name)&&(/\/Preview\s+-Embedding/i.test(p.CommandLine||'')||/\bRun\s+-Entry=EntryPoint\b/i.test(p.CommandLine||'')));
  const blocking=existing.filter(p=>!background.includes(p));
  if(blocking.length)throw Error('Existing application prevents exclusive acceptance: '+blocking.map(p=>p.Name+':'+p.ProcessId).join(','));
  if(background.length){
   if(background.some(p=>!Number.isSafeInteger(p.ProcessId)))throw Error('Invalid background process identity');
   const handles=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoLogo','-NoProfile','-Command',"@(Get-Process -Id "+background.map(p=>p.ProcessId).join(',')+" -ErrorAction SilentlyContinue | Select-Object Id,@{Name='Handle';Expression={$_.MainWindowHandle.ToInt64()}}) | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8',timeout:10000},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout.replace(/^\uFEFF/,'')||'[]'))));
   if([handles].flat().some(p=>p.Handle!==0))throw Error('An existing WPS server has a visible window; acceptance will not reuse it');
   report.backgroundBaseline=background.map(p=>({pid:p.ProcessId,created:p.CreationDate,role:/\/Preview\s+-Embedding/i.test(p.CommandLine||'')?'preview-server':'addon-server'}));save();
  }
  await supervisor.begin();
  try{await fetch('http://127.0.0.1:17891/health',{signal:AbortSignal.timeout(400)});throw Error('Desktop helper port is already occupied');}catch(error){if(error.message==='Desktop helper port is already occupied')throw error;}
  const receipt='REF_'+randomUUID().replace(/-/g,'').slice(0,14),marker='DONE_'+runId.slice(0,8),filename='delivery-'+runId.slice(0,8)+'.rtf',finalname='accepted-'+runId.slice(0,8)+'.rtf';
  const rtf='{\\rtf1\\ansi IEXA_REFERENCE '+receipt+'\\par STATUS PENDING\\par }';report.fixture={directory:fixture,receipt,marker,filename,finalname};
  web=http.createServer((req,res)=>{if(req.url==='/delivery.rtf'){report.downloads=(report.downloads||0)+1;save();res.writeHead(200,{'Content-Type':'application/rtf','Content-Disposition':'attachment; filename="'+filename+'"'});res.end(rtf);return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><title>IEXA Desktop Acceptance '+runId.slice(0,8)+'</title><style>body{font:24px system-ui;padding:48px}a{display:block;padding:20px;background:#eee}</style><h1>Delivery document</h1><p>Reference: '+receipt+'</p><a href="/delivery.rtf" download="'+filename+'">Download delivery document</a>');});await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
  const pageURL='http://127.0.0.1:'+web.address().port+'/',cdpPort=await port(),inspectPort=await port();
  const start=(exe,args,log,env)=>{delete env.ELECTRON_RUN_AS_NODE;const fd=fs.openSync(path.join(out,log),'w');const p=spawn(exe,args,{cwd:path.dirname(exe),env,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);return p;};
  // No helper is supplied by the harness: production must resolve and launch its
  // own bundled executable, including after normal idle reclamation.
  let originalSessionId;
  if(backendOnly){
   const host=path.join(root,'scripts/helpers/model-backend-host.cjs'),fd=fs.openSync(path.join(out,'application.log'),'w'),began=Date.now();
   app=spawn(path.join(appRoot,'IEXA.exe'),['--max-old-space-size=384',host,path.join(appRoot,'resources/app')],{cwd:root,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',IEXA_WORKSPACE:path.join(root,'workspace')},stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);
   let sequence=0;const pending=new Map();
   const ready=new Promise((resolve,reject)=>{app.on('error',reject);app.on('message',m=>{if(m.ready)return resolve(m);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve({result:{value:m.value}});}else if(m.error)reject(Error(m.error));});});
   page={close(){},send(method,params){if(method!=='Runtime.evaluate')throw Error('Only acceptance evaluation is available in backend host');return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Host timeout'));},20000);pending.set(id,{resolve,reject,timer});app.send({id,expression:params.expression});});}};
   appIdentity=await supervisor.claimSpawn(app,host,began);const info=await Promise.race([ready,supervisor.failure]);originalSessionId=info.originalSessionId;
   report.app={pid:appIdentity.ProcessId,created:appIdentity.CreationDate,exe:path.join(appRoot,'IEXA.exe')};
   report.acceptanceHost='Packaged standalone production server/provider/runtime; internal authenticated API; no Electron renderer or browser harness; app GUI benchmark is separate';
  }else{
  let began=Date.now();app=start(path.join(appRoot,'IEXA.exe'),['--js-flags=--max-old-space-size=384','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+cdpPort,'--inspect=127.0.0.1:'+inspectPort],'application.log',{...process.env,IEXA_PORT:'19840',IEXA_HEADLESS:'1'});appIdentity=await supervisor.claimSpawn(app,'--remote-debugging-port='+cdpPort,began);
  report.app={pid:appIdentity.ProcessId,created:appIdentity.CreationDate,exe:path.join(appRoot,'IEXA.exe')};save();
  const mainTarget=await until(async()=>(await(await fetch('http://127.0.0.1:'+inspectPort+'/json/list')).json())[0],'Main inspector');inspector=await connect(mainTarget.webSocketDebuggerUrl);
  const target=await until(async()=>(await(await fetch('http://127.0.0.1:'+cdpPort+'/json/list')).json()).find(t=>t.type==='page'&&/^http:\/\/127\.0\.0\.1:19840\//.test(t.url)),'Logged-in app page');page=await connect(target.webSocketDebuggerUrl);
  await until(()=>evaluate(page,'typeof currentSessionId==="string"&&!!currentSessionId'),'App session ready');
  originalSessionId=await evaluate(page,'currentSessionId');
  // Keep the ordinary authenticated same-origin browser session but release the
  // conversation UI. The real backend/runtime/provider remain the packaged app.
  await page.send('Page.navigate',{url:'http://127.0.0.1:19840/api/health'});
  await until(()=>evaluate(page,'location.pathname==="/api/health"&&document.readyState==="complete"'),'Minimal same-origin acceptance host');
  await page.send('HeapProfiler.collectGarbage');await inspector.send('HeapProfiler.collectGarbage');
  report.acceptanceHost='Minimal same-origin authenticated renderer; production server/runtime, hidden app UI to fit the unchanged 1.2 GiB test budget';
  }
  const chromeProfile=path.join(out,'chrome-profile');fs.mkdirSync(path.join(chromeProfile,'Default'),{recursive:true});
  fs.writeFileSync(path.join(chromeProfile,'Default','Preferences'),JSON.stringify({download:{default_directory:fixture,prompt_for_download:true,directory_upgrade:true},browser:{check_default_browser:false},credentials_enable_service:false,profile:{password_manager_enabled:false},background_mode:{enabled:false}}));
  const goal=`执行一次真实跨应用桌面验收，只使用 desktop_control。用 Chrome 访问 ${pageURL}，下载网页提供的 RTF 文档并通过界面保存到 ${fixture}。用 Windows 资源管理器把下载的 ${filename} 重命名为 ${finalname}，然后用 WPS 打开，保留原始 IEXA_REFERENCE 内容，将 STATUS PENDING 改为 STATUS ${marker}，保存同一份 RTF 并重新打开核对。最终报告网页上的 Reference、文件完整路径和实际完成情况。所有操作仅限此测试目录和你启动的测试窗口；不要动其他文件、会话或设置，不要使用命令行、脚本、PowerShell或地址栏执行代码。请使用 backend=native、controlMode=foreground，必要时显式activate；每次操作后观察。明确授权启动这三个应用和在测试目录保存。Chrome路径 ${chrome}，必须用独立参数 --user-data-dir="${chromeProfile}" --no-first-run --no-default-browser-check --disable-background-networking --disable-extensions --renderer-process-limit=2 --disable-gpu --force-renderer-accessibility ${pageURL} 启动；WPS路径 ${wps}。已知文件路径可通过应用打开/另存为对话框输入。下载完成后关闭本次Chrome窗口再打开WPS，控制内存。需要读取画面时主动使用captureFrame:true或frame；至少读取一张实际截图。遇到目标过期先重新observe，不重复已执行输入。最多40次工具调用，7分钟内完成，遇阻清楚说明。`;
  report.goal=backendOnly?goal.replace('最多40次工具调用，7分钟内完成','最多60次工具调用，8分钟内完成'):goal;save();
  const {runCurrentModelAcceptance}=require('./helpers/current-model-acceptance.cjs');
  const setup=await evaluate(page,'('+runCurrentModelAcceptance.toString()+')('+JSON.stringify({goal:report.goal,runId,originalSessionId,...(backendOnly?{maxTools:60,maxRuntimeMs:480000}:{})})+')');report.setup=setup;sessionId=setup.sessionId;save();
  const end=Date.now()+(backendOnly?500000:450000);let lastCount=0,savedImages=0,previewArmed=false;
  while(Date.now()<end){
   const state=await evaluate(page,'(()=>{const s=window.__iexaAcceptance;return s?{status:s.status,sessionId:s.sessionId,botId:s.botId,model:s.model,events:s.events,answer:s.answer,toolCalls:s.toolCalls,done:s.done,error:s.error,imageCount:s.images?.length}:null})()');
   report.modelState=state;save();if(state?.toolCalls!==lastCount){lastCount=state?.toolCalls;console.log(JSON.stringify({toolCalls:lastCount,status:state?.status,last:state?.events?.slice(-2).map(e=>({type:e.type,event:e.event,name:e.name,success:e.success}))}));}
   if((state?.imageCount||0)>savedImages){const images=await evaluate(page,'window.__iexaAcceptance.images.slice('+savedImages+')');for(const img of images){fs.writeFileSync(path.join(out,`model-frame-${savedImages++}.png`),Buffer.from(img.base64,'base64'));}await evaluate(page,'window.__iexaAcceptance.images.slice(0,'+savedImages+').forEach(image=>{image.base64=""});true');}
   if(state?.imageCount&&!previewArmed){await evaluate(page,`fetch('/api/prompt-preview?sessionId='+encodeURIComponent(${JSON.stringify(sessionId)}),{method:'POST'}).then(r=>r.json())`);previewArmed=true;}
   if(previewArmed&&!report.modelImageEvidence){const proof=await evaluate(page,`fetch('/api/prompt-preview?sessionId='+encodeURIComponent(${JSON.stringify(sessionId)})).then(r=>r.json()).then(x=>x.preview?{model:x.preview.model,capturedAt:x.preview.capturedAt,hasImageData:x.preview.text.includes('"type": "imageData"'),hasMediaOmitted:x.preview.text.includes('[MEDIA OMITTED]'),truncated:x.preview.truncated}:null)`);if(proof){report.modelImageEvidence=proof;save();}}
   if(state?.done||['completed','failed','cancelled','error','stopped'].includes(state?.status))break;
   await Promise.race([sleep(2500),supervisor.failure]);
  }
  const state=await evaluate(page,'window.__iexaAcceptance');report.modelState={...state,images:undefined};
  report.imageIndex=(state?.images||[]).map((img,index)=>({toolCallId:img.toolCallId,mimeType:img.mimeType,receivedAt:img.receivedAt,path:path.join(out,`model-frame-${index}.png`)}));
  for(const [i,img]of(state?.images||[]).entries()){const data=typeof img==='string'?img:img.data||img.imageData||img.base64;if(data)fs.writeFileSync(path.join(out,`model-frame-${i}.png`),Buffer.from(data,'base64'));}
  const finalpath=path.join(fixture,finalname);const content=fs.existsSync(finalpath)?fs.readFileSync(finalpath,'utf8'):'';
  report.oracle={file:finalpath,exists:!!content,receiptPreserved:content.includes(receipt),statusSaved:content.includes(marker),downloadObserved:(report.downloads||0)>0,imageCount:state?.images?.length||0,sha256:content?createHash('sha256').update(fs.readFileSync(finalpath)).digest('hex'):null};
  report.status=Object.values({completed:state?.status==='completed'&&state.done===true,exists:report.oracle.exists,reference:report.oracle.receiptPreserved,status:report.oracle.statusSaved,download:report.oracle.downloadObserved}).every(Boolean)?'passed':'failed';
 }catch(error){report.status='failed';report.error=error.stack;}
 finally{
  if(report.fixture){const expected=path.join(fixture,report.fixture.finalname),content=fs.existsSync(expected)?fs.readFileSync(expected,'utf8'):'';report.finalDiskAudit={file:expected,exists:!!content,receiptPreserved:content.includes(report.fixture.receipt),statusSaved:content.includes(report.fixture.marker),downloadObserved:(report.downloads||0)>0,actualFiles:fs.readdirSync(fixture),sha256:content?createHash('sha256').update(fs.readFileSync(expected)).digest('hex'):null};}
  if(page&&sessionId){try{await evaluate(page,`fetch('/api/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:${JSON.stringify(sessionId)}})}).then(r=>r.json())`);}catch(e){report.cancelError=e.message;}}
  if(inspector){try{await evaluate(inspector,"(typeof require==='function'?require:process.mainModule.require.bind(process.mainModule))('electron').app.quit();true");}catch{}}
  if(backendOnly&&app?.connected)app.send({quit:true});
  page?.close();inspector?.close();
  if(app)await until(()=>app.exitCode!==null||app.signalCode!==null,'Owned app exit',10000).catch(e=>{report.appExitError=e.message;});
  if(helper){try{await fetch('http://127.0.0.1:17891/shutdown',{method:'POST'});await until(()=>helper.exitCode!==null,'Helper exit',5000);}catch(e){report.helperExitError=e.message;}}
  if(web){web.closeAllConnections();await new Promise(resolve=>web.close(resolve));}
  try{report.resources=await supervisor.finish();}catch(e){report.resourceError=e.message;report.status='failed';}
  report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,error:report.error,oracle:report.oracle,resourceError:report.resourceError,output:out}));process.exitCode=report.status==='passed'?0:1;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
