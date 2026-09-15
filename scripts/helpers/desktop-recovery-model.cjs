// Optional paid-model gate. The model receives a goal and scoped connection only;
// it chooses every action and reads the real crash-recovery warning from production tools.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {AgentLoop}=require('../../dist/main/agent/AgentLoop');
const {ToolRuntime}=require('../../dist/main/runtime/ToolRuntime');
const {BudgetManager}=require('../../dist/main/runtime/BudgetManager');
const {ProviderFactory}=require('../../dist/main/providers/ProviderFactory');
const {selectedProfile}=require('./selected-model-profile.cjs');
const {assessModelEvidence}=require('./autonomous-evidence.cjs');
async function checkRecoveryModel({root,out,endpoint,targetId,owner,reference}) {
 const settings=path.join(root,'workspace/.iexa-settings.json');
 const fingerprint=()=>Object.fromEntries(['','.bak','.vault'].map(s=>[s,fs.existsSync(settings+s)?createHash('sha256').update(fs.readFileSync(settings+s)).digest('hex'):null]));
 const before=fingerprint(),profile=selectedProfile(settings);
 const redact=s=>String(s).split(profile.apiKey).join('[REDACTED]');
 const report={status:'running',scope:'real configured model continuation after controller crash',model:{provider:profile.provider,model:profile.model,apiMode:profile.apiMode},actions:[],results:[],states:[],usages:[],prewrittenActionsProvided:false,oracleExposedToModel:false};
 const file=path.join(out,'model-recovery-report.json');
 const save=()=>fs.writeFileSync(file,redact(JSON.stringify(report,null,2)));
 const workspace=path.join(out,'model-workspace');fs.mkdirSync(workspace,{recursive:true});
 const controller=new AbortController();let timer,runtime;const start=Date.now();
 try {
  runtime=new ToolRuntime({workspaceDir:workspace,memoryDir:path.join(workspace,'memory'),memoryEnabled:false,auditDir:out,permissionMode:'risk',desktopCaptureFrames:false,budget:new BudgetManager({maxTurns:10,maxToolCalls:16,maxRuntimeMs:120000,maxInputTokens:100000}),permissionResolver:async request=>request.tool.name==='desktop_control'?'allow_once':'deny'});
  runtime.registerDefaults();runtime.beginRun(['desktop_control']);
  const desktop=runtime.registry.get('desktop_control'),execute=desktop.execute;let connected=false;
  desktop.execute=async(args,ctx)=>{
   for(const candidate of [args,...(args.action==='batch'&&Array.isArray(args.actions)?args.actions:[])]){
    if(candidate.backend!==undefined&&candidate.backend!=='chromium-cdp'||candidate.cdpEndpoint!==undefined&&candidate.cdpEndpoint!==endpoint||candidate.cdpTargetId!==undefined&&candidate.cdpTargetId!==targetId)
     return {success:false,output:'Recovery test boundary: only the supplied Chromium endpoint and page are available.'};
    if(['launch','activate','minimize','move','drag','key','hotkey','scroll','read_focused'].includes(candidate.action)||candidate.autoActivate===true||candidate.forcePointer===true)
     return {success:false,output:'Recovery test boundary: background semantic operations only.'};
    if(['click','click_element','type','type_element'].includes(candidate.action)&&candidate.background!==true&&args.background!==true)
     return {success:false,output:'Background semantic input requires background:true.'};
   }
   if(!connected&&(!args.cdpEndpoint||args.backend!=='chromium-cdp'))return {success:false,output:'Use supplied backend and endpoint; native desktop is outside this test.'};
   connected=true;return execute(args,ctx);
  };
  const provider=ProviderFactory.create({type:profile.provider,name:profile.provider,model:profile.model,apiKey:profile.apiKey,baseURL:profile.baseURL,apiMode:profile.apiMode,thinkingLevel:profile.thinkingLevel});
  const loop=new AgentLoop({sessionId:owner,provider,toolRuntime:runtime,workspaceDir:workspace,memoryDir:path.join(workspace,'memory'),memoryEnabled:false,hasProject:false,maxTokens:4096,contextWindow:profile.contextWindow||128000,getAbortSignal:()=>controller.signal});
  await loop.initialize();
  report.goal=`继续完成登记 ${reference}。上次执行进程意外退出，请自行检查当前状态并核对实际完成结果；如果先前已经完成，不要重复提交。全程后台操作，不抢占前台。连接 backend=chromium-cdp，cdpEndpoint=${endpoint}，cdpTargetId=${targetId}。只使用 desktop_control，输入必须 background:true。`;
  save();timer=setTimeout(()=>{report.deadlineExceeded=true;controller.abort();},120000);
  await loop.run(report.goal,runtime.definitions().filter(t=>t.name==='desktop_control'),{
   onTextDelta:(_delta,full)=>{report.answer=redact(full);},onThinkingDelta:()=>{},onToolCallStart:()=>{},onToolInputDelta:()=>{},
   onToolCallComplete:(id,name,args)=>{report.actions.push({id,name,args});save();},
   onToolResult:(id,result)=>{report.results.push({id,success:result.success,output:redact(result.output),desktop:result.metadata?.desktop,executionStatus:result.executionStatus});save();},
   onUsage:usage=>{report.usages.push(usage);save();},onContext:()=>{},onToolState:state=>{report.states.push(state);},
   onError:error=>{report.error=redact(error);},onDone:reason=>{report.stopReason=reason;},onCancelled:()=>{report.cancelled=true;},
  });
  report.evidence=assessModelEvidence(report,'Submitted '+reference);
  report.recoveryWarningReceived=report.results.some(r=>r.success&&r.desktop?.recovered?.unresolvedOperations?.some(op=>op.operationId==='crash-submit')&&r.output.includes('恢复警告'));
  report.status=report.evidence.length&&report.recoveryWarningReceived&&!report.error&&!report.cancelled?'passed':'failed';
 }catch(e){report.error=redact(e.message);report.status='failed';}
 finally {
  clearTimeout(timer);controller.abort();runtime?.desktop?.close();
  report.durationMs=Date.now()-start;report.settingsUnchanged=JSON.stringify(before)===JSON.stringify(fingerprint());
  if(!report.settingsUnchanged)report.status='failed';
  report.metrics={toolCalls:report.actions.length,failedTools:report.results.filter(r=>!r.success).length,cost:null,costReason:'Configured gateway pricing was not supplied.'};save();
 }
 return JSON.parse(redact(JSON.stringify(report)));
}
module.exports={checkRecoveryModel};
