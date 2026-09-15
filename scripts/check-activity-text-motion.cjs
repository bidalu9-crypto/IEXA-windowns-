/* Text sweep verification in real Chromium; use actual lifecycle and finish handlers. */
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),renderer=path.join(root,'src/renderer'),out=path.join(root,'.iexa-artifacts/subagent-detail-fix-20260915');
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');let win,server;const results=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html',file=path.resolve(renderer,name);if(!file.startsWith(renderer+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');let data=fs.readFileSync(file);if(name==='index.html')data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.end(data);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
 for(const file of ['services/ChatActivityView.js','services/ToolLifecycleView.js'])await win.webContents.executeJavaScript(fs.readFileSync(path.join(renderer,file),'utf8'));
 const source=ts.createSourceFile('app.js',fs.readFileSync(path.join(renderer,'app.js'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),finish=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='finishThinkingBlock').getText(source);
 await win.webContents.executeJavaScript(`window.thinkingEffortLabelFor=()=> '标准';${finish};
 (()=>{
 const fixture=document.createElement('section');fixture.id='sweepFixture';fixture.style='position:fixed;left:310px;top:120px;width:620px;padding:26px;background:var(--bg-primary);border:1px solid var(--border);z-index:100;';
 fixture.innerHTML='<h3 style="margin-bottom:18px;font-size:14px">思考与工具文字扫光</h3><details class="thinking-block" data-started-at="1"><summary><span class="thinking-title">思考</span><span class="thinking-chevron"></span></summary><pre class="thinking-content">正在核查会话事件顺序，并检查工具执行与历史恢复的一致性。</pre></details><div class="tool-block"><div class="tool-header"><span class="tool-heading"><span class="tool-name"></span><span class="tool-meta"></span></span><span class="tool-status"></span><span class="tool-chevron"></span></div><div class="tool-body"><pre class="tool-args"></pre><pre class="tool-result"></pre></div></div>';
 document.body.append(fixture);const thinking=fixture.querySelector('.thinking-block');IexaChatActivity.prepareThinking(thinking);thinking.open=true;
 const tool=fixture.querySelector('.tool-block');IexaChatActivity.updateTool(tool,'file_read',{path:'src/renderer/app.js'});
 window.renderState=(block,cls,label)=>{block.querySelector('.tool-status').textContent=label||cls;};window.sequence=0;
 window.state=status=>IexaToolLifecycleView.apply(tool,{version:1,sequence:++sequence,runId:'fixture',status},renderState);
 window.probe=()=>{const selectors=['.thinking-title','.thinking-content','.activity-operation','.tool-name'];return selectors.map(selector=>{const el=fixture.querySelector(selector),style=getComputedStyle(el);return {selector,animation:style.animationName,position:style.backgroundPosition,clip:style.backgroundClip,fill:style.webkitTextFillColor,background:style.backgroundColor,shadow:style.textShadow};});};state('running');
 })()`);
 win.webContents.debugger.attach('1.3');
 for(const theme of ['dark','light'])for(const reduced of [false,true])for(const mode of ['full','system','reduced']){
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.motion=${JSON.stringify(mode)}`);await pause(80);
  const before=await win.webContents.executeJavaScript('probe()');await pause(200);const after=await win.webContents.executeJavaScript('probe()');
  const running=mode==='full'||mode==='system'&&!reduced;
  for(let i=0;i<before.length;i++){
   assert.equal(before[i].animation,running?'iexa-waiting-text-sweep':'none',`${theme}/${mode}/${reduced}/${before[i].selector}`);
   if(running){assert.notEqual(before[i].position,after[i].position);assert.equal(before[i].clip,'text');assert.equal(before[i].fill,'rgba(0, 0, 0, 0)');assert.equal(before[i].shadow,'none');}
   else{assert.notEqual(before[i].fill,'rgba(0, 0, 0, 0)');}
  }
  if(theme==='dark'&&!reduced&&mode==='full'){
   fs.writeFileSync(path.join(out,'text-sweep-frame-a.png'),(await win.webContents.capturePage()).toPNG());await pause(300);fs.writeFileSync(path.join(out,'text-sweep-frame-b.png'),(await win.webContents.capturePage()).toPNG());
  }
  results.push({theme,systemReduced:reduced,mode,running,before,after});
 }
 await win.webContents.executeJavaScript("document.documentElement.dataset.motion='full'");
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
 for(const item of await win.webContents.executeJavaScript('probe()')) { assert.equal(item.animation,'none');assert.notEqual(item.fill,'rgba(0, 0, 0, 0)'); }
 results.push({forcedColorsReadable:true});
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'none'},{name:'prefers-reduced-motion',value:'no-preference'}]});
 await win.webContents.executeJavaScript("document.documentElement.dataset.motion='full';finishThinkingBlock(document.querySelector('#sweepFixture .thinking-block'))");
 assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('#sweepFixture .thinking-title')).animationName"),'none');
 for(const status of ['awaiting_approval','cancelling','cancelled']){
  await win.webContents.executeJavaScript(`state(${JSON.stringify(status)})`);assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('#sweepFixture .tool-name')).animationName"),'none');
 }
 assert.equal(await win.webContents.executeJavaScript("state('running')"),false); // terminal cannot regress
 for(const status of ['completed','failed','denied','timed_out']){
  await win.webContents.executeJavaScript(`(()=>{const t=document.querySelector('#sweepFixture .tool-block');delete t.dataset.executionStatus;IexaToolLifecycleView.applyResult(t,{success:${status==='completed'},executionStatus:${JSON.stringify(status)}},renderState);})()`);
  assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('#sweepFixture .tool-name')).animationName"),'none');
 }
 results.push({terminalStatesStatic:true,lateRunningRejected:true});console.log('PASS: 12 text-motion combinations, actual position changes, reasoning/tool terminal states static, no background glow.');
}).catch(error=>{results.push({error:error.stack});console.error(error);process.exitCode=1;}).finally(()=>{fs.writeFileSync(path.join(out,'text-motion-checks.json'),JSON.stringify(results,null,2));win?.destroy();server?.close();app.exit(process.exitCode||0);});
