// Real shipped Electron runtime, isolated hidden fixture, no user config/server.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const report={scope:'Electron modal/IME input regression; synthetic IME events, not a physical IME driver test',cases:[]};let win;
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
const deadline=setTimeout(()=>{console.error('Electron composer test exceeded 25 seconds');app.exit(1);},25000);
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,width:800,height:650,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><body><textarea id="chatInput"></textarea><div id="slashMenu" style="display:none"></div></body></html>'));
 for(const file of ['AppDialogs','ComposerInput'])await win.webContents.executeJavaScript(fs.readFileSync(path.join(root,'src/renderer/services/'+file+'.js'),'utf8'));
 await win.webContents.insertCSS(fs.readFileSync(path.join(root,'src/renderer/components/AppDialogs.css'),'utf8'));
 const appSource=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
 const handlers=appSource.slice(appSource.indexOf('const chatComposition ='),appSource.indexOf('// Native streaming speech input:'));
 await win.webContents.executeJavaScript(`const chatInput=document.getElementById('chatInput');window.sent=0;function sendMessage(){window.sent++;}function updateSlashMenu(){}function hideSlashMenu(){}function applySlashSkill(){}${handlers};chatInput.focus();void 0;`);
 for(let i=0;i<30;i++){
  const mode=i%3===0?'confirm':i%3===1?'prompt':'alert';
  await win.webContents.executeJavaScript(`chatInput.value='草稿';chatInput.focus();chatInput.setSelectionRange(2,2);window.dialogAnswer='pending';void IexaDialogs.${mode}('测试弹窗','默认值').then(value=>{window.dialogAnswer=value;});`);
  await win.webContents.executeJavaScript(`document.querySelector('dialog .btn-primary').click();void 0;`);
  const state=await win.webContents.executeJavaScript(`({active:document.activeElement.id,dialogs:document.querySelectorAll('dialog').length,answer:window.dialogAnswer})`);
  assert.equal(state.active,'chatInput');assert.equal(state.dialogs,0);assert.notEqual(state.answer,'pending');
  await win.webContents.insertText('继续输入');
  assert.equal(await win.webContents.executeJavaScript('chatInput.value'),'草稿继续输入');
 }
 report.cases.push({name:'30 real Electron prompt/confirm/alert cycles restore editable focus, caret and native insertText',status:'passed'});
 const ime=await win.webContents.executeJavaScript(`chatInput.dispatchEvent(new CompositionEvent('compositionstart'));chatInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));const during=sent;chatInput.dispatchEvent(new CompositionEvent('compositionend'));chatInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));const fallback=sent;chatInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));({during,fallback,after:sent});`);
 assert.deepEqual(ime,{during:0,fallback:0,after:1});report.cases.push({name:'Actual composer handlers reserve IME Enter and send once after composition',status:'passed'});
 await win.webContents.executeJavaScript(`void IexaDialogs.confirm('取消测试').then(value=>window.cancelAnswer=value);`);
 await win.webContents.executeJavaScript(`document.querySelector('dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));void 0;`);
 assert.equal(await win.webContents.executeJavaScript('window.cancelAnswer'),false);await win.webContents.insertText('取消后');assert.match(await win.webContents.executeJavaScript('chatInput.value'),/取消后$/);
 report.cases.push({name:'Escape cancellation leaves no overlay and input remains editable',status:'passed'});
 for(const file of ['vendor/marked.umd.js','vendor/highlight.min.js','vendor/purify.min.js','services/SafeMarkdown.js'])await win.webContents.executeJavaScript(fs.readFileSync(path.join(root,'src/renderer',file),'utf8'));
 const renderStart=appSource.indexOf('function renderMarkdownContent('),renderEnd=appSource.indexOf('\n}',renderStart)+2;
 await win.webContents.executeJavaScript(`const renderSafeMarkdown=SafeMarkdown.renderSafeMarkdown;function normalizeRenderedAssets(){}function enhanceCodeBlocks(){}function enhanceTables(){}function scrollToBottom(){}const isNearChatBottom=false;${appSource.slice(renderStart,renderEnd)};window.streamArea=document.createElement('div');document.body.append(streamArea);chatInput.value='';chatInput.focus();void 0;`);
 const began=Date.now();
 for(let i=1;i<=40;i++){
  const source='```js\n'+('const answer = 42;\n'.repeat(i*5))+'```';
  await win.webContents.executeJavaScript(`renderMarkdownContent(streamArea,${JSON.stringify(source)},false);void 0;`);
  await win.webContents.insertText('字');
 }
 assert.equal(await win.webContents.executeJavaScript('chatInput.value'),'字'.repeat(40));
 report.cases.push({name:'40 growing streamed code renders interleaved with real Electron text insertion preserve all typed characters',status:'passed',elapsedMs:Date.now()-began});
 report.status='passed';
}).catch(error=>{report.status='failed';report.error=error.stack;}).finally(()=>{clearTimeout(deadline);console.log(JSON.stringify(report,null,2));win?.destroy();app.exit(report.status==='passed'?0:1);});
