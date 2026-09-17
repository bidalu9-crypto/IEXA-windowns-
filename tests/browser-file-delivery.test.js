const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const browser=process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>fs.existsSync(x));

test('real browser: edited-file card review, guarded undo, persistence and two themes', {skip:!browser,timeout:60000},async(t)=>{
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

  const artifact=path.resolve('.iexa-artifacts/plan-20260917-ui-review');fs.mkdirSync(artifact,{recursive:true});
  const root=fs.realpathSync.native(process.env.IEXA_WORKSPACE),sid=await evaluate('currentSessionId');
  const {FileTools}=require('../dist/main/tools/ToolExecutors');const tools=new FileTools();
  fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'src','components'));fs.mkdirSync(path.join(root,'src','styles'));
  const first='src/components/ChatPanel.tsx',second='src/styles/chat.css';
  const before=Array.from({length:17},(_,i)=>`const previous${i} = ${i};`).join('\n');
  const after=Array.from({length:29},(_,i)=>`const updated${i} = ${i+1};`).join('\n');
  const cssBefore=Array.from({length:16},(_,i)=>`.old-${i} { padding: ${i}px; }`).join('\n');
  const cssAfter=Array.from({length:21},(_,i)=>`.new-${i} { margin: ${i}px; }`).join('\n');
  fs.writeFileSync(path.join(root,first),before);fs.writeFileSync(path.join(root,second),cssBefore);
  const results=[await tools.writeFile(first,after,root),await tools.writeFile(second,cssAfter,root)];assert.ok(results.every(r=>r.success));
  const turnId='fixture-file-turn';
  const messages=[{role:'user',content:'请优化聊天区域，并统一相关样式。',timestamp:Date.now()},{role:'assistant',content:'已更新聊天组件和样式。你可以在下方审查本轮修改。',timestamp:Date.now(),transcript:{version:1,turnId,revision:1,status:'completed',valid:true,items:[]},toolCalls:results.map((result,i)=>({id:`tool-${i}`,name:'file_write',args:{path:i?second:first},result}))}];
  const history=path.join(root,'.iexa-sessions',`${sid}.json`);fs.writeFileSync(history,JSON.stringify(messages));
  await evaluate(`reloadSessionView(${JSON.stringify(sid)})`);await wait("document.querySelectorAll('.turn-change-file').length===2");
  assert.equal(await evaluate("document.querySelector('.turn-deliverables-heading strong').textContent"),'已编辑 2 个文件');
  assert.equal(await evaluate("document.querySelector('.turn-deliverables-heading .diff-add').textContent"),'+50');
  assert.equal(await evaluate("document.querySelector('.turn-deliverables-heading .diff-del').textContent"),'−33');
  assert.equal(await evaluate("document.querySelector('.turn-change-undo').disabled"),false);
  // Keep task execution details collapsed, and show the summary exactly as the user sees it.
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.querySelector('.turn-deliverables').scrollIntoView({block:'center'})`);
    await new Promise(r=>setTimeout(r,150));
    const image=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifact,`file-summary-${theme}.png`),Buffer.from(image.result.data,'base64'));
    assert.equal(await evaluate("(()=>{const r=document.querySelector('.turn-deliverables').getBoundingClientRect();return r.width>250&&r.right<=innerWidth&&r.height<270;})()"),true);
  }
  await evaluate("document.querySelector('.turn-change-review').click()");
  assert.equal(await evaluate("document.querySelector('.turn-change-details').hidden"),false);
  assert.equal(await evaluate("document.querySelector('.turn-change-details').textContent.includes('updated28')"),true);
  assert.equal(await evaluate("document.querySelectorAll('.turn-change-details .diff-added').length"),50);
  const image=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifact,'file-review-dark.png'),Buffer.from(image.result.data,'base64'));
  await evaluate("document.querySelector('.turn-change-review').click();document.querySelector('.turn-change-undo').click()");
  await wait("!!document.querySelector('dialog[open]')");await evaluate("document.querySelector('dialog .btn-primary').click()");
  await wait("document.querySelector('.turn-change-undo').textContent==='已撤销'");
  assert.equal(fs.readFileSync(path.join(root,first),'utf8'),before);assert.equal(fs.readFileSync(path.join(root,second),'utf8'),cssBefore);
  await evaluate(`reloadSessionView(${JSON.stringify(sid)})`);assert.equal(await evaluate("document.querySelector('.turn-change-undo').textContent"),'已撤销');
  // Idempotent replay cannot revert a subsequent user change.
  fs.writeFileSync(path.join(root,first),'USER EDIT AFTER UNDO');
  const replay=await evaluate(`fetch('/api/sessions/${sid}/turns/${turnId}/undo',{method:'POST'}).then(async r=>({status:r.status,data:await r.json()}))`);assert.equal(replay.status,200);assert.equal(fs.readFileSync(path.join(root,first),'utf8'),'USER EDIT AFTER UNDO');
  // Server ignores a forged turn and any client-supplied path/snapshot payload.
  const forged=await evaluate(`fetch('/api/sessions/${sid}/turns/forged/undo',{method:'POST',body:JSON.stringify({path:'${first}',before:'attacker'})}).then(r=>r.status)`);assert.equal(forged,404);
  // Conflict is visible, leaves both files intact, and offers another attempt after inspection.
  const next=await tools.writeFile(first,'AI NEXT',root);const nextMessages=[{...messages[1],transcript:{...messages[1].transcript,turnId:'conflict-turn'},toolCalls:[{id:'conflict-tool',name:'file_write',args:{path:first},result:next}]}];fs.writeFileSync(history,JSON.stringify(nextMessages));fs.writeFileSync(path.join(root,first),'LATER USER EDIT');
  await evaluate(`reloadSessionView(${JSON.stringify(sid)})`);await evaluate("document.querySelector('.turn-change-undo').click()");await wait("!!document.querySelector('dialog[open]')");await evaluate("document.querySelector('dialog .btn-primary').click()");
  await wait("document.querySelector('.turn-change-status').textContent.includes('后续修改')");assert.equal(fs.readFileSync(path.join(root,first),'utf8'),'LATER USER EDIT');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.deepEqual(exceptions,[]);await cdp('Browser.close').catch(()=>{});
});
