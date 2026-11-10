'use strict';
// Fixture creation and read-only result oracles. No application business action
// is performed here; both contestants use the same production desktop controller.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const norm=v=>String(v||'').toLowerCase().replace(/\//g,'\\');
function evidenceParts(evidence={}){
 const state=evidence.modelState||evidence;
 const calls=state.calls||[],events=state.events||[];
 const images=evidence.imageIndex||state.imageIndex||[];
 const results=events.filter(e=>{
  if(e.event!=='tool_result'||e.data?.success!==true)return false;
  const call=calls.find(c=>c.id===e.data.id&&c.name==='desktop_control'&&c.success===true);
  return !!call&&Number.isFinite(call.completedAt)&&Number.isFinite(call.resultAt)&&call.resultAt>=call.completedAt;
 });
 return {calls,events,images,results};
}
function observedControls(output){
 const values=[];
 const collect=value=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(collect);return;}
  if(value.ok===false||value.success===false)return;
  if(typeof value.text==='string'&&(value.role||value.selector?.controlType))values.push({text:value.text,role:String(value.role||value.selector.controlType).toLowerCase()});
  for(const key of ['data','elements','postObservation','focused','focusedBefore','focusedAfter','result','results'])collect(value[key]);
 };
 for(const line of String(output||'').split(/\r?\n/)){
  const match=/^\s*e_\S+\s*\|\s*([a-z]+)\s*\|\s*(.*?)\s*\|/i.exec(line);
  if(match)values.push({role:match[1].toLowerCase(),text:match[2]});
  const jsonLine=line.replace(/^\s*\d+\.\s+[a-z_]+:\s*/i,'').trim();
  if(jsonLine.startsWith('{'))try{collect(JSON.parse(jsonLine));}catch{}
 }
 try{collect(JSON.parse(String(output||'')));}catch{}
 return values.map(v=>({...v,text:v.text.replace(/[\u200e\u200f\u202a-\u202e]/g,'').trim()}));
}
function observedControlTexts(output){return [...new Set(observedControls(output).map(v=>v.text))];}
function observedHistoryTexts(output){return [...new Set(observedControls(output).filter(v=>v.role==='listitem').map(v=>v.text))];}
function resultObservationOutput(event){
 let output=String(event.data?.output||'');const artifacts=[];
 // Only exact artifacts attached to a successful tool receipt; never discover
 // arbitrary paths in model prose, and never execute attachment content.
 for(const a of event.data?.artifacts||[]){
  if(a.kind!=='file'||a.mimeType!=='text/plain'||typeof a.path!=='string'||!fs.existsSync(a.path))continue;
  const size=fs.statSync(a.path).size;if(size<=0||size>2*1024*1024)continue;
  const bytes=fs.readFileSync(a.path);output+='\n'+bytes.toString('utf8');artifacts.push({path:a.path,sha256:sha(bytes),bytes:size});
 }
 return{output,artifacts};
}
function isObservedNumber(text,result,{expression=false}={}){
 const digits=result==='2929'?'2[,，\\s]?929':'12';
 if(expression&&result==='12'&&/^√\s*\(\s*144\s*\)\s+12$/.test(text))return true;
 // Anchor the whole control value. Clock values such as 12:00, decimal 12.5,
 // timestamps and incidental model/tool narration are not calculation results.
 const prefix=expression?'(?:.*(?:=|等于|equals)\\s*)?':'(?:(?:显示为|Display is|结果[：:]?|Result[：:]?)\\s*)?';
 return new RegExp('^'+prefix+digits+'$','i').test(text);
}
function sharedChecks(evidence){
 const {calls,images}=evidenceParts(evidence);
 return {desktopToolsOnly:calls.length>0&&calls.every(c=>c.name==='desktop_control'),screenshotsSaved:images.some(i=>typeof i.path==='string'&&fs.existsSync(i.path))};
}
function reopened(evidence,output){
 const {calls,images}=evidenceParts(evidence),wanted=norm(output),candidates=[];
 const valid=c=>c.success===true&&Number.isFinite(c.completedAt)&&Number.isFinite(c.resultAt)&&c.resultAt>=c.completedAt;
 const hotkey=(c,key)=>c.args?.action==='hotkey'&&(c.args.keys||[]).map(k=>String(k).toUpperCase()).join('+')===key;
 for(let i=0;i<calls.length;i++){
  const c=calls[i];if(!valid(c))continue;
  if(c.args?.action==='launch'&&norm(c.args.arguments).includes(wanted))candidates.push({call:c,index:i,method:'launch'});
  if(!hotkey(c,'CTRL+O'))continue;
  let typed;
  for(let j=i+1;j<calls.length;j++){
   const next=calls[j];
   // A later open sequence cannot supply evidence to an earlier dialog.
   if(next.args?.action==='launch'||hotkey(next,'CTRL+O'))break;
   if(!valid(next))continue;
   if(['type','type_element'].includes(next.args?.action)&&norm(next.args.text)===wanted)typed=next;
   if(typed&&next.completedAt>=typed.resultAt&&next.args?.action==='key'&&String(next.args.key).toUpperCase()==='ENTER'){
    candidates.push({call:next,index:j,method:'open-dialog'});break;
   }
  }
 }
 // Earlier launches may have opened a file-not-found modal. Keep the final
 // attempt and its latest observed frame for direct visual inspection.
 candidates.sort((a,b)=>a.index-b.index);const chosen=candidates.at(-1),openCall=chosen?.call;
 const eligible=[];
 if(chosen)for(let i=chosen.index;i<calls.length;i++){
  const c=calls[i];
  if(i>chosen.index&&(c.args?.action==='launch'||c.args?.expectWindowClosed===true||hotkey(c,'ALT+F4')||hotkey(c,'CTRL+O')))break;
  if(valid(c)&&(i===chosen.index||['observe','frame'].includes(c.args?.action)))eligible.push(c.id);
 }
 let image;
 for(const id of eligible.reverse()){
  image=images.filter(im=>im.toolCallId===id&&typeof im.path==='string'&&fs.existsSync(im.path)).at(-1);if(image)break;
 }
 return {reopenedExactPath:!!openCall,reopenScreenshotSaved:!!image,callId:openCall?.id,image:image?.path,imageToolCallId:image?.toolCallId,
  candidateCount:candidates.length,method:chosen?.method,requiresVisualReview:true,
  scope:'The last successful tool dispatch targets the exact output path. Dispatch success alone does not prove the document opened or its contents; directly inspect this selected screenshot alongside the independent file oracle.'};
}
function finish(checks,detail){return{status:Object.values(checks).every(Boolean)?'passed':'failed',checks,...detail};}
function writeBmp(file){
 const width=200,height=120,stride=(width*3+3)&~3,bytes=Buffer.alloc(54+stride*height),seed=Buffer.from(randomUUID().replace(/-/g,''),'hex');
 bytes.write('BM');bytes.writeUInt32LE(bytes.length,2);bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);bytes.writeInt32LE(width,18);bytes.writeInt32LE(height,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(24,28);bytes.writeUInt32LE(stride*height,34);
 const colors=[[210+seed[0]%35,20+seed[1]%30,20],[20,160+seed[2]%60,30],[20,40,190+seed[3]%50],[220,180+seed[4]%50,20]];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  let color=colors[(y>=45?2:0)+(x>=73?1:0)];
  // Distinct marker pixels prevent symmetric/flipped transformations passing.
  if(x>=9&&x<27&&y>=13&&y<31)color=[255,255,255];
  if(x>=151&&x<181&&y>=86&&y<101)color=[0,0,0];
  const p=54+(height-1-y)*stride+x*3;bytes[p]=color[2];bytes[p+1]=color[1];bytes[p+2]=color[0];
 }
 fs.writeFileSync(file,bytes);return{width,height,sha256:sha(bytes)};
}
// Small RTF reader for independently checking WordPad text and character bold
// state. Group formatting is restored, destinations are skipped, Unicode
// fallback bytes are consumed, and the title is checked character by character.
function readRtf(input){
 const stack=[],chars=[];let s={bold:false,skip:false,uc:1},fallback=0;
 const destinations=new Set(['fonttbl','colortbl','stylesheet','info','pict','object','header','headerl','headerr','footer','footerl','footerr','listtable','listoverridetable','generator','xmlnstbl','datastore','themedata','colorschememapping','fldinst']);
 const put=ch=>{if(fallback){fallback--;return;}if(!s.skip)chars.push({ch,bold:s.bold});};
 for(let i=0;i<input.length;){
  const c=input[i++];if(c==='{'){stack.push({...s});continue;}if(c==='}'){s=stack.pop()||s;continue;}
  if(c==='\r'||c==='\n')continue;
  if(c!=='\\'){put(c);continue;}
  const next=input[i++];if(next==='\\'||next==='{'||next==='}'){put(next);continue;}
  if(next==="'"){const h=input.slice(i,i+2);i+=2;put(String.fromCharCode(parseInt(h,16)));continue;}
  if(next==='*'){s.skip=true;continue;}if(next==='~'){put(' ');continue;}if(next==='_'||next==='-'){put('-');continue;}
  if(!/[a-z]/i.test(next||''))continue;
  let word=next;while(/[a-z]/i.test(input[i]||''))word+=input[i++];
  let number='';if(input[i]==='-')number+=input[i++];while(/[0-9]/.test(input[i]||''))number+=input[i++];if(input[i]===' ')i++;
  const n=number&&number!=='-'?Number(number):undefined;
  if(destinations.has(word)){s.skip=true;continue;}
  if(word==='bin'&&n>=0){i+=n;continue;}
  if(word==='uc'){s.uc=n??1;continue;}
  if(word==='u'){if(!s.skip)chars.push({ch:String.fromCharCode((n??0)&65535),bold:s.bold});fallback=s.uc;continue;}
  if(word==='b'){s.bold=n!==0;continue;}if(word==='plain'){s.bold=false;continue;}
  if(word==='par'||word==='line'){if(!s.skip)chars.push({ch:'\n',bold:s.bold});continue;}if(word==='tab')put('\t');
 }
 return chars;
}
function createTask(kind,out){
 out=path.resolve(out);fs.mkdirSync(out,{recursive:true});const directory=path.join(out,'task-files');fs.mkdirSync(directory,{recursive:true});const token=randomUUID().slice(0,8);
 const common=`全部业务操作只使用 desktop_control，backend=native、controlMode=foreground，必要时显式activate。只操作本轮 ${directory} 和你启动的窗口，不动其他文件、用户设置或会话；不使用shell、脚本、文件写入工具或地址栏执行代码。每个主要阶段读取实际截图，使用当前控件，遇到失效目标重新observe；结果不确定先观察，避免重复提交。最后报告实际结果并关闭你启动的应用窗口。最多60次工具调用、8分钟。`;
 if(kind==='paint'){
  const input=path.join(directory,'source-'+token+'.bmp'),output=path.join(directory,'rotated-'+token+'.png'),original=writeBmp(input);
  return{kind,processNames:['mspaint.exe'],fixture:{directory,input,output,original},goal:`使用 C:\\Windows\\System32\\mspaint.exe 打开 ${input}，通过画图界面将整个图像顺时针旋转90度，保持原始像素、不缩放，另存为 PNG 文件 ${output}。输出应为120×200像素；保留源BMP不变。关闭后重新打开输出图片，观察确认方向和尺寸。已授权启动画图并保存本轮输出。${common}`,verify(evidence){
   let image=null,error;try{if(fs.existsSync(output)){
    const py='import sys,json\nfrom PIL import Image,ImageChops\na=Image.open(sys.argv[1]).convert("RGB")\nb=Image.open(sys.argv[2])\ne=a.transpose(Image.Transpose.ROTATE_270)\nprint(json.dumps({"format":b.format,"size":list(b.size),"exactClockwiseRotation":b.size==e.size and ImageChops.difference(b.convert("RGB"),e).getbbox() is None}))';
    image=JSON.parse(execFileSync('python',['-c',py,input,output],{windowsHide:true,encoding:'utf8',timeout:10000}));
   }}catch(e){error=e.message;}
   const lifecycle=reopened(evidence,output),checks={...sharedChecks(evidence),sourceUnchanged:sha(fs.readFileSync(input))===original.sha256,outputExists:fs.existsSync(output),pngFormat:image?.format==='PNG',dimensions:image?.size?.join('x')==='120x200',allPixelsCorrect:image?.exactClockwiseRotation===true,reopenedExactPath:lifecycle.reopenedExactPath,reopenScreenshotSaved:lifecycle.reopenScreenshotSaved};
   return finish(checks,{image,error,lifecycle,output,sha256:fs.existsSync(output)?sha(fs.readFileSync(output)):null});
  }};
 }
 if(kind==='wordpad'){
  const input=path.join(directory,'source-'+token+'.rtf'),output=path.join(directory,'result-'+token+'.rtf'),title='REFERENCE REF_'+token,marker='DONE_'+token;
  fs.writeFileSync(input,'{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0\\fs24 '+title+'\\par STATUS PENDING\\par}');const originalSHA256=sha(fs.readFileSync(input));
  return{kind,processNames:['wordpad.exe'],fixture:{directory,input,output,title,marker,originalSHA256},goal:`使用 C:\\Program Files\\Windows NT\\Accessories\\wordpad.exe 打开 ${input}。保留第一行 ${title} 的文字并把整行设为粗体，将第二行 STATUS PENDING 改成 STATUS ${marker}。通过写字板界面另存为 ${output}，保留RTF富文本格式且源文件不变。关闭后重新打开输出，核对两行文字及标题粗体。已授权启动写字板和保存本轮输出。${common}`,verify(evidence){
   const exists=fs.existsSync(output),bytes=exists?fs.readFileSync(output):Buffer.alloc(0),raw=bytes.toString('latin1'),chars=readRtf(raw),text=chars.map(c=>c.ch).join(''),start=text.indexOf(title),titleChars=start<0?[]:chars.slice(start,start+title.length),lifecycle=reopened(evidence,output);
   const checks={...sharedChecks(evidence),sourceUnchanged:sha(fs.readFileSync(input))===originalSHA256,outputExists:exists,rtfFormat:/^\{\\rtf/.test(raw),firstLineExact:text.trimStart().split('\n')[0]?.trim()===title,editedStatus:text.includes('STATUS '+marker)&&!text.includes('STATUS PENDING'),titleEntirelyBold:titleChars.length===title.length&&titleChars.filter(c=>c.ch.trim()).every(c=>c.bold),reopenedExactPath:lifecycle.reopenedExactPath,reopenScreenshotSaved:lifecycle.reopenScreenshotSaved};
   return finish(checks,{text,titleRuns:titleChars,lifecycle,output,sha256:exists?sha(bytes):null});
  }};
 }
 if(kind==='calculator'){
  const calculations=[{expression:'(137 + 289) × 7 − 53',result:'2929'},{expression:'144 的平方根',result:'12'}];
  return{kind,processNames:['CalculatorApp.exe','Calculator.exe','calc.exe'],fixture:{directory,calculations},goal:`使用 C:\\Windows\\System32\\calc.exe 启动Windows计算器，通过计算器界面依次计算 (137 + 289) × 7 − 53，以及144的平方根。每次读取显示结果并截图；打开历史记录核对两次计算结果仍在记录中。不要在消息里心算后冒充应用结果。已授权启动计算器，仅在本轮新窗口执行。${common}`,verify(evidence){
   const {results,images}=evidenceParts(evidence);
   const observed=results.map(event=>{const receipt=resultObservationOutput(event);return{event,texts:observedControlTexts(receipt.output),history:observedHistoryTexts(receipt.output),artifacts:receipt.artifacts};});
   const matches=calculations.map(c=>{const observation=observed.find(o=>o.texts.some(text=>isObservedNumber(text,c.result))||o.history.some(text=>isObservedNumber(text,c.result,{expression:true}))),event=observation?.event;return{...c,observed:!!event,toolCallId:event?.data.id,image:images.find(i=>i.toolCallId===event?.data.id)?.path};});
   const history=observed.find(o=>calculations.every(c=>o.history.some(text=>isObservedNumber(text,c.result,{expression:true}))))?.event;
   const checks={...sharedChecks(evidence),firstResultObserved:matches[0].observed,secondResultObserved:matches[1].observed,bothResultsInHistory:!!history};
   return finish(checks,{calculations:matches,historyToolCallId:history?.data.id,historyImage:images.find(i=>i.toolCallId===history?.data.id)?.path,scope:'Matches successful desktop tool observations, never the model final answer; screenshots additionally require direct visual review.'});
  }};
 }
 throw Error('Unknown desktop comparison task: '+kind);
}
module.exports={createTask,readRtf,auditHelpers:{evidenceParts,observedControlTexts,observedHistoryTexts,resultObservationOutput,isObservedNumber,sharedChecks,reopened}};
