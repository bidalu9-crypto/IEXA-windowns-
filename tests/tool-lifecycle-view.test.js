const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const script=fs.readFileSync(path.join(__dirname,'../src/renderer/services/ToolLifecycleView.js'),'utf8');
const appSource=require('./helpers/renderer-bundle').source.replace(/\r\n/g,'\n');
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
test('desktop route badges show actual backends independently from result success',t=>{
 const {view,block,render}=fixture(t);
 const routes=[
  [{mode:'background',backend:'native-isolated',capability:'isolated-semantic'},'后台 · 独立桌面'],
  [{mode:'background',backend:'chromium-cdp',capability:'browser-dom'},'后台 · 浏览器'],
  [{mode:'background',backend:'native',capability:'uia-provider-semantic',providerMayChangeFocus:true},'后台 · 应用控件'],
  [{mode:'foreground',backend:'native',capability:'foreground-input'},'前台 · 鼠标键盘'],
 ];
 for(const [control,label]of routes){
  delete block.dataset.executionStatus;
  view.applyResult(block,{success:false,metadata:{desktop:{control}}},render);
  const badge=block.querySelector('.desktop-control-mode');
  assert.equal(badge.textContent,label);assert.equal(block.dataset.status,'error');
  if(control.mode==='background')assert.match(badge.title,/不回退到物理鼠标键盘/);
  if(control.providerMayChangeFocus)assert.match(badge.title,/应用控件可能自行改变焦点/);
 }
});
test('desktop mode metadata supports history and fallback backend without guessing missing modes',t=>{
 const {view,block,render}=fixture(t);
 view.applyResult(block,{success:true,metadata:{backend:'chromium-cdp',desktop:{control:{mode:'background'}}}},render);
 assert.equal(block.querySelector('.desktop-control-mode').textContent,'后台 · 浏览器');
 view.applyResult(block,{success:false,metadata:{desktop:{control:{backend:'native-isolated'}}}},render);
 assert.equal(block.querySelector('.desktop-control-mode').textContent,'模式未记录 · 独立桌面');
 view.applyResult(block,{success:true},render);
 assert.equal(block.querySelector('.desktop-control-mode'),null,'legacy history has no invented actual control mode');
});
test('desktop metadata is text-safe and live lifecycle events can reveal the actual route',t=>{
 const {view,block,render}=fixture(t);
 const control={mode:'background',backend:'native',capability:'<img src=x onerror=alert(1)>',providerMayChangeFocus:true};
 view.apply(block,{...event(1,'running'),desktop:{control}},render);
 assert.equal(block.querySelector('.desktop-control-mode').textContent,'后台 · 应用控件');
 assert.match(block.querySelector('.desktop-control-mode').title,/<img/);
 assert.equal(block.querySelector('img'),null);assert.equal(block.dataset.status,'running');
 view.apply(block,{...event(2,'failed'),desktop:{control}},render);
 assert.equal(block.dataset.status,'error');assert.equal(block.querySelectorAll('.desktop-control-mode').length,1);
});

async function liveFixture(t,handler){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../src/renderer/desktop-live.html'),'utf8'),{runScripts:'outside-only',url:'http://localhost/',pretendToBeVisual:true});
 const w=dom.window,calls=[];
 w.fetch=async route=>{calls.push(route);return handler(route,calls.length);};
 w.AbortSignal=AbortSignal;w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=()=>{};
 w.setTimeout=()=>0;w.clearTimeout=()=>{};
 w.iexaDesktop={getDesktopLiveWindowState:async()=>({pinned:true})};
 w.eval(fs.readFileSync(path.join(__dirname,'../src/renderer/desktop-live.js'),'utf8'));
 t.after(()=>{w.dispatchEvent(new w.Event('beforeunload'));w.close();});
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 return {w,calls};
}
const liveResponse=(data,options={})=>({ok:options.ok!==false,status:options.status||200,json:async()=>data,clone(){return this;},blob:async()=>new Blob(['frame']),headers:{get:()=>String(Date.now())}});
test('desktop live reads actual mode before the independent frame and does not infer action success',async t=>{
 const f=await liveFixture(t,route=>route.endsWith('/status')?liveResponse({success:false,updatedAt:1,control:{mode:'background',backend:'native',capability:'uia-provider-semantic',providerMayChangeFocus:true}}):liveResponse({}));
 assert.deepEqual(f.calls,['/api/desktop-live/status','/api/desktop-live/frame']);
 assert.equal(f.w.document.querySelector('[data-live-control-mode]').textContent,'后台 · 应用控件');
 assert.match(f.w.document.querySelector('[data-live-control-mode]').title,/可能自行改变焦点/);
 assert.match(f.w.document.querySelector('[data-live-control-route]').textContent,/最近操作未成功/);
 assert.equal(f.w.document.querySelector('[data-live-frame]').hidden,false);
 assert.match(f.w.document.querySelector('[data-live-status]').textContent,/最近观察快照/);
});
test('desktop live still fetches frames when mode status is unavailable',async t=>{
 const f=await liveFixture(t,route=>route.endsWith('/status')?liveResponse({error:'status unavailable'},{ok:false,status:503}):liveResponse({}));
 assert.deepEqual(f.calls,['/api/desktop-live/status','/api/desktop-live/frame']);
 assert.equal(f.w.document.querySelector('[data-live-control-mode]').textContent,'模式未同步');
 assert.equal(f.w.document.querySelector('[data-live-frame]').hidden,false);
});
test('desktop live distinguishes first observation from a stale missing frame',async t=>{
 const f=await liveFixture(t,route=>route.endsWith('/status')?liveResponse({observed:false}):liveResponse({error:'No frame for this operation'},{ok:false,status:404}));
 assert.equal(f.w.document.querySelector('[data-live-control-route]').textContent,'等待首次桌面操作');
 assert.equal(f.w.document.querySelector('[data-live-frame]').hidden,true);
 assert.equal(f.w.document.querySelector('[data-live-frame]').getAttribute('src'),null);
 assert.equal(f.w.document.querySelector('[data-live-placeholder]').textContent,'当前操作暂无可用画面');
});
function stopFixture(fetchImpl){
 const start=appSource.indexOf('async function stopProcessing(options) {');const end=appSource.indexOf('\n}\n',start)+2;assert.ok(start>=0&&end>start);
 const runtime={activeChatTurnToken:1};let processingCalls=0;const errors=[];const calls=[];
 const sandbox={activeChatTurnToken:1,visibleSessionId:'s 1',AbortSignal,flushStreamUpdates(){},recoverStoppedChatTurn(){},withSessionRuntime:(_id,fn)=>fn(),snapshotActiveSessionRuntime(){},syncPausedBanner(){},stopBtn:{setAttribute(){},removeAttribute(){}},handleCancelled(){runtime.turnStopPending=false;processingCalls++;},protectLiveTurnDom(){},runtimeForSession:()=>runtime,currentSessionId:'s 1',hideWaitingIndicator(){},API_BASE:'',fetch:async(...args)=>{calls.push(args);const response=await fetchImpl(...args);return {...response,json:response.json||(async()=>({ok:true}))};},statusText:{textContent:''},addError:e=>errors.push(e),setProcessing:()=>processingCalls++,finishTaskSummary:()=>assert.fail('cleanup not finished'),IexaI18n:{t:key=>({'msg.pausing':'正在暂停…'}[key]||key)}};
 sandbox.setStatusText=(text)=>{sandbox.statusText.textContent=text;};vm.createContext(sandbox);vm.runInContext(appSource.slice(start,end),sandbox);return {sandbox,runtime,errors,calls,get processingCalls(){return processingCalls;}};
}
test('the stop button cancels the executing tool immediately instead of requesting pause',async()=>{
 const f=stopFixture(async()=>({ok:true}));await f.sandbox.stopProcessing();assert.equal(f.calls[0][0],'/api/cancel?sessionId=s%201');assert.equal(f.calls[0][1].method,'POST');assert.equal(f.runtime.pausePending,false);assert.equal(f.runtime.turnStopPending,true);assert.equal(f.processingCalls,0,'the terminal event or authoritative state confirms completion');assert.match(f.sandbox.statusText.textContent,/正在停止/);
});
test('ending a parked turn cancels instead of pausing again',async()=>{
 const f=stopFixture(async()=>({ok:true}));f.runtime.pausedTurn={toolCalls:1};await f.sandbox.stopProcessing();assert.equal(f.calls[0][0],'/api/cancel?sessionId=s%201');assert.equal(f.runtime.turnStopPending,false);assert.equal(f.processingCalls,1);
});
test('an explicit hard stop always cancels',async()=>{
 const f=stopFixture(async()=>({ok:true}));await f.sandbox.stopProcessing({hard:true});assert.equal(f.calls[0][0],'/api/cancel?sessionId=s%201');assert.equal(f.runtime.turnStopPending,true);
});
test('failed stop request clears the pending flag without pretending the run ended',async()=>{
 const f=stopFixture(async()=>({ok:false}));await f.sandbox.stopProcessing();assert.equal(f.runtime.pausePending,false);assert.equal(f.processingCalls,0);assert.equal(f.errors.length,1);
});
