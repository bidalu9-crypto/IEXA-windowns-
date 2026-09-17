const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');const {JSDOM}=require('jsdom');
const {mainWindowChromeOptions,mainWindowState,runWindowCommand,resizedBounds,createWindowResize}=require('../resources/window-chrome.cjs');
function windowFixture(){const win={webContents:{},isDestroyed:()=>false,max:false,full:false,calls:[]};win.isMaximized=()=>win.max;win.isFullScreen=()=>win.full;win.minimize=()=>win.calls.push('min');win.maximize=()=>{win.max=true;win.calls.push('max');};win.unmaximize=()=>{win.max=false;win.calls.push('restore');};win.setFullScreen=v=>{win.full=v;};win.close=()=>win.calls.push('close');return win;}
test('main chrome options only affect Windows and preserve normal opaque rendering',()=>{
 assert.deepEqual(mainWindowChromeOptions('win32','10.0.19045'),{frame:false,roundedCorners:true,thickFrame:false});assert.deepEqual(mainWindowChromeOptions('darwin'),{});assert.deepEqual(mainWindowChromeOptions('linux'),{});
});
test('window command allowlist, exact sender, and existing close lifecycle',()=>{
 const win=windowFixture();assert.throws(()=>runWindowCommand(win,{},'close','win32'),/sender/);assert.throws(()=>runWindowCommand(win,win.webContents,'eval','win32'),/Unknown/);assert.equal(win.calls.length,0);
 for(const command of ['minimize','toggle-maximize','toggle-maximize','close'])runWindowCommand(win,win.webContents,command,'win32');assert.deepEqual(win.calls,['min','max','restore','close']);
 win.full=true;runWindowCommand(win,win.webContents,'toggle-maximize','win32');assert.equal(win.full,false);assert.deepEqual(mainWindowState(win,'win32'),{custom:true,maximized:false,fullscreen:false});
 win.isDestroyed=()=>true;assert.equal(mainWindowState(win,'win32'),null);assert.throws(()=>runWindowCommand(win,win.webContents,'close','win32'));
});
function domFixture(t,bridge){const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../src/renderer/index.html'),'utf8'),{url:'http://127.0.0.1',runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.iexaDesktop=bridge;dom.window.eval(fs.readFileSync(path.join(__dirname,'../src/renderer/services/WindowChrome.js'),'utf8'));return dom.window;}
test('integrated chrome controls forward once, state updates labels and listener is disposed',t=>{
 const calls=[];let listener,disposed=false;const w=domFixture(t,{initialWindowState:{custom:true,maximized:false,fullscreen:false},windowCommand:c=>{calls.push(c);return Promise.resolve();},onWindowState:cb=>{listener=cb;return()=>{disposed=true;};}});
 assert.equal(w.document.getElementById('windowControls').hidden,false);assert.equal(w.document.documentElement.dataset.windowChrome,'custom');
 for(const id of ['windowMinimize','windowMaximize','windowClose'])w.document.getElementById(id).click();assert.deepEqual(calls,['minimize','toggle-maximize','close']);
 listener({custom:true,maximized:true});assert.equal(w.document.getElementById('windowMaximize').getAttribute('aria-label'),'还原窗口');assert.equal(w.document.documentElement.dataset.windowExpanded,'true');
 listener({custom:true,fullscreen:true});assert.equal(w.document.getElementById('windowMaximize').title,'退出全屏');w.dispatchEvent(new w.Event('pagehide'));assert.equal(disposed,true);
});
test('browser and auxiliary windows never expose main-window controls',t=>{
 for(const bridge of [undefined,{initialWindowState:null},{isDesktop:true}]){const w=domFixture(t,bridge);assert.equal(w.document.getElementById('windowControls').hidden,true);assert.equal(w.document.documentElement.dataset.windowChrome,undefined);}
});

test('resize keeps opposite edges fixed, applies min/max sizes and rejects arbitrary senders',()=>{
 const base={x:100,y:100,width:1000,height:800},origin={x:0,y:0};
 for(const edge of ['n','s','e','w','ne','nw','se','sw']){const next=resizedBounds(base,origin,{x:120,y:80},edge,[800,600]);assert.ok(next.width>=800&&next.height>=600);if(edge.includes('w'))assert.equal(next.x+next.width,1100);if(edge.includes('n'))assert.equal(next.y+next.height,900);}
 assert.equal(resizedBounds(base,origin,{x:9999,y:0},'w',[800,600]).width,800);assert.equal(resizedBounds(base,origin,{x:9999,y:0},'e',[800,600],[1400,1000]).width,1400);
 const win=Object.assign(new (require('events').EventEmitter)(),windowFixture());let point={x:0,y:0};win.getBounds=()=>base;win.getMinimumSize=()=>[800,600];win.getMaximumSize=()=>[0,0];win.setBounds=b=>win.bounds=b;
 const resize=createWindowResize(win,()=>point);assert.throws(()=>resize({}, {phase:'start',edge:'e'}),/sender/);assert.throws(()=>resize(win.webContents,{phase:'start',edge:'bad'}),/edge/);
 resize(win.webContents,{phase:'start',edge:'e'});point={x:100,y:0};resize(win.webContents,{phase:'update'});assert.equal(win.bounds.width,1100);win.emit('blur');point={x:200,y:0};resize(win.webContents,{phase:'update'});assert.equal(win.bounds.width,1100);
});

test('fullscreen transition events stay authoritative when Electron reports a stale widget state',()=>{
 const {trackWindowState,isWindowFullscreen}=require('../resources/window-chrome.cjs');const win=Object.assign(new(require('events').EventEmitter)(),windowFixture());trackWindowState(win);
 win.emit('enter-full-screen');assert.equal(isWindowFullscreen(win),true);assert.equal(mainWindowState(win,'win32').fullscreen,true);
 win.full=true;win.emit('leave-full-screen');assert.equal(isWindowFullscreen(win),false);assert.equal(mainWindowState(win,'win32').fullscreen,false);
});
