/* Hidden offscreen Chromium: real IEXA CSS + activity renderer, synthetic content only. */
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),renderer=path.join(root,'src/renderer'),out=path.join(root,'.iexa-artifacts/chat-activity-20260915');
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
let win,server;const results=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';const p=path.resolve(renderer,name);if(!p.startsWith(renderer+path.sep)||!fs.existsSync(p)){res.writeHead(404).end();return;}res.setHeader('Content-Type',p.endsWith('.css')?'text/css; charset=utf-8':p.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');let data=fs.readFileSync(p);if(name==='index.html')data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.end(data);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
 for(const [name,width,height,theme] of [['dark',1440,1000,'dark'],['light',1440,1000,'light'],['narrow',820,900,'dark'],['mobile',390,844,'dark']]){
  win.setContentSize(width,height);await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(renderer,'services/ChatActivityView.js'),'utf8'));
  await win.webContents.executeJavaScript(`(()=>{
    document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.motion='full';
    const chat=document.getElementById('chatMessages');chat.replaceChildren();
    const msg=document.createElement('article');msg.className='message assistant';
    msg.innerHTML='<div class="message-content">我会先检查项目结构，再整理工具和思考记录的展示方式。</div>';
    const thinking=document.createElement('details');thinking.className='thinking-block is-complete';thinking.dataset.startedAt=String(Date.now()-29000);thinking.innerHTML='<summary><svg class="ui-icon"><use href="#ui-brain"/></svg><span class="thinking-title">思考</span><span class="thinking-effort">标准</span><span class="thinking-token-count">128</span><span class="thinking-chevron"></span></summary><pre class="thinking-content">这里是可按需展开的思考内容。此页面使用合成测试数据，不调用模型或工具。</pre>';
    window.IexaChatActivity.prepareThinking(thinking);window.IexaChatActivity.finishThinking(thinking);msg.appendChild(thinking);
    const host=document.createElement('div');host.className='tool-steps activity-list';
    for(const [tool,path,added,removed,status] of [['file_read','src/renderer/app.js',0,0,'done'],['file_edit','src/renderer/services/ChatActivityView.js',12,3,'done'],['file_write','src/renderer/workbench.css',41,0,'done'],['shell_execute','npm test',0,0,'awaiting-approval']]){
      const row=document.createElement('div');row.className='tool-block is-done';
      row.innerHTML='<div class="tool-header"><span class="tool-icon"><svg class="ui-icon"><use href="#ui-'+(tool==='file_read'?'file':tool==='shell_execute'?'terminal':'edit')+'"/></svg></span><span class="tool-heading"><span class="tool-name"></span><span class="tool-meta"></span></span><span class="tool-status '+status+'">'+(status==='done'?'完成':'等待批准')+'</span><span class="tool-chevron"></span></div><div class="tool-body" style="display:none"><pre class="tool-args"></pre><pre class="tool-result">'+(status==='done'?'这里是测试夹具的工具详情。':'审批未通过前，工具尚未执行。')+'</pre></div>';
      const args=tool==='shell_execute'?{command:path}:{path};row.querySelector('.tool-args').textContent=JSON.stringify(args,null,2);
      window.IexaChatActivity.updateTool(row,tool,args,status==='done'?{success:true,fileChange:added?{path,added,removed}:undefined}:undefined);host.appendChild(row);
    }
    msg.appendChild(host);const text=document.createElement('div');text.className='message-content';text.textContent='工具记录保留真实状态和详情，默认以紧凑行展示。';msg.appendChild(text);msg.appendChild(window.IexaChatActivity.createWaiting());chat.appendChild(msg);
  })()`);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))");
  await sleep(700);
  const state=await win.webContents.executeJavaScript(`(()=>{
   const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
   return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,waitingChildren:document.querySelector('.waiting-indicator').children.length,rows:[...document.querySelectorAll('.activity-row .tool-header')].map(el=>({rect:rect(el),border:getComputedStyle(el.closest('.activity-row')).borderWidth,background:getComputedStyle(el.closest('.activity-row')).backgroundColor})),thinking:rect(document.querySelector('.thinking-block > summary'))};
  })()`);
  assert.ok(state.scrollWidth<=width,`${name}: horizontal overflow`);assert.equal(state.waitingChildren,1);assert.equal(state.rows.length,4);
  for(const r of state.rows){assert.ok(r.rect.w>60);assert.equal(r.border,'0px');assert.equal(r.background,'rgba(0, 0, 0, 0)');if(width>820)assert.ok(r.rect.h<=34,`${name}: row not compact`);}
  assert.ok(state.thinking.h<=32,`${name}: thinking still a card`);results.push({name,...state});
  await win.webContents.capturePage(); await sleep(90);
  fs.writeFileSync(path.join(out,`chat-${name}.png`),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelectorAll('.activity-row .tool-header')[1].click();document.querySelector('.thinking-block').open=true;`);
  await sleep(80);assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.activity-row .tool-header')[1].getAttribute('aria-expanded')`),'true');
  if(name==='dark')fs.writeFileSync(path.join(out,'chat-dark-details.png'),(await win.webContents.capturePage()).toPNG());
 }
 console.log('PASS: 4 viewports/themes, compact borderless rows, plain text waiting, native expansion and no horizontal overflow.');
}).catch(e=>{results.push({error:e.stack});console.error(e);process.exitCode=1;}).finally(()=>{fs.writeFileSync(path.join(out,'visual-checks.json'),JSON.stringify(results,null,2));win?.destroy();server?.close();app.exit(process.exitCode||0);});
