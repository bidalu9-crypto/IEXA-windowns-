/* Isolated real Electron + native-frame visual acceptance. Run with Electron, not Node. */
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{execFile}=require('child_process');
const root=path.resolve(__dirname,'..');const out=path.resolve(process.env.IEXA_CHROME_ARTIFACTS || path.join(root,'.iexa-artifacts/window-chrome-review-20260917'));fs.mkdirSync(out,{recursive:true});
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-window-chrome-'));
process.env.IEXA_WORKSPACE=fixture;process.env.IEXA_HEADLESS='1';
const {app,BrowserWindow}=require('electron');
const results={fixture,electron:process.versions.electron,os:os.release(),native:[],checks:[]};
let win,finished=false;
function save(){fs.writeFileSync(path.join(out,'native-chrome-checks.json'),JSON.stringify(results,null,2));}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){for(let i=0;i<120;i++){if(await fn())return;await pause(100);}throw Error('Timeout: '+label);}
require(path.join(root,'electron-entry.js'));
app.whenReady().then(async()=>{
 await wait(()=>BrowserWindow.getAllWindows().length,'main window');win=BrowserWindow.getAllWindows()[0];
 win.webContents.on('console-message',details=>{if(details.level==='error')console.log('RENDERER',details.message);});
 await wait(()=>win.webContents.executeJavaScript("!!window.iexaDesktop?.initialWindowState?.custom && !document.getElementById('windowControls')?.hidden").catch(()=>false),'preload chrome');
 win.setBounds({x:80,y:80,width:1400,height:900});win.showInactive();await pause(400);
 await win.webContents.executeJavaScript("document.querySelector('.welcome')?.remove();addMessage('user','把窗口做成简洁、统一的现代圆角风格。');addMessage('assistant','窗口按钮已整合到顶部工具栏，保留圆角，不再显示老式系统标题栏。');");
 function handle(){const h=win.getNativeWindowHandle();return h.length===8?h.readBigUInt64LE().toString():h.readUInt32LE().toString();}
 async function capture(name){await pause(300);const info=JSON.parse((await require('util').promisify(execFile)((process.env.IEXA_PWSH || 'pwsh.exe'),['-NoProfile','-File',path.join(__dirname,'fixtures/capture-window-chrome.ps1'),'-WindowHandle',handle(),'-OutputFile',path.join(out,`${name}.png`)],{windowsHide:true,encoding:'utf8'})).stdout);results.native.push({name,...info,bounds:win.getBounds(),contentBounds:win.getContentBounds()});save();return info;}
 async function click(id){const p=await win.webContents.executeJavaScript(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await pause(100);}
 for(const theme of ['light','dark']){
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`);
  const info=await capture('window-'+theme);assert.ok(info.height-info.clientHeight<=8,'no separate native caption height');assert.equal(info.regionKind,3);assert.equal(info.cornerInside,false);assert.equal(info.regionBox.Right-info.regionBox.Left,info.clientWidth);assert.equal(info.regionBox.Bottom-info.regionBox.Top,info.clientHeight);assert.equal(info.captionHit,2);assert.equal(info.closeHit,1);assert.equal(info.leftEdgeHit,10);assert.equal(info.width,info.clientWidth);assert.equal(info.height,info.clientHeight);
  const geometry=await win.webContents.executeJavaScript(`(()=>{const r=id=>{const b=document.getElementById(id).getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,width:b.width,height:b.height}};return{controls:r('windowControls'),focus:r('shellFocusBtn'),header:document.querySelector('.workbench-header').getBoundingClientRect().height,drag:getComputedStyle(document.querySelector('.workbench-header')).webkitAppRegion,buttonDrag:getComputedStyle(document.getElementById('windowClose')).webkitAppRegion,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert.ok(geometry.focus.right<geometry.controls.left);assert.equal(geometry.controls.height,53);assert.equal(geometry.drag,'drag');assert.equal(geometry.buttonDrag,'no-drag');assert.equal(geometry.overflow,false);const family=await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('.nav-btn')).fontFamily");assert.match(family,/Arial|Segoe UI/);results.checks.push({theme,geometry,family});
 }


 const {screen}=require('electron');const originalCursor=screen.getCursorScreenPoint;
 const bounds=win.getBounds();let cursor={x:bounds.x+bounds.width-2,y:bounds.y+450};screen.getCursorScreenPoint=()=>cursor;
 try {
  await win.webContents.executeJavaScript("window.iexaDesktop.windowResize({phase:'start',edge:'e'})");
  cursor={x:cursor.x+100,y:cursor.y};await win.webContents.executeJavaScript("window.iexaDesktop.windowResize({phase:'update'})");
  await wait(()=>win.getBounds().width===bounds.width+100,'resize fallback IPC');
  await win.webContents.executeJavaScript("window.iexaDesktop.windowResize({phase:'end'})");
 } finally {screen.getCursorScreenPoint=originalCursor;}
 results.checks.push('native edge hit-test HTLEFT; preload resize fallback -> native bounds passed with controlled cursor coordinates');
 win.setBounds(bounds);await pause(100);
 await click('windowMaximize');await wait(()=>win.isMaximized(),'maximize');await wait(()=>win.webContents.executeJavaScript("document.getElementById('windowMaximize').title==='还原窗口'"),'restore label');
 const max=await capture('window-maximized');assert.equal(max.regionKind,0);
 await click('windowMaximize');await wait(()=>!win.isMaximized(),'restore');const restored=await capture('window-restored');assert.equal(restored.regionKind,3);
 await click('windowMinimize');await wait(()=>win.isMinimized(),'minimize');win.restore();await pause(200);results.checks.push('actual minimize/maximize/restore button IPC passed');
 win.setFullScreen(true);await wait(()=>require(path.join(root,'resources/window-chrome.cjs')).isWindowFullscreen(win),'fullscreen');await wait(()=>win.webContents.executeJavaScript("document.getElementById('windowMaximize').title==='退出全屏'"),'fullscreen label');await click('windowMaximize');await wait(()=>!require(path.join(root,'resources/window-chrome.cjs')).isWindowFullscreen(win),'leave fullscreen');
 win.setSize(900,720);await pause(200);assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true);await capture('window-narrow');

 await win.webContents.executeJavaScript("IexaUiScale.apply({fontScale:180,iconScale:160});IexaUiScale.sync();document.querySelector('[data-view=appearance]').click()");
 await pause(150);
 const scaled=await win.webContents.executeJavaScript("(()=>{const r=document.getElementById('windowControls').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,controlsRight:r.right,width:innerWidth};})()");
 assert.equal(scaled.overflow,false);assert.ok(scaled.controlsRight<=scaled.width);await capture('window-scaled-narrow');results.checks.push({scaled});
 await win.webContents.executeJavaScript("IexaUiScale.apply({fontScale:100,iconScale:100});IexaUiScale.sync()");
 results.checks.push('fullscreen restore and 900px layout passed');
 win.setSize(1200,900);await win.webContents.executeJavaScript("IexaUiScale.apply({fontScale:130,iconScale:130});IexaUiScale.sync();document.documentElement.dataset.theme='light';syncThemeUI()");await capture('appearance-readable');
 // close button must exercise the production shutdown lifecycle, not just hide to tray.
 win.once('closed',()=>{results.closed=true;results.passed=true;finished=true;save();});
 await click('windowClose');
}).catch(error=>{results.passed=false;results.error=error.stack;save();console.error(error);app.exit(1);});
process.on('exit',()=>{if(!finished&&!results.error){results.passed=false;results.error='Exited before close acceptance';save();}});
