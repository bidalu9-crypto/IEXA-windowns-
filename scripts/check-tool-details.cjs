/* Expanded Shell surface visual oracle; local fixture, no provider/tool execution. */
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),renderer=path.join(root,'src/renderer'),out=path.join(root,'.iexa-artifacts/tool-details-20260915');
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
let win,server;const results=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';const p=path.resolve(renderer,name);if(!p.startsWith(renderer+path.sep)||!fs.existsSync(p)){res.writeHead(404).end();return;}res.setHeader('Content-Type',p.endsWith('.css')?'text/css; charset=utf-8':p.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');let data=fs.readFileSync(p);if(name==='index.html')data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.end(data);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1440,height:950,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
 const command='Get-Content src/renderer/app.js | Select-Object -Skip 1930 -First 115; Get-Content src/main/api/StreamBatcher.ts';
 const output=fs.readFileSync(path.join(root,'src/main/api/StreamBatcher.ts'),'utf8')+'\n'+Array.from({length:45},(_,i)=>`fixture output line ${i+1}: this is a local UI fixture, not an executed model command`).join('\n');
 for(const [name,width,height,theme] of [['dark',1440,950,'dark'],['light',1440,950,'light'],['mobile',390,844,'dark']]){
  win.setContentSize(width,height);await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(renderer,'services/ChatActivityView.js'),'utf8'));
  await win.webContents.executeJavaScript(`(()=>{
   document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.motion='full';
   const chat=document.getElementById('chatMessages');chat.replaceChildren();const msg=document.createElement('article');msg.className='message assistant';
   const thought=document.createElement('div');thought.style='font-size:12px;color:var(--text-muted);margin-bottom:6px';thought.textContent='正在思考';msg.appendChild(thought);
   const host=document.createElement('div');host.className='tool-steps activity-list';const block=document.createElement('div');block.className='tool-block is-done';
   block.innerHTML='<div class="tool-header"><span class="tool-icon"><svg class="ui-icon"><use href="#ui-terminal"/></svg></span><span class="tool-heading"><span class="tool-name"></span><span class="tool-meta"></span></span><span class="tool-status done">完成</span><span class="tool-chevron"></span></div><div class="tool-body"><pre class="tool-args"></pre><pre class="tool-result"></pre></div>';
   block.querySelector('.tool-args').textContent=JSON.stringify({command:${JSON.stringify(command)},timeout:60,tool_title:'读取本地代码'},null,2);
   block.querySelector('.tool-result').textContent=${JSON.stringify(output)};block.querySelector('.tool-result')._fullText=${JSON.stringify(output)};
   window.IexaChatActivity.updateTool(block,'shell_execute',{command:${JSON.stringify(command)}},{success:true});host.appendChild(block);msg.appendChild(host);chat.appendChild(msg);block.querySelector('.tool-header').click();
  })()`);
  await sleep(700);await win.webContents.capturePage();await sleep(90);
  const measurements=await win.webContents.executeJavaScript(`(()=>{
   const block=document.querySelector('.activity-row'),panel=block.querySelector('.tool-detail-panel'),view=panel.querySelector('.tool-console-viewport'),output=panel.querySelector('.tool-result'),args=panel.querySelector('.tool-raw-input');const rect=panel.getBoundingClientRect();
   return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panel:{x:rect.x,y:rect.y,w:rect.width,h:rect.height,right:rect.right},panelCount:block.querySelectorAll('.tool-detail-panel').length,rawHidden:args.hidden,command:panel.querySelector('.tool-command').textContent,title:panel.querySelector('.tool-detail-title').textContent,viewport:{h:view.clientHeight,scroll:view.scrollHeight,mask:getComputedStyle(view).maskImage},output:{overflow:getComputedStyle(output).overflowY,background:getComputedStyle(output).backgroundColor,border:getComputedStyle(output).borderWidth},scrollContainers:[...block.querySelectorAll('*')].filter(n=>['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+2&&n.getBoundingClientRect().height>0).length};
  })()`);
  assert.equal(measurements.title,'Shell');assert.equal(measurements.rawHidden,true);assert.equal(measurements.panelCount,1);assert.equal(measurements.command,'$ '+command);assert.ok(measurements.scrollWidth<=width);assert.ok(measurements.panel.right<=width);assert.equal(measurements.output.overflow,'visible');assert.equal(measurements.output.background,'rgba(0, 0, 0, 0)');assert.equal(measurements.output.border,'0px');assert.equal(measurements.scrollContainers,1);assert.ok(measurements.viewport.scroll>measurements.viewport.h);assert.notEqual(measurements.viewport.mask,'none');
  fs.writeFileSync(path.join(out,`shell-${name}.png`),(await win.webContents.capturePage()).toPNG());
  if(name==='dark')fs.writeFileSync(path.join(out,'shell-dark-panel.png'),(await win.webContents.capturePage({x:Math.floor(measurements.panel.x)-1,y:Math.floor(measurements.panel.y)-40,width:Math.ceil(measurements.panel.w)+2,height:Math.ceil(measurements.panel.h)+44})).toPNG());
  const after=await win.webContents.executeJavaScript(`(()=>{const b=document.querySelector('.activity-row'),v=b.querySelector('.tool-console-viewport');v.scrollTop=v.scrollHeight;window.IexaChatActivity.refreshDetail(b);return {atBottom:v.dataset.atBottom,mask:getComputedStyle(v).maskImage};})()`);assert.equal(after.atBottom,'true');assert.equal(after.mask,'none');
  await win.webContents.executeJavaScript("document.querySelector('.tool-toggle-params').click()");assert.equal(await win.webContents.executeJavaScript("document.querySelector('.tool-raw-input').hidden"),false);
  results.push({name,...measurements,bottom:after});
 }
 console.log('PASS: 3 viewports/themes, unified Shell panel, raw params opt-in, one output scroller, fade clears at bottom, no horizontal overflow.');
}).catch(e=>{results.push({error:e.stack});console.error(e);process.exitCode=1;}).finally(()=>{fs.writeFileSync(path.join(out,'visual-checks.json'),JSON.stringify(results,null,2));win?.destroy();server?.close();app.exit(process.exitCode||0);});
