const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const browser=process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>fs.existsSync(x));

test('real browser: independent accessibility font/icon scales, persistence, bounds and reset', {skip:!browser,timeout:60000},async(t)=>{
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

 const artifact=path.resolve('.iexa-artifacts/window-chrome-review-20260917');fs.mkdirSync(artifact,{recursive:true});
 await evaluate("document.querySelector('[data-view=appearance]').click()");
 const metrics=()=>evaluate("(()=>{const nav=document.querySelector('.nav-btn'),svg=nav.querySelector('svg');return {font:parseFloat(getComputedStyle(nav).fontSize),icon:svg.getBoundingClientRect().width}})()");
 const original=await metrics();
 async function slide(id,value){await evaluate(`(()=>{const s=document.getElementById('${id}');s.value='${value}';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
 await slide('uiFontScale',130);let m=await metrics();assert.ok(Math.abs(m.font-original.font*1.3)<.1);assert.equal(m.icon,original.icon);
 await slide('uiIconScale',150);m=await metrics();assert.ok(Math.abs(m.font-original.font*1.3)<.1);assert.ok(Math.abs(m.icon-original.icon*1.5)<.1);
 await wait("document.getElementById('uiIconScaleValue').textContent==='150%'");await new Promise(r=>setTimeout(r,300));
 const saved=await evaluate("fetch('/api/appearance').then(r=>r.json())");assert.equal(saved.fontScale,130);assert.equal(saved.iconScale,150);const disk=JSON.parse(fs.readFileSync(path.join(process.env.IEXA_WORKSPACE,'.iexa-appearance.json'),'utf8'));assert.equal(disk.fontScale,130);assert.equal(disk.iconScale,150);
 const reloaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.removeEventListener('message',onMessage);reject(new Error('reload timeout'));},8000);const onMessage=event=>{if(JSON.parse(event.data).method==='Page.loadEventFired'){clearTimeout(timer);socket.removeEventListener('message',onMessage);resolve();}};socket.addEventListener('message',onMessage);});
 await cdp('Page.reload');await reloaded;await wait("document.documentElement.dataset.fontScale==='130' && document.documentElement.dataset.iconScale==='150' && document.querySelector('[data-view=appearance]')");
 await evaluate("document.querySelector('[data-view=appearance]').click()");
 assert.equal(await evaluate("document.getElementById('uiFontScale').getAttribute('aria-valuetext')"),'130%');
 await slide('uiFontScale',180);await slide('uiIconScale',160);
 for(const theme of ['light','dark']){
  await evaluate(`document.documentElement.dataset.theme='${theme}'`);await new Promise(r=>setTimeout(r,150));
  const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifact,`accessibility-settings-${theme}.png`),Buffer.from(shot.result.data,'base64'));
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 }
 await evaluate("document.querySelector('[data-view=chat]').click();document.querySelector('.welcome')?.remove();addMessage('user','放大后的字体与图标');addMessage('assistant','正文和侧栏文字会一起放大，SVG 图标保持独立调节。');");
 const b=await evaluate("(()=>{const b=document.getElementById('sendBtn').getBoundingClientRect(),i=document.querySelector('#sendBtn .send-icon').getBoundingClientRect();return {button:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},icon:{left:i.left,right:i.right,top:i.top,bottom:i.bottom}}})()");assert.ok(b.icon.left>=b.button.left&&b.icon.right<=b.button.right&&b.icon.top>=b.button.top&&b.icon.bottom<=b.button.bottom,JSON.stringify(b));
 for(const width of [900,390]){await cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});await new Promise(r=>setTimeout(r,100));assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);}
 await evaluate("document.querySelector('[data-view=appearance]').click();document.getElementById('uiScaleReset').click()");assert.equal(await evaluate('document.documentElement.dataset.fontScale'),'100');assert.equal(await evaluate('document.documentElement.dataset.iconScale'),'100');
 await evaluate("document.getElementById('uiFontScale').focus()");await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});assert.equal(await evaluate('document.documentElement.dataset.fontScale'),'110');assert.equal(await evaluate('document.documentElement.dataset.iconScale'),'100');
 const invalid=await evaluate("fetch('/api/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({fontScale:999,iconScale:0,theme:'dark'})}).then(r=>r.json())");assert.equal(invalid.fontScale,180);assert.equal(invalid.iconScale,100);
 assert.deepEqual(exceptions,[]);await cdp('Browser.close').catch(()=>{});
});
