const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const script=fs.readFileSync(path.join(__dirname,'../src/renderer/services/ToolLifecycleView.js'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8').replace(/\r\n/g,'\n');
function fixture(t){const dom=new JSDOM('<div id="tool"><span class="tool-status"></span></div>',{runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(script);const block=dom.window.document.getElementById('tool');const render=(b,cls,label)=>{b.dataset.status=cls;b.querySelector('.tool-status').textContent=label||cls;};return {view:dom.window.IexaToolLifecycleView,block,render};}
const event=(sequence,status,runId='run-a')=>({version:1,runId,sequence,sessionId:'s',id:'c',name:'t',status,timestamp:1000+sequence});
test('tool UI distinguishes approval, running, cancellation request and terminal',t=>{
 const {view,block,render}=fixture(t);
 for(const [seq,status,text]of [[1,'queued','排队中'],[2,'awaiting_approval','等待批准'],[3,'running','执行中'],[4,'cancelling','正在停止'],[5,'cancelled','已取消']]){
  assert.equal(view.apply(block,event(seq,status),render),true);assert.equal(block.textContent,text);
 }
 assert.equal(block.dataset.executionStatus,'cancelled');
});
test('duplicate, old-sequence, foreign-run and post-terminal events do not regress a card',t=>{
 const {view,block,render}=fixture(t);view.apply(block,event(2,'running'),render);
 for(const e of [event(2,'queued'),event(1,'queued'),event(3,'queued','run-b')])assert.equal(view.apply(block,e,render),false);
 view.apply(block,event(4,'completed'),render);assert.equal(view.apply(block,event(5,'running'),render),false);assert.equal(block.dataset.status,'done');
});
test('history failures, denied and missing results are not rendered as successful',t=>{
 const {view,block,render}=fixture(t);
 for(const [result,expected] of [[undefined,'unknown'],[{success:false},'error'],[{success:false,executionStatus:'denied'},'denied'],[{success:false,executionStatus:'timed_out'},'timed-out']]){
  delete block.dataset.executionStatus;view.applyResult(block,result,render);assert.equal(block.dataset.status,expected);
 }
});
test('legacy success booleans cannot override server cancellation',t=>{
 const {view,block,render}=fixture(t);view.apply(block,event(1,'cancelled'),render);view.applyResult(block,{success:true},render);assert.equal(block.dataset.status,'cancelled');
});
test('unknown or malformed events are ignored without touching DOM',t=>{
 const {view,block,render}=fixture(t);
 for(const e of [null,event(-1,'queued'),{...event(1,'queued'),version:2},event(1,'constructor'),{...event(1,'queued'),runId:1}])assert.equal(view.apply(block,e,render),false);
 assert.equal(block.textContent,'');
});
function stopFixture(fetchImpl){
 const start=appSource.indexOf('async function stopProcessing() {');const end=appSource.indexOf('\n}\n',start)+2;assert.ok(start>=0&&end>start);
 const runtime={};let processingCalls=0;const errors=[];const calls=[];
 const sandbox={protectLiveTurnDom(){},runtimeForSession:()=>runtime,currentSessionId:'s 1',hideWaitingIndicator(){},API_BASE:'',fetch:async(...args)=>{calls.push(args);return fetchImpl(...args);},statusText:{textContent:''},addError:e=>errors.push(e),setProcessing:()=>processingCalls++,finishTaskSummary:()=>assert.fail('cleanup not finished')};
 vm.createContext(sandbox);vm.runInContext(appSource.slice(start,end),sandbox);return {sandbox,runtime,errors,calls,get processingCalls(){return processingCalls;}};
}
test('actual stop button handler POSTs cancellation and waits for terminal SSE',async()=>{
 const f=stopFixture(async()=>({ok:true}));await f.sandbox.stopProcessing();assert.equal(f.calls[0][0],'/api/cancel?sessionId=s%201');assert.equal(f.calls[0][1].method,'POST');assert.equal(f.runtime.turnStopPending,true);assert.equal(f.processingCalls,0);assert.match(f.sandbox.statusText.textContent,/等待执行器/);
});
test('failed stop request clears the pending flag without pretending the run ended',async()=>{
 const f=stopFixture(async()=>({ok:false}));await f.sandbox.stopProcessing();assert.equal(f.runtime.turnStopPending,false);assert.equal(f.processingCalls,0);assert.equal(f.errors.length,1);
});
