const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript');const {JSDOM}=require('jsdom');
function fixture(t){const dom=new JSDOM('<!doctype html><textarea id="chatInput"></textarea><div id="slashMenu" style="display:none"></div>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};for(const file of ['AppDialogs','ComposerInput'])w.eval(fs.readFileSync('src/renderer/services/'+file+'.js','utf8'));return w;}
const tick=()=>new Promise(r=>setImmediate(r));
test('confirm is async, Escape cancels and restores draft focus and selection',async t=>{
 const w=fixture(t),input=w.document.getElementById('chatInput');input.value='未发送草稿';input.focus();input.setSelectionRange(1,3);
 const result=w.IexaDialogs.confirm('<img src=x onerror=alert(1)>');await tick();const dialog=w.document.querySelector('dialog');assert.ok(dialog.open);assert.equal(dialog.querySelector('img'),null);
 let ticked=false;await new Promise(r=>setTimeout(()=>{ticked=true;r();},0));assert.equal(ticked,true);
 dialog.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(await result,false);assert.equal(w.document.querySelector('dialog'),null);assert.equal(w.document.activeElement,input);assert.equal(input.value,'未发送草稿');assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,3);
});
test('queued prompt/confirm dialogs settle once without native popups or stale modal overlays',async t=>{
 const w=fixture(t);const first=w.IexaDialogs.prompt('名称','初始值'),second=w.IexaDialogs.confirm('继续？');await tick();let dialog=w.document.querySelector('dialog');assert.equal(w.document.querySelectorAll('dialog').length,1);dialog.querySelector('input').value='新名称';dialog.querySelector('.btn-primary').click();assert.equal(await first,'新名称');await tick();dialog=w.document.querySelector('dialog');dialog.querySelector('.btn-primary').click();assert.equal(await second,true);assert.equal(w.document.querySelectorAll('dialog').length,0);
});
test('prompt Enter during IME composition never submits; regular Enter does',async t=>{
 const w=fixture(t);const result=w.IexaDialogs.prompt('输入');await tick();const input=w.document.querySelector('dialog input');input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));assert.ok(w.document.querySelector('dialog'));input.value='中文';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.equal(await result,'中文');
});
test('actual chat send and slash handlers preserve IME candidate Enter and keyCode229',t=>{
 const w=fixture(t);const app=fs.readFileSync('src/renderer/app.js','utf8');const a=app.indexOf('const chatComposition ='),b=app.indexOf('// Voice',a);const end=app.indexOf('function setVoiceState',a);
 const ast=ts.createSourceFile('app.js',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),handlers=[];function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='chatInput.addEventListener'&&n.arguments[0]?.text==='keydown')handlers.push(n.getText(ast));ts.forEachChild(n,walk);}walk(ast);
 w.eval(`const chatInput=document.getElementById('chatInput');const chatComposition=IexaComposerInput.bind(chatInput);let sent=0;function sendMessage(){sent++;}function hideSlashMenu(){}function applySlashSkill(){}${handlers.join(';')};window.sent=()=>sent;`);
 const input=w.document.getElementById('chatInput');input.value='草稿';input.dispatchEvent(new w.CompositionEvent('compositionstart'));const ime=new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(ime);assert.equal(ime.defaultPrevented,false);assert.equal(w.sent(),0);input.dispatchEvent(new w.CompositionEvent('compositionend'));input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));assert.equal(w.sent(),0);input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(w.sent(),0);input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.equal(w.sent(),1);
});
test('all old blocking dialog call sites are replaced with awaited application dialogs',()=>{
 const app=fs.readFileSync('src/renderer/app.js','utf8');const ast=ts.createSourceFile('app.js',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let replaced=0;function walk(n){if(ts.isCallExpression(n)){assert.doesNotMatch(n.expression.getText(ast),/^(?:window\.)?(?:alert|confirm|prompt)$/);if(/^window\.IexaDialogs\./.test(n.expression.getText(ast))){replaced++;assert.equal(n.parent.kind,ts.SyntaxKind.AwaitExpression);}}ts.forEachChild(n,walk);}walk(ast);assert.ok(replaced>=18);
});

test('streaming Markdown defers syntax highlighting while retaining sanitizer and final styling',t=>{
 const w=fixture(t);for(const file of ['vendor/marked.umd.js','vendor/highlight.min.js','vendor/purify.min.js'])w.eval(fs.readFileSync('src/renderer/'+file,'utf8'));
 let highlights=0;const original=w.hljs.highlight;w.hljs.highlight=(...args)=>{highlights++;return original(...args);};w.eval(fs.readFileSync('src/renderer/services/SafeMarkdown.js','utf8'));
 const app=fs.readFileSync('src/renderer/app.js','utf8'),start=app.indexOf('function renderMarkdownContent('),end=app.indexOf('\n}',start)+2;
 w.eval(`const renderSafeMarkdown=SafeMarkdown.renderSafeMarkdown;function normalizeRenderedAssets(){}function enhanceCodeBlocks(){}function enhanceTables(){}function scrollToBottom(){}const isNearChatBottom=false;${app.slice(start,end)};window.renderFixture=renderMarkdownContent;`);
 const element=w.document.createElement('div');const code='```js\nconst answer = 42;\n```\n<img src=x onerror="alert(1)">';
 for(let i=1;i<=code.length;i++)w.renderFixture(element,code.slice(0,i),false);
 assert.equal(highlights,0);assert.equal(element.querySelector('[onerror]'),null);
 w.renderFixture(element,code,true);assert.equal(highlights,1);assert.ok(element.querySelector('.hljs-keyword'));w.renderFixture(element,code,true);assert.equal(highlights,1);
});
