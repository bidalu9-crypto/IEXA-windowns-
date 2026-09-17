const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const browser=process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>fs.existsSync(x));

test('real browser: pending history, parallel streams and navigation keep session DOM isolated', {skip:!browser,timeout:60000},async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-browser-'));process.env.IEXA_WORKSPACE=path.join(dir,'workspace');
  const backend=require('../dist/main/server');const server=await backend.startServer(0,false);const port=server.address().port;
  const code=backend.getServerCredentials(server).loginCode;
  const proc=spawn(browser,['--headless=new','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${path.join(dir,'profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let socket;const exited=once(proc,'exit');
  t.after(async()=>{if(socket){try{socket.close();}catch{}}if(proc.exitCode===null)proc.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,1500))]);server.closeAllConnections();await new Promise(r=>server.close(r));try{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('iexa-browser-'));fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}});
  const wsUrl=await new Promise((resolve,reject)=>{let log='';const timeout=setTimeout(()=>reject(new Error('browser startup timeout')),12000);proc.stderr.on('data',d=>{log+=d;const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timeout);resolve(m[1]);}});proc.once('error',reject);});
  const endpoint=new URL(wsUrl);const pages=await fetch(`http://${endpoint.host}/json`).then(r=>r.json());
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let sequence=0;const waiting=new Map(),exceptions=[];
  socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails);const entry=waiting.get(msg.id);if(entry){clearTimeout(entry.timer);waiting.delete(msg.id);entry.resolve(msg);}};
  function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('CDP timeout '+method));},8000);waiting.set(id,{resolve,timer});socket.send(JSON.stringify({id,method,params}));});}
  async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.result?.exceptionDetails)throw new Error(JSON.stringify(result.result.exceptionDetails));return result.result?.result?.value;}
  async function wait(expression){for(let i=0;i<80;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI condition timeout: '+expression);}
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1175,height:839,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/#login=${code}`});
  await wait("typeof SafeMarkdown !== 'undefined' && document.body.dataset.mobileClient === 'desktop'");

  await wait("currentSessionId && document.getElementById('shellAddProject')");

  await evaluate(`window.__realFetch=window.fetch; window.__pendingHistory=[]; window.__fixtureMessages={A:'Alpha history',B:'Beta history',C:'Gamma history'};
    window.fetch=(url,opts)=>{
      const id=String(url).split('/').pop();
      if(!opts && window.__fixtureMessages[id])return new Promise((resolve,reject)=>window.__pendingHistory.push({id,resolve:()=>resolve({ok:true,json:async()=>({messages:[{role:'user',content:window.__fixtureMessages[id]}]})}),reject}));
      return window.__realFetch(url,opts);
    };`);
  await evaluate("void switchSession('A',false)");
  await evaluate("__pendingHistory.shift().resolve()");
  await wait("visibleChatMessages.textContent.includes('Alpha history')");
  await evaluate("void switchSession('B',false)");
  await evaluate("void switchSession('A',false)");
  await evaluate("void switchSession('B',false)");
  assert.equal(await evaluate("__pendingHistory.filter(x=>x.id==='B').length"),2,'returning to pending history must fetch, not mount an empty cache');
  await evaluate("__pendingHistory.pop().resolve()");
  await wait("visibleChatMessages.textContent.includes('Beta history')");
  await evaluate("__pendingHistory.shift().resolve()");
  assert.equal(await evaluate("visibleChatMessages.querySelectorAll('.message').length"),1);
  // Stale errors must not wipe another selected conversation.
  await evaluate("void switchSession('C',false);void switchSession('A',false);__pendingHistory.shift().reject(new Error('fixture delayed history failure'))");
  await wait("visibleChatMessages.textContent.includes('Alpha history')");
  // A visible failed history has a working retry instead of a permanently blank cache.
  await evaluate("void switchSession('C',false);__pendingHistory.shift().reject(new Error('fixture active history failure'))");
  await wait("visibleChatMessages.textContent.includes('点击重试')");
  await evaluate("visibleChatMessages.querySelector('button').click();__pendingHistory.shift().resolve()");
  await wait("visibleChatMessages.textContent.includes('Gamma history')");
  // Failed creation must not invalidate a history load already in flight.
  await evaluate("__fixtureMessages.D='Delta history';void switchSession('D',false);(()=>{const previous=window.fetch;window.fetch=(url,opts)=>opts?.method==='POST'?Promise.reject(new Error('fixture create failure')):previous(url,opts);void createSession();window.fetch=previous;})();__pendingHistory.shift().resolve()");
  await wait("visibleChatMessages.textContent.includes('Delta history')");
  await evaluate("void switchSession('A',false)");
  await evaluate("withSessionRuntime('B',()=>{withSessionRuntime('A',()=>addMessage('assistant','A nested visible'));addMessage('assistant','B nested background')})");
  assert.equal(await evaluate("visibleChatMessages.textContent.includes('A nested visible')"),true);
  assert.equal(await evaluate("visibleChatMessages.textContent.includes('B nested background')"),false);
  // Two independent stream runtimes, nested background callbacks, and one ending first.
  await evaluate(`withSessionRuntime('A',()=>{setProcessing(true);currentAssistantMsg=addMessage('assistant','A streaming');snapshotActiveSessionRuntime()});
    withSessionRuntime('B',()=>{setProcessing(true);currentAssistantMsg=addMessage('assistant','B streaming');snapshotActiveSessionRuntime()});`);
  for(let i=0;i<12;i++){
    await evaluate(`withSessionRuntime('B',()=>{withSessionRuntime('C',()=>{clearChat();addMessage('assistant','C background')});addMessage('assistant','B delta ${i}')});void switchSession('${i%2?'A':'B'}',false)`);
    assert.equal(await evaluate("visibleChatMessages.textContent.includes(visibleSessionId==='A'?'Beta history':'Alpha history')"),false);
    assert.equal(await evaluate("visibleChatMessages.querySelectorAll('.message').length>0"),true);
  }
  await evaluate("withSessionRuntime('B',()=>setProcessing(false));void switchSession('B',false)");
  assert.equal(await evaluate("visibleChatMessages.textContent.includes('B delta 11')"),true);
  assert.equal(await evaluate("visibleChatMessages.textContent.includes('C background')"),false);
  await evaluate("void switchSession('A',false)");
  assert.equal(await evaluate('isProcessing'),true);
  // A pending create must neither detach the current DOM nor steal a later selection.
  await evaluate(`window.fetch=(url,opts)=>String(url).endsWith('/api/sessions')&&opts?.method==='POST'?new Promise(resolve=>window.__resolveCreate=()=>resolve({json:async()=>({session:{id:'NEW'}})})):window.__realFetch(url,opts);void createSession()`);
  assert.equal(await evaluate("visibleChatMessages.textContent.includes('Alpha history')"),true);
  await evaluate("void switchSession('B',false);__resolveCreate()");
  await new Promise(r=>setTimeout(r,100));
  assert.equal(await evaluate('visibleSessionId'),'B');

  // Exercise the actual fetch/readable-stream -> SSE parser -> batched render path in parallel.
  await evaluate(String.raw`window.__streams={};window.__serverSessions=[...sessionsCache,...['A','B','C'].map(id=>({id,title:id,updated:1,messageCount:1}))];window.fetch=(url,opts)=>String(url).endsWith('/api/sessions')&&(!opts?.method||opts.method==='GET')?Promise.resolve({ok:true,json:async()=>({sessions:__serverSessions})}):String(url).endsWith('/api/chat')?Promise.resolve(new Response(new ReadableStream({start(controller){window.__streams[JSON.parse(opts.body).sessionId]=controller;}}),{status:200,headers:{'Content-Type':'text/event-stream'}})):window.__realFetch(url,opts);
    window.__emit=(id,event,data)=>__streams[id].enqueue(new TextEncoder().encode('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n'));
    withSessionRuntime('A',()=>setProcessing(false));void switchSession('A',false);void runChatTurn('stream A','stream A',[]);`);
  await wait("!!__streams.A && !!sessionRuntimes.get('A').currentAssistantMsg");
  await evaluate("void switchSession('B',false);void runChatTurn('stream B','stream B',[])");
  await wait("!!__streams.B && !!sessionRuntimes.get('B').currentAssistantMsg");
  await evaluate("__emit('A','turn_started',{transcriptTurnId:'turn-A'});__emit('B','turn_started',{transcriptTurnId:'turn-B'})");
  for(let i=0;i<16;i++){
    await evaluate(`__emit('A','text_delta',{content:'Alpha-${i} '});__emit('B','text_delta',{content:'Beta-${i} '});void switchSession('${i%2?'A':'B'}',false)`);
    await new Promise(r=>setTimeout(r,20));
    assert.equal(await evaluate("visibleChatMessages.textContent.includes(visibleSessionId==='A'?'Beta-':'Alpha-')"),false);
  }
  await evaluate("__emit('B','done',{stopReason:'endTurn'});__streams.B.close()");
  await wait("!sessionRuntimes.get('B').isProcessing");
  assert.equal(await evaluate("sessionRuntimes.get('A').isProcessing"),true);
  await evaluate("void switchSession('B',false)");await wait("visibleChatMessages.textContent.includes('Beta-15')");
  await evaluate("__emit('A','text_delta',{content:'Alpha-final'});__emit('A','done',{stopReason:'endTurn'});__streams.A.close()");
  await wait("!sessionRuntimes.get('A').isProcessing");
  await evaluate("void switchSession('A',false)");await wait("visibleChatMessages.textContent.includes('Alpha-final')");
  assert.equal(await evaluate("visibleChatMessages.textContent.includes('Beta-')"),false);
  const artifact=path.resolve('.iexa-artifacts/plan-20260917-ui-review');fs.mkdirSync(artifact,{recursive:true});
  const screenshot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifact,'parallel-conversations.png'),Buffer.from(screenshot.result.data,'base64'));
  assert.deepEqual(exceptions,[]);
  await cdp('Browser.close').catch(()=>{});
});
