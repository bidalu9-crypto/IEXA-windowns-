/* Real Chromium rendering: progress shimmer, history parity, themes, narrow layout. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts/desktop-control-validation');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
let win;const results=[];
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});
 win=new BrowserWindow({show:false,width:850,height:700,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html data-theme="dark" data-motion="full"><body class="workbench-shell"><main style="width:min(680px,calc(100vw - 48px));margin:30px auto"><h2>桌面操作</h2><p>观察、定位、执行和验证</p><section id="live" class="tool-block activity-row"><div class="tool-header">在测试窗口中输入并核对内容</div></section><h3>会话恢复</h3><section id="history" class="tool-block activity-row"></section></main></body></html>'));
 await win.webContents.insertCSS(fs.readFileSync(path.join(root,'src/renderer/styles.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'src/renderer/workbench.css'),'utf8'));
 await win.webContents.executeJavaScript(fs.readFileSync(path.join(root,'src/renderer/services/ToolLifecycleView.js'),'utf8'));
 await win.webContents.executeJavaScript(`window.events=['queued','resolve','action_start','action_end','observe','verify','completed'].map((phase,i)=>({version:1,operationId:'o',sequence:i+1,phase,timestamp:1789469000000+i*200,action:'type',verified:phase==='verify'}));window.render=()=>{};window.live=document.querySelector('#live');window.historyCard=document.querySelector('#history');window.view=IexaToolLifecycleView;void 0;`);
 for(const [theme,width] of [['dark',850],['light',850],['dark',420]]) {
  win.setSize(width,700);
  await new Promise(resolve=>setTimeout(resolve,200));
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.motion='full';live.replaceWith(live.cloneNode(false));window.live=document.querySelector('#live');historyCard.replaceWith(historyCard.cloneNode(false));window.historyCard=document.querySelector('#history');for(const element of [live,historyCard])for(const key of Object.keys(element.dataset))delete element.dataset[key];view.apply(live,{version:1,runId:'r',sequence:1,status:'running',desktop:events[2]},render);`);
  const active=await win.webContents.executeJavaScript("getComputedStyle(live.querySelector('summary')).animationName");assert.equal(active,'desktop-phase-sweep');
  await win.webContents.executeJavaScript("document.documentElement.dataset.motion='reduced'");assert.equal(await win.webContents.executeJavaScript("getComputedStyle(live.querySelector('summary')).animationName"),'none');
  await win.webContents.executeJavaScript("document.documentElement.dataset.motion='full';window.result={success:true,executionStatus:'completed',metadata:{desktop:{events}}};view.applyResult(live,result,render);view.applyResult(historyCard,JSON.parse(JSON.stringify(result)),render);live.querySelector('details').open=true;historyCard.querySelector('details').open=true;");
  const measured=await win.webContents.executeJavaScript(`({same:live.querySelector('details').innerHTML===historyCard.querySelector('details').innerHTML,animation:getComputedStyle(live.querySelector('summary')).animationName,rows:live.querySelectorAll('li').length,overflow:document.documentElement.scrollWidth>innerWidth,detailsVisible:live.querySelector('ol').getBoundingClientRect().height>0})`);
  assert.equal(measured.same,true);assert.equal(measured.animation,'none');assert.equal(measured.rows,7);assert.equal(measured.overflow,false);assert.equal(measured.detailsVisible,true);
  await new Promise(resolve=>setTimeout(resolve,240));
  fs.writeFileSync(path.join(out,`control-ui-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());results.push({theme,width,activeAnimation:active,...measured});
 }
 console.log('PASS: Chromium dark/light/narrow, active text shimmer, reduced motion, terminal stop and live/history parity.');
}).catch(e=>{results.push({error:e.stack});console.error(e);process.exitCode=1;}).finally(()=>{fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'chromium-checks.json'),JSON.stringify(results,null,2));win?.destroy();app.exit(process.exitCode||0);});
