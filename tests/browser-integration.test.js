const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const browser=process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>fs.existsSync(x));

test('real browser: one-time login, strict CSP boot, Markdown and opaque preview isolation', {skip:!browser,timeout:45000},async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-browser-'));process.env.IEXA_WORKSPACE=path.join(dir,'workspace');
  const backend=require('../dist/main/server');const server=await backend.startServer(0,false);const port=server.address().port;
  const code=backend.getServerCredentials(server).loginCode;
  const proc=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${path.join(dir,'profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
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
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/#login=${code}`});
  await wait("typeof SafeMarkdown !== 'undefined' && document.body.dataset.mobileClient === 'desktop'");
  assert.equal(await evaluate('location.hash'),'');
  assert.equal(await evaluate("document.querySelectorAll('script:not([src])').length"),0);
  assert.equal(await evaluate("fetch('/api/appearance').then(r=>r.status)"),200);
  assert.equal(await evaluate("document.cookie.includes('iexa_desktop_session')"),false);
  assert.equal(await evaluate("(()=>{ const el=document.createElement('div');document.body.append(el);window.auditExecuted=false;renderMarkdownContent(el,'<img src=missing onerror=window.auditExecuted=true><script>window.auditExecuted=true</script>');return el.querySelector('[onerror],script')===null; })()"),true);
  await new Promise(r=>setTimeout(r,100));assert.equal(await evaluate('window.auditExecuted'),false);
  assert.deepEqual(exceptions,[],'application boot must not have uncaught JS/CSP script errors');
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE,'isolation.html'),`<!doctype html><script>fetch('/api/appearance',{credentials:'include'}).then(()=>document.title='FAILED').catch(()=>document.title='ISOLATED')</script>`);
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/api/fs/preview/workspace/isolation.html`});
  await wait("document.title==='ISOLATED'");
  assert.equal(await evaluate('document.title'),'ISOLATED');
  const close=cdp('Browser.close').catch(()=>{});await Promise.race([close,new Promise(r=>setTimeout(r,1000))]);
});
