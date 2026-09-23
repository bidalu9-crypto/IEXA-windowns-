// End-to-end AgentRuntime -> AgentLoop -> ToolRuntime -> DesktopAgent -> real Notepad.
// Uses a scripted fixture provider (not a model-autonomy score) and an owned native-isolated desktop.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const {AgentRuntime}=require('../dist/main/runtime/AgentRuntime');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts','native-isolated-runtime',`${Date.now()}-${randomUUID().slice(0,8)}`);
const workspaceDir=path.join(root,'workspace'),document=path.join(out,'owned-note.txt');
const reference=`IEXA AgentRuntime ${randomUUID()}`;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={scope:'real Win32 Notepad control through production AgentRuntime stack; scripted fixture provider, NOT LLM autonomy',reference,actions:[],results:[],states:[]};
const children=[];let runtime,host,monitor;
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
function focusEvents(){try{return fs.readFileSync(path.join(out,'focus-events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
function launch(exe,args){const p=spawn(exe,args,{windowsHide:true,stdio:'ignore'});children.push(p);return p;}
async function waitFor(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(fs.existsSync(path.join(out,'isolated-error.json')))throw Error(fs.readFileSync(path.join(out,'isolated-error.json'),'utf8'));await wait(100);}throw Error(label);}
function latestToolResult(messages){return messages.flatMap(message=>message.parts||[]).filter(part=>part.type==='toolResult').at(-1);}
function parseElements(output){return output.split(/\r?\n/).map(line=>{const match=line.match(/^([^\s|]+)\s*\|\s*([^|]+)\|\s*(.*?)\s*\|/);return match?{id:match[1],role:match[2].trim(),text:match[3].trim(),line}:null;}).filter(Boolean);}
function fixtureProvider(){let request=0;const tool=(id,args)=>({type:'toolCallComplete',id,name:'desktop_control',args:{tool_title:args.action,...args}});return {name:'fixture-desktop-e2e',model:'fixture-desktop-e2e',defaultMaxTokens:2048,async *streamMessage(messages){
 request++;report.providerRequests=request;
 if(request===1){yield tool('step-launch',{action:'launch',backend:'native-isolated',background:true,app:'notepad',arguments:`"${document}"`});yield {type:'done',stopReason:'toolUse'};return;}
 if(request===2){yield tool('step-observe-editor',{action:'observe',backend:'native-isolated',background:true,includeElements:true,captureFrame:true});yield {type:'done',stopReason:'toolUse'};return;}
 const prior=latestToolResult(messages);assert.ok(prior,`fixture provider expected previous tool result at request ${request}`);
 if(request===3){const editor=parseElements(prior.content).filter(e=>['edit','document'].includes(e.role));assert.equal(editor.length,1,`unique real editor missing from observation:\n${prior.content}`);yield tool('step-type',{action:'type_element',backend:'native-isolated',background:true,elementId:editor[0].id,text:reference,replace:true,verifyText:reference});yield {type:'done',stopReason:'toolUse'};return;}
 if(request===4){yield tool('step-observe-save',{action:'observe',backend:'native-isolated',background:true,includeElements:true});yield {type:'done',stopReason:'toolUse'};return;}
 if(request===5){const saves=parseElements(prior.content).filter(e=>e.role==='menucommand'&&/(?:> Save$|> 保存(?:\(|$))/.test(e.text)&&!/(?:Save As|另存)/i.test(e.text));assert.equal(saves.length,1,`unique real Save command missing:\n${prior.content}`);yield tool('step-save',{action:'click_element',backend:'native-isolated',background:true,elementId:saves[0].id});yield {type:'done',stopReason:'toolUse'};return;}
 if(request===6){yield tool('step-final-observe',{action:'observe',backend:'native-isolated',background:true,includeElements:true});yield {type:'done',stopReason:'toolUse'};return;}
 const last=latestToolResult(messages);assert.ok(last?.content.includes(reference),'final independent UIA observation must contain the exact reference');
 yield {type:'textDelta',text:'已在隔离 Notepad 中编辑并保存；最终界面读回包含目标文本。'};yield {type:'done',stopReason:'endTurn'};
 }};}
async function main(){
 fs.mkdirSync(out,{recursive:true});fs.mkdirSync(workspaceDir,{recursive:true});fs.writeFileSync(document,'IEXA baseline');save();
 monitor=launch('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(__dirname,'fixtures/foreground-audit.ps1'),'-OutputDirectory',out]);
 report.focusInitial=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(path.join(out,'focus-ready.json'),'utf8'));}catch{return null;}},'Foreground monitor readiness');
 const config={sessionId:`runtime-e2e-${randomUUID()}`,workspaceDir,memoryDir:path.join(out,'memory'),auditDir:path.join(out,'audit'),memoryEnabled:false,permissionMode:'full',contextWindow:128000,provider:fixtureProvider()};
 runtime=new AgentRuntime(config);await runtime.initialize();
 const callbacks={onTextDelta:(_delta,full)=>report.answer=full,onThinkingDelta:()=>{},onToolCallStart:()=>{},onToolInputDelta:()=>{},onToolCallComplete:(id,name,args)=>{report.actions.push({id,name,args});save();},onToolResult:(id,result)=>{report.results.push({id,success:result.success,output:result.output,desktop:result.metadata?.desktop});save();},onUsage:usage=>{report.usages=(report.usages||[]).concat(usage);},onContext:()=>{},onError:error=>{report.error=error;},onDone:reason=>report.stopReason=reason,onCancelled:()=>{report.cancelled=true;},onToolState:event=>report.states.push(event)};
 await runtime.run({message:`Use the desktop UI in a separate isolated workspace: open the supplied file in Notepad, replace its full contents with exactly "${reference}", save it, then independently inspect the current UI before finishing.`,tools:runtime.toolDefinitions().filter(t=>t.name==='desktop_control'),callbacks});
 report.diskText=fs.readFileSync(document,'utf8').replace(/^\uFEFF/,'');report.businessVerified=report.diskText===reference;
 report.host=runtime.tools.desktop.isolatedWorkspace?.diagnostics();runtime.tools.desktop.close();
 if(report.host?.directory)report.hostEnded=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(path.join(report.host.directory,'ended.json'),'utf8'));}catch{return null;}},'Owned desktop shutdown');
 fs.writeFileSync(path.join(out,'stop-monitor'),'');report.focusFinal=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(path.join(out,'focus-ended.json'),'utf8'));}catch{return null;}},'Foreground monitor shutdown');report.focusEvents=focusEvents();
 assert.equal(report.businessVerified,true,'Independent disk bytes do not match');assert.equal(report.hostEnded?.desktopClosed,true);assert.equal(report.hostEnded?.workerExited,true);assert.deepEqual(report.focusEvents,[]);assert.equal(report.focusInitial.foreground,report.focusFinal.foreground);
 assert.equal(report.error,undefined);assert.equal(report.cancelled,undefined);report.status='passed';
}
main().catch(error=>{report.status='failed';report.error=error.stack;process.exitCode=1;}).finally(async()=>{
 runtime?.tools?.desktop?.close();if(report.host?.directory)for(let i=0;i<60;i++){try{report.hostEnded=JSON.parse(fs.readFileSync(path.join(report.host.directory,'ended.json'),'utf8'));break;}catch{await wait(100);}}
 try{fs.writeFileSync(path.join(out,'stop-monitor'),'');}catch{}await wait(150);report.focusEvents=focusEvents();report.focusFinal=report.focusFinal||(()=>{try{return JSON.parse(fs.readFileSync(path.join(out,'focus-ended.json'),'utf8'));}catch{return null;}})();save();
 for(const child of children){if(child.exitCode===null&&child.signalCode===null)try{child.kill();}catch{}}
 console.log(JSON.stringify({out,status:report.status,businessVerified:report.businessVerified,providerRequests:report.providerRequests,focusEvents:report.focusEvents,hostEnded:report.hostEnded,error:report.error},null,2));
});
