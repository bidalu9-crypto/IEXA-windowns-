'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTask,readRtf}=require('../scripts/fixtures/desktop-comparison-tasks.cjs');

function fixture(t,kind){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-oracle-'));
 t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'iexa-oracle-'));fs.rmSync(dir,{recursive:true,force:true});});
 const task=createTask(kind,dir),image=path.join(dir,'observed.png');
 // Valid tiny PNG is just a saved-evidence existence fixture. These tests never
 // claim it visually proves a real application task.
 fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=','base64'));
 return{task,image};
}
function observation(id,output,{success=true,completedAt=1000,resultAt=1100}={}){
 return{call:{id,name:'desktop_control',args:{action:'observe'},success,completedAt,resultAt},event:{event:'tool_result',data:{id,success,output}}};
}
function evidence(image,observations){return{calls:observations.map(o=>o.call),events:observations.map(o=>o.event),imageIndex:observations.map(o=>({toolCallId:o.call.id,receivedAt:o.call.resultAt,path:image}))};}
function openedOutput(task,image){
 return{calls:[{id:'reopen',name:'desktop_control',args:{action:'launch',app:'wordpad.exe',arguments:'"'+task.fixture.output+'"'},success:true,completedAt:1000,resultAt:1100}],events:[],imageIndex:[{toolCallId:'reopen',receivedAt:1100,path:image}]};
}
function desktopCall(id,args,time){return{id,name:'desktop_control',args,success:true,completedAt:time,resultAt:time+10};}

test('Calculator current display 12 cannot substitute for a missing history listitem',t=>{
 const {task,image}=fixture(t,'calculator'),o=observation('current-only','e_result | text | 显示为 12 | {}\ne_history | listitem | 2982 - 53 = 2,929 | {}');
 const result=task.verify(evidence(image,[o]));assert.equal(result.checks.secondResultObserved,true);assert.equal(result.checks.bothResultsInHistory,false);
});
test('Calculator narration claiming history is ignored even in successful tool output',t=>{
 const {task,image}=fixture(t,'calculator'),o=observation('narration','模型说历史已有 √(144) 12 和 2929\n{"answer":"历史2929 12","args":{"text":"12"}}');
 const result=task.verify(evidence(image,[o]));assert.equal(result.checks.secondResultObserved,false);assert.equal(result.checks.bothResultsInHistory,false);
});
test('Calculator parses numbered batch postObservation and sqrt listitem without equals',t=>{
 const {task,image}=fixture(t,'calculator');
 const output='batch · 已执行\n1. click_element: '+JSON.stringify({ok:true,data:{postObservation:{elements:[{role:'text',text:'显示为 12'},{role:'text',text:'显示为 2,929'},{role:'listitem',text:'√(144) 12'},{role:'listitem',text:'2982 减 ( 53= 2,929'}]}}});
 const result=task.verify(evidence(image,[observation('batch',output)]));assert.equal(result.status,'passed');
});
test('Calculator uses exact attached full output and records structured controls',t=>{
 const {task,image}=fixture(t,'calculator'),o=observation('attached','batch preview truncated'),full=path.join(path.dirname(image),'full.txt');
 fs.writeFileSync(full,JSON.stringify({ok:true,data:{results:[{result:{postObservation:{elements:[{role:'text',text:'显示为 12'},{role:'text',text:'显示为 2,929'},{role:'listitem',text:'√(144) 12'},{role:'listitem',text:'2982 - 53 = 2,929'}]}}}]}}));
 o.event.data.artifacts=[{kind:'file',mimeType:'text/plain',path:full}];assert.equal(task.verify(evidence(image,[o])).status,'passed');
});

test('RTF bold is restored after nested groups and cannot leak to later characters',()=>{
 const chars=readRtf('{\\rtf1 plain {\\b bold {\\b0 normal} bold} plain}');
 assert.equal(chars.map(c=>c.ch).join(''),'plain bold normal bold plain');
 const spans=[['plain ',false],['bold ',true],['normal',false],[' bold',true],[' plain',false]];
 let offset=0;for(const [text,bold]of spans){assert.deepEqual(chars.slice(offset,offset+text.length),[...text].map(ch=>({ch,bold})));offset+=text.length;}
});

test('RTF skipped metadata and font destinations never contribute title text or bold',()=>{
 const chars=readRtf('{\\rtf1{\\fonttbl{\\f0\\b FakeTitle;}}{\\*\\generator \\b FakeTitle;}RealTitle\\par STATUS DONE}');
 assert.equal(chars.map(c=>c.ch).join(''),'RealTitle\nSTATUS DONE');
 assert.ok(chars.every(c=>!c.bold));
});

test('WordPad oracle rejects a normal title even when unrelated status text is bold',t=>{
 const {task,image}=fixture(t,'wordpad'),{title,marker,output}=task.fixture;
 fs.writeFileSync(output,'{\\rtf1 '+title+'\\par {\\b STATUS '+marker+'}\\par}');
 const result=task.verify(openedOutput(task,image));
 assert.equal(result.checks.firstLineExact,true);assert.equal(result.checks.editedStatus,true);
 assert.equal(result.checks.titleEntirelyBold,false);assert.equal(result.status,'failed');
});

test('WordPad oracle rejects a title with only some characters bold',t=>{
 const {task,image}=fixture(t,'wordpad'),{title,marker,output}=task.fixture;
 fs.writeFileSync(output,'{\\rtf1 {\\b '+title.slice(0,5)+'}'+title.slice(5)+'\\par STATUS '+marker+'\\par}');
 const result=task.verify(openedOutput(task,image));
 assert.equal(result.checks.firstLineExact,true);assert.equal(result.checks.titleEntirelyBold,false);assert.equal(result.status,'failed');
});

test('WordPad oracle accepts exactly preserved text with the full first line bold',t=>{
 const {task,image}=fixture(t,'wordpad'),{title,marker,output}=task.fixture;
 fs.writeFileSync(output,'{\\rtf1{\\fonttbl{\\f0 Arial;}}\\f0 {\\b '+title+'}\\par STATUS '+marker+'\\par}');
 const result=task.verify(openedOutput(task,image));
 assert.equal(result.status,'passed',JSON.stringify(result.checks));
 assert.ok(result.titleRuns.every(c=>c.bold));
});

test('Calculator final answer and tool arguments cannot substitute for observed results',t=>{
 const {task,image}=fixture(t,'calculator');
 const input={calls:[{id:'typed',name:'desktop_control',args:{action:'type',text:'结果2929，平方根12，历史记录2929 12'},success:true,completedAt:1000,resultAt:1100}],events:[],imageIndex:[{toolCallId:'typed',path:image}],answer:'显示为2929，显示为12，历史记录中两项都正确'};
 const result=task.verify(input);
 assert.equal(result.checks.firstResultObserved,false);assert.equal(result.checks.secondResultObserved,false);assert.equal(result.checks.bothResultsInHistory,false);assert.equal(result.status,'failed');
});

test('Calculator rejects failed desktop tool output even when it contains expected values',t=>{
 const {task,image}=fixture(t,'calculator'),o=observation('failed','e1 | text | 显示为 2,929 | {}\ne2 | text | 显示为 12 | {}\n历史记录：2929；12',{success:false});
 const result=task.verify(evidence(image,[o]));
 assert.equal(result.checks.firstResultObserved,false);assert.equal(result.checks.secondResultObserved,false);assert.equal(result.checks.bothResultsInHistory,false);
});

test('Calculator accepts real-shaped Chinese UIA display receipts and explicit calculation history',t=>{
 const {task,image}=fixture(t,'calculator'),first=observation('first','observe · 31 ms · 已执行\n窗口：计算器 (CalculatorApp)\ne_result | text | 显示为 2,929 | {"left":110,"top":200,"width":200,"height":60}');
 const second=observation('second','observe · 29 ms · 已执行\n窗口：计算器 (CalculatorApp)\ne_result | text | 显示为 12 | {"left":110,"top":200,"width":200,"height":60}',{completedAt:2000,resultAt:2100});
 const history=observation('history','observe · 30 ms · 已执行\n窗口：计算器 (CalculatorApp)\ne_history | pane | 历史记录 | {}\ne_old | listitem | (137 + 289) × 7 − 53 = 2,929 | {}\ne_new | listitem | √(144) = 12 | {}',{completedAt:3000,resultAt:3100});
 const result=task.verify(evidence(image,[first,second,history]));
 assert.equal(result.status,'passed',JSON.stringify(result.checks));assert.equal(result.calculations[0].toolCallId,'first');assert.equal(result.calculations[1].toolCallId,'second');assert.equal(result.historyToolCallId,'history');
});

test('Calculator must not parse a clock value 12:00 as numeric result 12',t=>{
 const {task,image}=fixture(t,'calculator'),o=observation('clock','窗口：计算器 (CalculatorApp)\ne_clock | text | 显示为 12:00 | {"left":110,"top":20}\ne_result | text | 显示为 2,929 | {}\n历史记录：结果2929，时间12:00');
 const result=task.verify(evidence(image,[o]));
 assert.equal(result.checks.secondResultObserved,false,'time display is not a completed square-root result');
 assert.equal(result.checks.bothResultsInHistory,false,'history timestamp is not the second calculation');
});

test('Calculator must reject stale result events with no matching current tool call',t=>{
 const {task,image}=fixture(t,'calculator'),current=observation('current','e_result | text | 显示为 0 | {}');
 const input=evidence(image,[current]);input.events.push(observation('previous-run','e_result | text | 显示为 2,929 | {}\ne_other | text | 显示为 12 | {}\n历史记录：2929 12').event);
 const result=task.verify(input);
 assert.equal(result.checks.firstResultObserved,false,'a different operation cannot certify this task');assert.equal(result.checks.secondResultObserved,false);assert.equal(result.checks.bothResultsInHistory,false);
});

test('Calculator must reject a result receipt timestamp preceding its operation dispatch',t=>{
 const {task,image}=fixture(t,'calculator'),o=observation('bad-order','e_result | text | 显示为 2,929 | {}\ne_other | text | 显示为 12 | {}\n历史记录：2929 12',{completedAt:2000,resultAt:1000});
 const result=task.verify(evidence(image,[o]));
 assert.equal(result.checks.firstResultObserved,false,'receipt before dispatch is invalid evidence');assert.equal(result.checks.secondResultObserved,false);assert.equal(result.checks.bothResultsInHistory,false);
});

test('reopen oracle selects the final launch and latest observation rather than an earlier file-not-found frame',t=>{
 const {task,image}=fixture(t,'wordpad'),finalImage=path.join(path.dirname(image),'final.png');fs.copyFileSync(image,finalImage);
 const calls=[desktopCall('early',{action:'launch',arguments:task.fixture.output},1000),desktopCall('error-modal',{action:'observe'},1100),
  desktopCall('final',{action:'launch',arguments:task.fixture.output},2000),desktopCall('actual-document',{action:'observe'},2100),
  desktopCall('close',{action:'hotkey',keys:['ALT','F4'],expectWindowClosed:true},2200),desktopCall('unrelated-after-close',{action:'observe'},2300)];
 const input={calls,events:[{event:'tool_result',data:{id:'early',success:true,output:'找不到文件'}}],imageIndex:[
  {toolCallId:'early',path:image},{toolCallId:'error-modal',path:image},{toolCallId:'final',path:image},
  {toolCallId:'actual-document',path:finalImage},{toolCallId:'unrelated-after-close',path:image}]};
 const result=task.verify(input).lifecycle;
 assert.equal(result.callId,'final');assert.equal(result.imageToolCallId,'actual-document');assert.equal(result.image,finalImage);
 assert.equal(result.candidateCount,2);assert.equal(result.requiresVisualReview,true);assert.match(result.scope,/Dispatch success alone does not prove/);
});

test('reopen oracle prefers a later complete Ctrl+O sequence over an earlier launch',t=>{
 const {task,image}=fixture(t,'wordpad');
 const calls=[desktopCall('early',{action:'launch',arguments:task.fixture.output},1000),
  desktopCall('open',{action:'hotkey',keys:['CTRL','O']},2000),desktopCall('path',{action:'type',text:task.fixture.output},2100),
  desktopCall('enter',{action:'key',key:'ENTER'},2200),desktopCall('view',{action:'frame'},2300)];
 const result=task.verify({calls,events:[],imageIndex:[{toolCallId:'early',path:image},{toolCallId:'enter',path:image},{toolCallId:'view',path:image}]}).lifecycle;
 assert.equal(result.callId,'enter');assert.equal(result.method,'open-dialog');assert.equal(result.imageToolCallId,'view');assert.equal(result.candidateCount,2);
});

test('reopen oracle does not attach a later unrelated Enter to an abandoned open dialog',t=>{
 const {task,image}=fixture(t,'wordpad');
 const calls=[desktopCall('open',{action:'hotkey',keys:['CTRL','O']},1000),desktopCall('typed',{action:'type',text:task.fixture.output},1100),
  desktopCall('replacement-open',{action:'hotkey',keys:['CTRL','O']},1200),desktopCall('unrelated-enter',{action:'key',key:'ENTER'},1300)];
 const result=task.verify({calls,events:[],imageIndex:[{toolCallId:'unrelated-enter',path:image}]}).lifecycle;
 assert.equal(result.reopenedExactPath,false);assert.equal(result.reopenScreenshotSaved,false);assert.equal(result.candidateCount,0);
});
