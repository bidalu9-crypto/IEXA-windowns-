const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const browser=process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>fs.existsSync(x));

test('real browser: archive, independent panels, folding, FLIP send and streaming frame probe', {skip:!browser,timeout:60000},async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-browser-'));process.env.IEXA_WORKSPACE=path.join(dir,'workspace');
  const backend=require('../dist/main/server');const server=await backend.startServer(0,false);const port=server.address().port;
  const code=backend.getServerCredentials(server).loginCode;
  const proc=spawn(browser,['--headless=new','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${path.join(dir,'profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let socket;const exited=once(proc,'exit');
  t.after(async()=>{if(socket){try{socket.close();}catch{}}if(proc.exitCode===null)proc.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,1500))]);server.closeAllConnections();await new Promise(r=>server.close(r));try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}});
  const wsUrl=await new Promise((resolve,reject)=>{let log='';const timeout=setTimeout(()=>reject(new Error('browser startup timeout')),12000);proc.stderr.on('data',d=>{log+=d;const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timeout);resolve(m[1]);}});proc.once('error',reject);});
  const endpoint=new URL(wsUrl);const pages=await fetch(`http://${endpoint.host}/json`).then(r=>r.json());
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let sequence=0;const waiting=new Map(),exceptions=[];
  socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails);const entry=waiting.get(msg.id);if(entry){clearTimeout(entry.timer);waiting.delete(msg.id);entry.resolve(msg);}};
  function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('CDP timeout '+method));},8000);waiting.set(id,{resolve,timer});socket.send(JSON.stringify({id,method,params}));});}
  async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.result?.exceptionDetails)throw new Error(JSON.stringify(result.result.exceptionDetails));return result.result?.result?.value;}
  async function wait(expression){for(let i=0;i<80;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI condition timeout: '+expression);}
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/#login=${code}`});
  await wait("typeof SafeMarkdown !== 'undefined' && document.body.dataset.mobileClient === 'desktop'");
  assert.equal(await evaluate('location.hash'),'');
  assert.equal(await evaluate("document.querySelectorAll('script:not([src])').length"),0);
  assert.equal(await evaluate("fetch('/api/appearance').then(r=>r.status)"),200);
  assert.equal(await evaluate("document.cookie.includes('iexa_desktop_session')"),false);
  assert.equal(await evaluate("(()=>{ const el=document.createElement('div');document.body.append(el);window.auditExecuted=false;renderMarkdownContent(el,'<img src=missing onerror=window.auditExecuted=true><script>window.auditExecuted=true</script>');return el.querySelector('[onerror],script')===null; })()"),true);
  await new Promise(r=>setTimeout(r,100));assert.equal(await evaluate('window.auditExecuted'),false);
  assert.deepEqual(exceptions,[],'application boot must not have uncaught JS/CSP script errors');

  await wait("currentSessionId && document.getElementById('leftPanelToggle').getAttribute('aria-expanded') === 'true'");
  const artifact=path.resolve('.iexa-artifacts/plan-20260917');fs.mkdirSync(artifact,{recursive:true});
  const panelState=()=>evaluate("({left:getComputedStyle(document.getElementById('sidebar')).display!=='none',right:getComputedStyle(document.getElementById('filesPanel')).display!=='none'})");
  assert.deepEqual(await panelState(),{left:true,right:true});
  await evaluate("document.getElementById('leftPanelToggle').click()");assert.deepEqual(await panelState(),{left:false,right:true});
  await evaluate("document.getElementById('rightPanelToggle').click()");assert.deepEqual(await panelState(),{left:false,right:false});
  await evaluate("document.getElementById('leftPanelToggle').click()");assert.deepEqual(await panelState(),{left:true,right:false});
  await evaluate("window.__beforeReload=true");
  await cdp('Page.reload');await wait("!window.__beforeReload && typeof currentSessionId !== 'undefined' && currentSessionId && document.getElementById('rightPanelToggle')?.getAttribute('aria-expanded') === 'false'");
  assert.deepEqual(await panelState(),{left:true,right:false});

  const archivedId=await evaluate("currentSessionId");
  assert.equal(await evaluate("setSessionArchived(currentSessionId,true)"),true);
  assert.equal(await evaluate(`document.querySelector('.session-item[data-id="${archivedId}"]')===null`),true);
  await evaluate("showArchiveManager()");await wait("document.querySelector('.archive-manager-row')");
  assert.equal(await evaluate("document.getElementById('archiveManagerDialog').open"),true);
  await evaluate("document.querySelector('.archive-chat-title').click()");
  await wait(`currentSessionId==='${archivedId}' && !document.getElementById('archiveManagerDialog')`);
  assert.equal(await evaluate("sessionsCache.find(s=>s.id===currentSessionId).archived"),true);
  await evaluate("showArchiveManager()");await wait("document.querySelector('.archive-manager-row')");
  await evaluate("document.querySelector('.archive-manager-row').children[1].click()");
  await wait("document.querySelector('.archive-manager-list').textContent.includes('暂无')");
  await evaluate("document.querySelector('.archive-close').click()");
  assert.equal(await evaluate(`!!document.querySelector('.session-item[data-id="${archivedId}"]')`),true);

  // Send through the real composer/renderer without contacting a paid model.
  await evaluate(String.raw`(() => {
    window.__realFetch=window.fetch;window.__sentPayload=null;window.__sendAnimations=[];
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){if(this.classList.contains('message')&&this.classList.contains('user'))window.__sendAnimations.push({frames,options});return animate.call(this,frames,options);};
    window.fetch=async(input,init)=>{
      if(String(input)==='/api/chat'){window.__sentPayload=JSON.parse(init.body);return new Response('event: text\ndata: {"content":"消息已收到。"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}});}
      if(String(input)==='/api/translate') return new Response(JSON.stringify({text:'Translated fixture',direction:'zh-CN|en'}),{headers:{'content-type':'application/json'}});
      return window.__realFetch(input,init);
    };
    document.documentElement.dataset.motion='full';
    chatInput.value='界面回归验证：'+ '中文😀'.repeat(180);chatInput.dispatchEvent(new Event('input',{bubbles:true}));
    sendMessage();
  })()`);
  await wait("window.__sentPayload && window.__sendAnimations.length === 1 && !isProcessing");
  assert.equal(await evaluate("window.__sentPayload.message==='界面回归验证：'+'中文😀'.repeat(180)"),true);
  assert.equal(await evaluate("document.querySelector('.message.user .message-fold-toggle').getAttribute('aria-expanded')"),'false');
  await evaluate("document.querySelector('.message.user .message-fold-toggle').click()");
  assert.equal(await evaluate("document.querySelector('.message.user .user-message-text').textContent===window.__sentPayload.message"),true);
  await evaluate("document.querySelector('.message.user .message-fold-toggle').click()");
  assert.equal(await evaluate("window.__sendAnimations[0].frames[0].transform!==window.__sendAnimations[0].frames[1].transform"),true);
  assert.deepEqual(await evaluate("Array.from(document.querySelector('.message.assistant .assistant-message-actions').querySelectorAll('button')).map(button=>button.dataset.action)"),['translate','copy','retry']);
  assert.equal(await evaluate("formatEstimatedCost(null)"),'未配置价格');
  assert.equal(await evaluate("formatEstimatedCost(0)"),'$0.00');
  assert.equal(await evaluate("formatEstimatedCost(0.00001234)"),'$0.00001234');
  await evaluate("document.querySelector('.message.assistant .assistant-message-action[data-action=translate]').click()");
  await wait("!!document.querySelector('.assistant-translation')");
  assert.equal(await evaluate("document.querySelector('.assistant-translation-content').textContent.trim()"),'Translated fixture');
  await evaluate("document.querySelector('.message.assistant .assistant-message-action[data-action=translate]').click()");
  assert.equal(await evaluate("document.querySelector('.assistant-translation').hidden"),true);
  await evaluate("document.querySelector('.message.assistant .assistant-message-action[data-action=translate]').click()");
  assert.equal(await evaluate("document.querySelector('.assistant-translation').hidden"),false);
  await evaluate("window.fetch=window.__realFetch");

  const metrics=await evaluate(String.raw`new Promise(resolve=>{
    document.querySelectorAll('.error-message').forEach(n=>n.remove());
    currentAssistantMsg=addMessage('assistant','',undefined,{streaming:true});
    const message=currentAssistantMsg;let source='## 流式输出验证\n\n';
    const frames=[],renders=[];let previous=0,count=0;
    function tick(now){
      if(previous)frames.push(now-previous);previous=now;
      if(count%3===0){
        source+='自然出现的文字，保持已有段落和工具记录。Streaming text remains stable. '+(count%12===0?'\n\n':'');
        const start=performance.now();handleTextDelta(source);renders.push(performance.now()-start);
      }
      if(++count<180)requestAnimationFrame(tick);
      else {finalizeAssistantMessage(message);const sorted=[...renders].sort((a,b)=>a-b);const intervals=[...frames].sort((a,b)=>a-b);resolve({frames:frames.length,durationMs:frames.reduce((a,b)=>a+b,0),fps:1000/(frames.reduce((a,b)=>a+b,0)/frames.length),frameP95Ms:intervals[Math.floor(intervals.length*.95)],renderP95Ms:sorted[Math.floor(sorted.length*.95)],renderMaxMs:Math.max(...renders),updates:renders.length,chars:source.length,complete:message._assistantText===source,unhighlightedRuns:message.querySelectorAll('[data-stream-text]').length});}
    }requestAnimationFrame(tick);
  })`);
  assert.equal(metrics.complete,true);assert.equal(metrics.unhighlightedRuns,0);assert.equal(metrics.updates,60);
  fs.writeFileSync(path.join(artifact,'browser-frame-metrics.json'),JSON.stringify(metrics,null,2));
  console.log('BROWSER_FRAME_METRICS '+JSON.stringify(metrics));
  const capture=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  fs.writeFileSync(path.join(artifact,'chat-browser.png'),Buffer.from(capture.result.data,'base64'));
  assert.deepEqual(exceptions,[],'no uncaught errors in new interactions');
  const close=cdp('Browser.close').catch(()=>{});await Promise.race([close,new Promise(r=>setTimeout(r,1000))]);
});
