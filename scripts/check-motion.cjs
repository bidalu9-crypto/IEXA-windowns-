/* Real Chromium motion regression. Isolated IEXA markup fixture, not a Codex reference. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),renderer=path.join(root,'src/renderer');
const out=path.join(root,'.iexa-artifacts/chat-activity-20260915/motion');
const baseline=process.argv.includes('--baseline');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
let win,server;const evidence={fixture:true,baseline,cases:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});
 server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  const file=path.resolve(renderer,name);
  if(!file.startsWith(renderer+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
  let data=fs.readFileSync(file);
  if(name==='index.html')data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  res.end(data);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
 evidence.nativeReducedMotion=await win.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches");
 win.webContents.debugger.attach('1.3');
 await win.webContents.executeJavaScript(fs.readFileSync(path.join(renderer,'services/ChatActivityView.js'),'utf8'));
 await win.webContents.executeJavaScript(`(()=>{
  const f=document.createElement('section');f.id='motionFixture';f.style='position:fixed;left:310px;top:130px;width:550px;padding:24px;z-index:100;background:var(--bg-primary);border:1px solid var(--border)';
  f.innerHTML='<h2>IEXA 动效回归夹具</h2><button id="motionSpinner"><svg class="ui-icon ui-icon-spin"><use href="#ui-refresh"/></svg>工具执行中</button>';
  f.insertBefore(window.IexaChatActivity.createWaiting(), f.querySelector('button'));
  document.body.appendChild(f);
 })()`);
 const capture=()=>win.webContents.executeJavaScript(`(()=>{
   const inspect=(selector,pseudo)=>{const el=document.querySelector(selector),s=getComputedStyle(el,pseudo);return {animation:s.animationName,playState:s.animationPlayState,transform:s.transform,backgroundPosition:s.backgroundPosition,transition:s.transitionDuration};};
   return {orbCount:document.querySelectorAll('.waiting-indicator__orb').length,waitingBackground:getComputedStyle(document.querySelector('.waiting-indicator')).backgroundColor,label:inspect('.waiting-indicator__label'),welcome:inspect('.welcome-icon .ui-icon'),empty:inspect('.files-empty-icon .ui-icon'),spinner:inspect('#motionSpinner .ui-icon'),send:inspect('#sendBtn .send-icon'),animations:document.getAnimations().filter(a=>a.playState==='running').length};
 })()`);
 for(const theme of ['light','dark'])for(const system of ['no-preference','reduce'])for(const mode of ['system','full','reduced']){
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:system}]});
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.motion=${JSON.stringify(mode)};`);
  await sleep(140);const before=await capture();await sleep(650);const after=await capture();
  const name=`${theme}-${system}-${mode}`;evidence.cases.push({name,before,after});
  if(!baseline){
   const reduced=mode==='reduced'||mode==='system'&&system==='reduce';
   for(const k of ['label','welcome','empty','spinner']){
    if(reduced)assert.equal(after[k].animation,'none',`${name}: ${k} ignores reduced motion`);
    else assert.notEqual(after[k].animation,'none',`${name}: ${k} static`);
   }
   if(!reduced){assert.notEqual(before.label.backgroundPosition,after.label.backgroundPosition,`${name}: text not advancing`);}
   assert.equal(after.orbCount,0,`${name}: obsolete waiting orb`);
   assert.equal(after.waitingBackground,'rgba(0, 0, 0, 0)',`${name}: waiting indicator still has a card`);
   if(reduced)assert.equal(after.animations,0,`${name}: running animations in reduced mode`);
   assert.equal(after.send.transform,'matrix(1, 0, 0, 1, -10.44, -9)',`${name}: send alignment`);
  }
  if(mode==='full'&&system==='reduce'){
   fs.writeFileSync(path.join(out,`${baseline?'before':'after'}-${theme}-a.png`),(await win.webContents.capturePage()).toPNG());
   await sleep(300);
   fs.writeFileSync(path.join(out,`${baseline?'before':'after'}-${theme}-b.png`),(await win.webContents.capturePage()).toPNG());
  }
 }
 console.log(JSON.stringify({nativeReducedMotion:evidence.nativeReducedMotion,cases:evidence.cases.length,baseline}));
 if(!baseline)console.log('PASS: light/dark × system motion × application preference; sweep advances; reduced mode static; send alignment preserved.');
}).catch(e=>{evidence.error=e.stack;console.error(e);process.exitCode=1;}).finally(()=>{
 fs.writeFileSync(path.join(out,baseline?'motion-before.json':'motion-after.json'),JSON.stringify(evidence,null,2));
 win?.destroy();server?.close();app.exit(process.exitCode||0);
});
