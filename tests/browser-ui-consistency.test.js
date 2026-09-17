const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const browser=process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>fs.existsSync(x));

test('real browser: consistent icon controls, project routing, themes and real viewport geometry', {skip:!browser,timeout:60000},async(t)=>{
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
  const project=path.join(dir,'IEXA-WIN');fs.mkdirSync(project);
  for(const name of ['src','scripts','tests','docs','desktop-agent','resources'])fs.mkdirSync(path.join(project,name));
  for(const [name,content] of [['package.json','{"name":"iexa-ui-fixture"}'],['README.md','# IEXA-WIN'],['example.ts','console.log("UI fixture");'],['notes.txt','Test fixture, not a user project.']])fs.writeFileSync(path.join(project,name),content);
  await evaluate(`openProjectPath(${JSON.stringify(project)})`);
  await wait("document.querySelectorAll('.files-item').length === 10 && document.getElementById('shellProjectName').textContent==='IEXA-WIN'");
  await evaluate(String.raw`(()=>{
    document.documentElement.dataset.motion='full';
    document.querySelector('.welcome')?.remove();
    const user=addMessage('user','在吗？',[],{timestamp:Date.now()});
    const assistant=addMessage('assistant','在的，有什么需要我帮你处理？',[],{timestamp:Date.now()});
    window.__projectPickCount=0;
  })()`);
  await evaluate(`window.iexaDesktop={pickFolder:async()=>{window.__projectPickCount++;return ${JSON.stringify(project)};}}`);
  const ids=['shellAddProject','filesOpenBtn','filesRefreshBtn','filesCloseProjectBtn','newSessionBtn','archiveManagerBtn'];
  const measurements={};
  async function geometry(){return evaluate(`Object.fromEntries(${JSON.stringify(ids)}.map(id=>{
    const el=document.getElementById(id),icon=el.querySelector('svg'),b=el.getBoundingClientRect(),i=icon.getBoundingClientRect(),s=getComputedStyle(el),v=getComputedStyle(icon);
    return [id,{width:b.width,height:b.height,iconWidth:i.width,iconHeight:i.height,dx:i.x+i.width/2-b.x-b.width/2,dy:i.y+i.height/2-b.y-b.height/2,stroke:v.strokeWidth,color:s.color,fill:v.fill,transform:v.transform,background:s.backgroundColor,label:el.getAttribute('aria-label'),inside:b.x>=0&&b.right<=innerWidth}];
  }))`);}
  async function shot(name){const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifact,name+'.png'),Buffer.from(result.result.data,'base64'));}
  async function point(id){return evaluate(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);}
  async function mouse(id,click=false){const p=await point(id);await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...p});if(click){await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}}
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);await new Promise(r=>setTimeout(r,180));
    const values=await geometry();measurements[theme]=values;
    for(const [id,m] of Object.entries(values)){
      assert.equal(m.width,32,`${theme}/${id} button width`);assert.equal(m.height,32,`${theme}/${id} button height`);
      assert.equal(m.iconWidth,18,`${theme}/${id} icon width`);assert.equal(m.iconHeight,18,`${theme}/${id} icon height`);
      assert.ok(Math.abs(m.dx)<.1 && Math.abs(m.dy)<.1,`${id} must be optically centered`);
      assert.equal(m.stroke,'1.75px');assert.equal(m.fill,'none');assert.ok(m.label);assert.equal(m.inside,true);
    }
    assert.equal(values.shellAddProject.color,values.filesOpenBtn.color);
    await shot('chat-'+theme);
    await mouse('filesOpenBtn');await new Promise(r=>setTimeout(r,180));
    const hovered=(await geometry()).filesOpenBtn;assert.notEqual(hovered.background,values.filesOpenBtn.background);assert.equal(hovered.transform,'none');
    await shot('toolbar-hover-'+theme);
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:500,y:300});
  }
  // Existing settings controls keep their native behavior and share the same surfaces.
  await evaluate("document.querySelector('[data-view=\"settings\"]').click();showProfileEditor()");
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    const form=await evaluate(`(()=>{const input=document.getElementById('profileEditorName'),select=document.getElementById('profileEditorProvider'),box=document.getElementById('profileEditorFastMode');return {input:getComputedStyle(input).borderRadius,select:getComputedStyle(select).borderRadius,inputHeight:input.getBoundingClientRect().height,selectHeight:select.getBoundingClientRect().height,checkbox:box.getBoundingClientRect().width,background:getComputedStyle(input).backgroundColor,selectBackground:getComputedStyle(select).backgroundColor};})()`);
    assert.equal(form.input,'9px');assert.equal(form.select,'9px');assert.ok(form.inputHeight>=40);assert.ok(form.selectHeight>=40);assert.equal(form.checkbox,18);assert.equal(form.background,form.selectBackground);
    assert.equal(await evaluate("(()=>{const input=document.getElementById('profileEditorModel').getBoundingClientRect(),button=document.getElementById('fetchModelsBtn').getBoundingClientRect();return Math.abs(input.top-button.top)<1 && input.right<button.left;})()"),true);
    measurements['form-'+theme]=form;await shot('settings-'+theme);
  }
  await evaluate("document.getElementById('profileEditorFastMode').click()");
  assert.equal(await evaluate("document.getElementById('profileEditorFastMode').checked"),true);
  await evaluate("hideProfileEditor();document.querySelector('[data-view=\"chat\"]').click()");
  // Real pointer activation: all entry points invoke the original native picker once.
  for(const id of ['shellAddProject','filesOpenBtn','shellProjectBtn']){
    const before=await evaluate('window.__projectPickCount');await mouse(id,true);
    await wait(`window.__projectPickCount===${before+1}`);await new Promise(r=>setTimeout(r,100));assert.equal(await evaluate('window.__projectPickCount'),before+1);
  }
  await evaluate("document.getElementById('filesOpenBtn').disabled=true");const picks=await evaluate('window.__projectPickCount');await mouse('filesOpenBtn',true);assert.equal(await evaluate('window.__projectPickCount'),picks);await evaluate("document.getElementById('filesOpenBtn').disabled=false");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await evaluate("document.getElementById('shellAddProject').focus()");
  assert.equal(await evaluate("document.getElementById('shellAddProject').matches(':focus-visible')"),true);
  await shot('keyboard-focus-dark');

  // Long titles must ellipsize before the action strip, not squeeze/overlap it.
  const longName='IEXA-WIN-'+ '长项目名称-'.repeat(16);
  await evaluate(`document.getElementById('filesPanelTitle').textContent=${JSON.stringify(longName)}`);
  for(const width of [1024,1175,1440]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:839,deviceScaleFactor:1,mobile:false});
    await new Promise(r=>setTimeout(r,100));
    const layout=await evaluate(`(()=>{const title=document.getElementById('filesPanelTitle'),r=title.getBoundingClientRect(),actions=document.querySelector('.files-panel-actions').getBoundingClientRect(),left=document.getElementById('shellProjectName'),lr=left.getBoundingClientRect(),chevron=document.querySelector('.project-row-chevron').getBoundingClientRect();return {titleRight:r.right,actionsLeft:actions.left,leftRight:lr.right,chevronLeft:chevron.left,overflow:document.documentElement.scrollWidth>innerWidth,ellipsis:getComputedStyle(title).textOverflow,leftEllipsis:getComputedStyle(left).textOverflow,title:title.title};})()`);
    assert.ok(layout.titleRight<=layout.actionsLeft);assert.ok(layout.leftRight<=layout.chevronLeft);assert.equal(layout.overflow,false);assert.equal(layout.ellipsis,'ellipsis');assert.equal(layout.leftEllipsis,'ellipsis');assert.equal(layout.title,longName);
    measurements['layout-'+width]=layout;
  }
  await evaluate("document.getElementById('filesPanelTitle').textContent='IEXA-WIN';document.documentElement.dataset.theme='light'");
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("document.getElementById('mobileMenuBtn').click()");await new Promise(r=>setTimeout(r,200));
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
  assert.equal(await evaluate("document.getElementById('shellAddProject').getBoundingClientRect().width"),36);
  await shot('mobile-sidebar-light');
  // Every category uses one outline use node, never the previous black fallback fill.
  assert.equal(await evaluate("[...document.querySelectorAll('.file-type-icon svg')].every(svg=>svg.querySelectorAll('use').length===1&&getComputedStyle(svg).fill==='none')"),true);
  fs.writeFileSync(path.join(artifact,'browser-ui-measurements.json'),JSON.stringify(measurements,null,2));
  assert.deepEqual(exceptions,[]);
  const close=cdp('Browser.close').catch(()=>{});await Promise.race([close,new Promise(r=>setTimeout(r,1000))]);
});
