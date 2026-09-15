/* Actual configured provider -> production AgentLoop -> ToolRuntime -> DesktopAgent.
 * No generated action sequence or oracle injected into the model. Test guards only
 * restrict application/endpoint, never choose controls or perform task operations.
 * --visible adds independent foreground events; default uses isolated headless Edge.
 */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {AgentLoop}=require('../dist/main/agent/AgentLoop');
const {ToolRuntime}=require('../dist/main/runtime/ToolRuntime');
const {BudgetManager}=require('../dist/main/runtime/BudgetManager');
const {ProviderFactory}=require('../dist/main/providers/ProviderFactory');
const {selectedProfile}=require('./helpers/selected-model-profile.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts','desktop-autonomous',`${Date.now()}-${randomUUID().slice(0,8)}`);
const visible=process.argv.includes('--visible'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const report={scope:'real configured model autonomous single task; not universal parity',visible,actions:[],results:[],states:[],usages:[],receipts:[],status:'running'};
const children=[],controller=new AbortController();let server,runtime,watch,timer,profile;let redact=s=>String(s);
const save=()=>fs.writeFileSync(path.join(out,'report.json'),redact(JSON.stringify(report,null,2)));
function readJson(name){try{return JSON.parse(fs.readFileSync(path.join(out,name),'utf8').replace(/^\uFEFF/,''));}catch{return null;}}
function events(){try{return fs.readFileSync(path.join(out,'focus-events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
function launch(exe,args,env=process.env){const fd=fs.openSync(path.join(out,`child-${children.length}.log`),'a');const p=spawn(exe,args,{env,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(p);p.on('error',e=>{report.launchError=redact(e.message);controller.abort();save();});return p;}
async function until(fn,label){for(let i=0;i<100;i++){const r=await fn();if(r)return r;await wait(75);}throw Error(label);}
async function port(){return await new Promise(resolve=>{const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function main(){
 fs.mkdirSync(out,{recursive:true});save();
 const settingsFile=path.join(root,'workspace/.iexa-settings.json');
 const settingsBefore=Object.fromEntries(['','.bak','.vault'].map(suffix=>[suffix,createHash('sha256').update(fs.readFileSync(settingsFile+suffix)).digest('hex')]));
 profile=selectedProfile(settingsFile);redact=s=>String(s).split(profile.apiKey).join('[REDACTED]');
 report.evaluatorVersion=2;
 report.model={provider:profile.provider,model:profile.model,apiMode:profile.apiMode,configuredActiveProfile:true};
 const appPort=await port(),cdpPort=await port(),reference='ORDER-'+randomUUID().slice(0,12),nonce=randomUUID();
 const firstId='entry-'+randomUUID().slice(0,8),reviewId='review-'+randomUUID().slice(0,8),commitId='commit-'+randomUUID().slice(0,8);
 const page=`<!doctype html><meta charset="utf-8"><title>IEXA Order Desk</title><style>body{font:18px system-ui;padding:40px}input,button{font:inherit;padding:8px;margin:12px}label{display:block}</style><h1>Order registration</h1><section><label>Order reference<input id="${firstId}" aria-label="Order reference"></label><button id="${reviewId}">Review registration</button></section><p role="status">Ready for a new order</p><script>const section=document.querySelector('section'),status=document.querySelector('[role=status]');document.querySelector('button').onclick=()=>{const reference=document.querySelector('input').value;if(!reference){status.textContent='Enter a reference';return}status.textContent='Preparing review';setTimeout(()=>{section.replaceChildren();const text=document.createElement('p');text.textContent='Review order '+reference;const button=document.createElement('button');button.id='${commitId}';button.textContent='Confirm registration';button.onclick=async()=>{button.disabled=true;const r=await fetch('/submit',{method:'POST',body:JSON.stringify({reference,nonce:'${nonce}',reviewed:true})});status.textContent=r.ok?'Registered '+reference:'Registration failed';button.remove()};section.append(text,button)},400)};</script>`;
 server=http.createServer(async(req,res)=>{if(req.url==='/submit'&&req.method==='POST'){let b='';for await(const c of req)b+=c;const payload=JSON.parse(b);report.receipts.push(payload);save();res.statusCode=payload.reference===reference&&payload.nonce===nonce&&payload.reviewed===true?200:422;res.end('receipt');return;}res.setHeader('content-type','text/html; charset=utf-8');res.end(page);});
 await new Promise(resolve=>server.listen(appPort,'127.0.0.1',resolve));const url=`http://127.0.0.1:${appPort}/`,endpoint=`http://127.0.0.1:${cdpPort}`;
 if(visible){
  launch('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/foreground-audit.ps1'),'-OutputDirectory',out]);report.focusInitial=await until(()=>readJson('focus-ready.json'),'Foreground monitor');
  const env={...process.env,IEXA_CDP_TEST_OUT:out,IEXA_CDP_TEST_URL:url,IEXA_CDP_TEST_PORT:String(cdpPort)};delete env.ELECTRON_RUN_AS_NODE;
  launch(require('electron'),[path.join(__dirname,'fixtures/chromium-visible.cjs')],env);report.host=await until(()=>readJson('visible-ready.json'),'Visible browser');assert.equal(report.host.focused,false);
  watch=setInterval(()=>{if(events().length){report.interruptedByForeground=true;controller.abort();}},30);
 }else{
  const exe=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);assert.ok(exe,'Chromium missing');report.browser=exe;
  launch(exe,['--headless=new',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${path.join(out,'profile')}`,'--no-first-run','--no-default-browser-check','--disable-background-networking',url]);
 }
 const target=await until(async()=>{try{return(await(await fetch(endpoint+'/json/list')).json()).find(t=>t.type==='page'&&t.url===url&&t.title==='IEXA Order Desk');}catch{return null;}},'Order page readiness');
 const workspace=path.join(out,'model-workspace');fs.mkdirSync(workspace,{recursive:true});
 runtime=new ToolRuntime({workspaceDir:workspace,memoryDir:path.join(workspace,'memory'),memoryEnabled:false,permissionMode:'risk',desktopCaptureFrames:false,budget:new BudgetManager({maxTurns:16,maxToolCalls:28,maxRuntimeMs:180000,maxInputTokens:150000}),permissionResolver:async request=>request.tool.name==='desktop_control'?'allow_once':'deny'});
 runtime.registerDefaults();runtime.beginRun(['desktop_control']);
 const desktop=runtime.registry.get('desktop_control'),execute=desktop.execute;let connected=false;
 // Enforce the same fixed application scope as an approval boundary. The model
 // chooses every operation/selector/text and receives real production results.
 desktop.execute=async(args,ctx)=>{
  const steps=args.action==='batch'&&Array.isArray(args.actions)?args.actions:[];
  for(const candidate of [args,...steps]){
   if(candidate.backend!==undefined&&candidate.backend!=='chromium-cdp'||candidate.cdpEndpoint!==undefined&&candidate.cdpEndpoint!==endpoint||candidate.cdpTargetId!==undefined&&candidate.cdpTargetId!==target.id)
    return {success:false,output:'Benchmark boundary: only the supplied Chromium endpoint and page are available.'};
   if(['launch','activate','minimize','move','drag','key','hotkey','scroll','read_focused'].includes(candidate.action)||candidate.autoActivate===true||candidate.forcePointer===true)
    return {success:false,output:'Benchmark boundary: background observation and semantic page actions only.'};
   if(['click','click_element','type','type_element'].includes(candidate.action)&&candidate.background!==true&&args.background!==true)
    return {success:false,output:'Background semantic input requires background:true.'};
  }
  if(!connected&&(!args.cdpEndpoint||args.backend!=='chromium-cdp'))return {success:false,output:'Choose backend chromium-cdp and the supplied cdpEndpoint first; native desktop is outside this test.'};
  connected=true;return execute(args,ctx);
 };
 const provider=ProviderFactory.create({type:profile.provider,name:profile.provider,model:profile.model,apiKey:profile.apiKey,baseURL:profile.baseURL,apiMode:profile.apiMode,thinkingLevel:profile.thinkingLevel});
 const loop=new AgentLoop({sessionId:'autonomous-'+randomUUID(),provider,toolRuntime:runtime,workspaceDir:workspace,memoryDir:path.join(workspace,'memory'),memoryEnabled:false,hasProject:false,maxTokens:4096,contextWindow:profile.contextWindow||128000,getAbortSignal:()=>controller.signal});
 await loop.initialize();
 const goal=`请在已经打开的 Order registration 应用中完成订单 ${reference} 的登记，并核对实际结果。全程后台操作，不切换或抢占前台。可用浏览器连接：backend=chromium-cdp，cdpEndpoint=${endpoint}，cdpTargetId=${target.id}。只使用 desktop_control，后台输入使用 background:true。页面布局和控件请自行观察；不要假设操作已成功。`;
 report.goal=goal;report.prewrittenActionsProvided=false;report.oracleExposedToModel=false;report.startedAt=Date.now();save();
 timer=setTimeout(()=>{report.deadlineExceeded=true;controller.abort();},180000);
 await loop.run(goal,runtime.definitions().filter(t=>t.name==='desktop_control'),{
  onTextDelta:(_delta,full)=>{report.answer=redact(full);},onThinkingDelta:()=>{},onToolCallStart:()=>{},onToolInputDelta:()=>{},
  onToolCallComplete:(id,name,args)=>{report.actions.push({id,name,args});save();},
  onToolResult:(id,result)=>{report.results.push({id,success:result.success,output:redact(result.output),desktop:result.metadata?.desktop,executionStatus:result.executionStatus});save();},
  onUsage:usage=>{report.usages.push(usage);save();},onContext:()=>{},
  onToolState:event=>{report.states.push(event);},onError:error=>{report.error=redact(error);},onDone:reason=>{report.stopReason=reason;},onCancelled:()=>{report.cancelled=true;},
 });
 clearTimeout(timer);report.durationMs=Date.now()-report.startedAt;report.budget=runtime.getBudget();
 report.metrics={toolCalls:report.actions.length,failedTools:report.results.filter(r=>!r.success).length,verifiedTools:report.results.filter(r=>r.desktop?.verified).length,duplicateSubmissions:Math.max(0,report.receipts.length-1),cancelledCallsWithPossiblePriorInput:report.results.filter(r=>r.desktop?.phase==='cancelled'&&r.desktop?.dispatchedActions>0).length,cost:null,costReason:'No authoritative price for the configured gateway model was supplied.'};
 report.businessVerified=report.receipts.length===1&&report.receipts[0].reference===reference&&report.receipts[0].nonce===nonce&&report.receipts[0].reviewed===true;
 report.modelEvidence=require('./helpers/autonomous-evidence.cjs').assessModelEvidence(report,'Registered '+reference);
 report.modelVerified=report.modelEvidence.length>0;
 if(visible){clearInterval(watch);await wait(100);report.focusEvents=events();fs.writeFileSync(path.join(out,'stop-monitor'),'');report.focusFinal=await until(()=>readJson('focus-ended.json'),'Foreground monitor finish');report.foregroundVerified=report.focusEvents.length===0&&report.focusInitial.foreground===report.focusFinal.foreground;}
 report.settingsUnchanged=['','.bak','.vault'].every(suffix=>createHash('sha256').update(fs.readFileSync(settingsFile+suffix)).digest('hex')===settingsBefore[suffix]);
 report.status=report.businessVerified&&report.modelVerified&&!report.cancelled&&!report.error&&report.settingsUnchanged&&(!visible||report.foregroundVerified)?'passed':'failed';
 save();console.log(JSON.stringify({out,status:report.status,model:report.model,businessVerified:report.businessVerified,modelVerified:report.modelVerified,foregroundVerified:report.foregroundVerified,metrics:report.metrics,durationMs:report.durationMs,error:report.error},null,2));if(report.status!=='passed')process.exitCode=1;
}
main().catch(e=>{report.status='failed';report.error=redact(e.message);console.error(redact(e.message));process.exitCode=1;}).finally(async()=>{
 clearTimeout(timer);clearInterval(watch);controller.abort();runtime?.desktop?.close();fs.mkdirSync(out,{recursive:true});save();
 fs.writeFileSync(path.join(out,'stop'),'');fs.writeFileSync(path.join(out,'stop-monitor'),'');await wait(200);for(const p of children){try{if(p.exitCode===null)p.kill();}catch{}}
 server?.closeAllConnections();server?.close();
});
