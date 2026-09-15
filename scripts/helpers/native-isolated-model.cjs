const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {AgentLoop}=require('../../dist/main/agent/AgentLoop');
const {ToolRuntime}=require('../../dist/main/runtime/ToolRuntime');
const {BudgetManager}=require('../../dist/main/runtime/BudgetManager');
const {ProviderFactory}=require('../../dist/main/providers/ProviderFactory');
const {DesktopAgent}=require('../../dist/main/tools/DesktopAgent');
const {selectedProfile}=require('./selected-model-profile.cjs');
async function nativeIsolatedModel({root,out,exe,document}){
 const settings=path.join(root,'workspace/.iexa-settings.json');
 const fingerprints=()=>Object.fromEntries(['','.bak','.vault'].map(s=>[s,fs.existsSync(settings+s)?createHash('sha256').update(fs.readFileSync(settings+s)).digest('hex'):null]));
 const before=fingerprints(),profile=selectedProfile(settings),redact=s=>String(s).split(profile.apiKey).join('[REDACTED]');
 const reference='Native autonomous '+require('node:crypto').randomUUID();
 const report={status:'running',scope:'Real configured model autonomously launches, edits and saves actual Windows Notepad through the production native-isolated backend',model:{provider:profile.provider,model:profile.model,apiMode:profile.apiMode},reference,actions:[],results:[],states:[],usages:[],prewrittenActionsProvided:false};
 const save=()=>fs.writeFileSync(path.join(out,'native-model-report.json'),redact(JSON.stringify(report,null,2)));
 const workspace=out;fs.mkdirSync(workspace,{recursive:true});
 const runtime=new ToolRuntime({workspaceDir:workspace,memoryDir:path.join(workspace,'memory'),memoryEnabled:false,permissionMode:'risk',desktopCaptureFrames:false,budget:new BudgetManager({maxTurns:16,maxToolCalls:24,maxRuntimeMs:180000,maxInputTokens:160000}),permissionResolver:async request=>request.tool.name==='desktop_control'?'allow_once':'deny'});
 // Select the freshly built binary only; no fake transport or preprogrammed task executor.
 runtime.desktop.close();runtime.desktop=new DesktopAgent(root,false,path.join(out,'journal'),undefined,{executable:exe});
 runtime.registerDefaults();runtime.beginRun(['desktop_control','file_read']);
 const fileTool=runtime.registry.get('file_read'),readFile=fileTool.execute;
 fileTool.execute=(args,context)=>path.resolve(String(args.path||''))===document?readFile(args,context):Promise.resolve({success:false,output:'Read-back verification is limited to the supplied document.'});
 const desktop=runtime.registry.get('desktop_control'),execute=desktop.execute;let connected=false;
 desktop.execute=async(args,context)=>{
  for(const step of [args,...(args.action==='batch'&&Array.isArray(args.actions)?args.actions:[])]){
   if(step.backend!==undefined&&step.backend!=='native-isolated'||step.cdpEndpoint||step.cdpTargetId||step.background===false||step.autoActivate===true||step.forcePointer===true)
    return {success:false,output:'This task is confined to the native-isolated background workspace.'};
   if(['activate','minimize','move','drag','key','hotkey','scroll','read_focused'].includes(step.action))return {success:false,output:'Physical input and activation are outside this task.'};
   if(step.action==='launch'){
    const app=String(step.app||step.executable||'').toLowerCase();const args=String(step.arguments||'').trim().replace(/^"|"$/g,'');
    if(!['notepad','notepad.exe','记事本',path.join(process.env.WINDIR,'System32/notepad.exe').toLowerCase()].includes(app)||path.resolve(args)!==document)
     return {success:false,output:'Launch only Notepad with the supplied document path in this test.'};
   }
  }
  if(!connected&&args.backend!=='native-isolated')return {success:false,output:'Choose backend=native-isolated first; existing foreground apps are outside this task.'};
  connected=true;return execute(args,context);
 };
 const controller=new AbortController();let timer;const started=Date.now();
 try{
  const provider=ProviderFactory.create({type:profile.provider,name:profile.provider,model:profile.model,apiKey:profile.apiKey,baseURL:profile.baseURL,apiMode:profile.apiMode,thinkingLevel:profile.thinkingLevel});
  const loop=new AgentLoop({sessionId:'native-autonomous',provider,toolRuntime:runtime,workspaceDir:workspace,memoryDir:path.join(workspace,'memory'),memoryEnabled:false,hasProject:false,maxTokens:4096,contextWindow:profile.contextWindow||128000,getAbortSignal:()=>controller.signal});
  await loop.initialize();
  report.goal=`在独立后台工作桌面中启动真实 Windows 记事本，打开文件 ${document}，把全部正文替换成这一行：${reference}，然后保存到原文件并核对结果。使用 desktop_control 的 backend=native-isolated，全程 background:true，不影响用户现有窗口。控件与菜单请自行观察定位，只用 desktop_control 操作软件；可以用 file_read 读回这一目标文件核验保存，禁止用文件写入或 shell 代替软件操作。`;
  save();timer=setTimeout(()=>{report.deadlineExceeded=true;controller.abort();},180000);
  await loop.run(report.goal,runtime.definitions().filter(t=>['desktop_control','file_read'].includes(t.name)),{
   onTextDelta:(_delta,full)=>{report.answer=redact(full);},onThinkingDelta:()=>{},onToolCallStart:()=>{},onToolInputDelta:()=>{},
   onToolCallComplete:(id,name,args)=>{report.actions.push({id,name,args});save();},
   onToolResult:(id,result)=>{report.results.push({id,success:result.success,output:redact(result.output),desktop:result.metadata?.desktop,executionStatus:result.executionStatus});save();},
   onUsage:usage=>{report.usages.push(usage);save();},onContext:()=>{},onToolState:event=>{report.states.push(event);},onError:error=>{report.error=redact(error);},onDone:reason=>{report.stopReason=reason;},onCancelled:()=>{report.cancelled=true;},
  });
  report.diskText=fs.readFileSync(document,'utf8').replace(/^\uFEFF/,'');
  report.businessVerified=report.diskText===reference;
  const calls=new Map(report.actions.map(a=>[a.id,a]));
  report.observationEvidence=report.results.filter(r=>r.success&&calls.get(r.id)?.args?.action==='observe'&&r.output.includes(reference)).map(r=>r.id);
  report.readBackEvidence=report.results.filter(r=>r.success&&calls.get(r.id)?.name==='file_read'&&r.output.includes(reference)).map(r=>r.id);
  report.status=report.businessVerified&&report.observationEvidence.length&&report.readBackEvidence.length&&!report.error&&!report.cancelled?'passed':'failed';
 }catch(e){report.error=redact(e.message);report.status='failed';}
 finally{
  clearTimeout(timer);controller.abort();report.host=runtime.desktop.isolatedWorkspace?.diagnostics();runtime.desktop.close();
  if(report.host?.directory)for(let i=0;i<60;i++){try{report.hostEnded=JSON.parse(fs.readFileSync(path.join(report.host.directory,'ended.json'),'utf8'));break;}catch{await new Promise(r=>setTimeout(r,100));}}
  report.durationMs=Date.now()-started;report.settingsUnchanged=JSON.stringify(before)===JSON.stringify(fingerprints());
  if(!report.settingsUnchanged||!report.hostEnded?.desktopClosed||!report.hostEnded?.workerExited)report.status='failed';
  report.metrics={toolCalls:report.actions.length,failedTools:report.results.filter(r=>!r.success).length,cost:null,costReason:'Configured gateway pricing not supplied.'};save();
 }
 return JSON.parse(redact(JSON.stringify(report)));
}
module.exports={nativeIsolatedModel};
