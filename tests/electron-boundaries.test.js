const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../electron-entry.js'),'utf8');
test('Electron IPC accepts only the exact privileged top-level UI frame',()=>{
  const frame={url:'http://127.0.0.1:12345/'};const contents={mainFrame:frame};const context={URL,PORT:12345,LOOPBACK_HOST:'127.0.0.1',mainWindow:{isDestroyed:()=>false,webContents:contents},desktopLiveWindow:null};vm.createContext(context);
  const a=source.indexOf('function trustedSender('),b=source.indexOf('const registerHandle',a);vm.runInContext(source.slice(a,b),context);
  assert.equal(context.trustedSender({sender:contents,senderFrame:frame}),true);
  for(const url of ['http://127.0.0.1:12345/api/fs/preview/workspace/x.html','http://127.0.0.1:12345.evil.invalid/','https://example.invalid/','file:///C:/fixture.html']){frame.url=url;assert.equal(context.trustedSender({sender:contents,senderFrame:frame}),false,url);}
  frame.url='http://127.0.0.1:12345/';assert.equal(context.trustedSender({sender:contents,senderFrame:{url:frame.url}}),false,'subframe');assert.equal(context.trustedSender({sender:{mainFrame:frame},senderFrame:frame}),false,'other webContents');
});
test('Electron navigation restricts documents, new windows and external protocols',()=>{
  let navigation;const context={URL,PORT:12345,LOOPBACK_HOST:'127.0.0.1'};vm.createContext(context);const a=source.indexOf('function secureNavigation('),b=source.indexOf("ipcMain.on('iexa:get-initial-appearance'",a);vm.runInContext(source.slice(a,b),context);
  context.secureNavigation({webContents:{on:(_,handler)=>navigation=handler}},['/']);let prevented=false;navigation({preventDefault:()=>prevented=true},'http://127.0.0.1:12345/');assert.equal(prevented,false);navigation({preventDefault:()=>prevented=true},'http://127.0.0.1:12345/api/fs/raw?path=x.html');assert.equal(prevented,true);
  let handler;const opened=[];context.mainWindow={webContents:{setWindowOpenHandler:fn=>handler=fn}};context.shell={openExternal:url=>{opened.push(url);return Promise.resolve();}};
  const start=source.indexOf('mainWindow.webContents.setWindowOpenHandler('),end=source.indexOf('\n  });',start)+7;vm.runInContext(source.slice(start,end),context);
  for(const url of ['file:///C:/x.exe','javascript:alert(1)','ms-settings:','data:text/html,hi','https://user:pass@example.invalid/']) assert.equal(handler({url}).action,'deny');
  assert.equal(opened.length,0);handler({url:'https://example.invalid/'});assert.deepEqual(opened,['https://example.invalid/']);
  const child=handler({url:'http://127.0.0.1:12345/api/fs/raw?path=preview.html'});assert.equal(child.action,'allow');assert.equal(child.overrideBrowserWindowOptions.webPreferences.nodeIntegration,false);assert.equal(child.overrideBrowserWindowOptions.webPreferences.preload,undefined);assert.equal(child.overrideBrowserWindowOptions.webPreferences.sandbox,true);
});
