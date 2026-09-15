const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');const {JSDOM}=require('jsdom');const ts=require('typescript');
const root=path.resolve(__dirname,'..');const source=fs.readFileSync(path.join(root,'src/renderer/services/ChatActivityView.js'),'utf8');
const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
function setup(t){const dom=new JSDOM('<body><div id="msg"></div></body>',{runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(source);return dom.window;}
function block(w){const b=w.document.createElement('div');b.className='tool-block';b.innerHTML='<div class="tool-header" data-ui-action="toggleToolBody"><span class="tool-icon"></span><span class="tool-heading"><span class="tool-name"></span><span class="tool-meta"></span></span><span class="tool-status">等待批准</span><span class="tool-chevron"></span></div><div class="tool-body" id="old-call-id" style="display:none"><pre class="tool-result">真实输出</pre></div>';w.document.body.appendChild(b);return b;}
function loadFunctions(w,names){const tree=ts.createSourceFile('app.js',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);for(const n of tree.statements)if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))w.eval(n.getText(tree));}

test('waiting status is text-only, live-announced and contains no orb/card children',t=>{
 const w=setup(t),n=w.IexaChatActivity.createWaiting();assert.equal(n.children.length,1);assert.equal(n.querySelectorAll('svg,.waiting-indicator__orb').length,0);assert.equal(n.getAttribute('role'),'status');assert.equal(n.textContent,'IEXA正在思考…');
});
test('tool row renders real path/counts safely without changing execution status',t=>{
 const w=setup(t),b=block(w);b.dataset.executionStatus='awaiting_approval';
 w.IexaChatActivity.updateTool(b,'file_edit',{path:'src/<img onerror=x>.ts'},{success:true,fileChange:{added:12,removed:3}});
 assert.equal(b.querySelector('img'),null);assert.equal(b.querySelector('.tool-name').textContent,'<img onerror=x>.ts');assert.equal(b.querySelector('.tool-meta').textContent,'src/');assert.equal(b.querySelector('.activity-operation').textContent,'编辑');assert.equal(b.querySelector('.activity-diff').textContent,'+12−3');assert.equal(b.dataset.executionStatus,'awaiting_approval');assert.equal(b.querySelector('.tool-status').textContent,'等待批准');
});
test('pending and failed writes never display invented diff numbers',t=>{
 const w=setup(t),b=block(w);w.IexaChatActivity.updateTool(b,'file_write',{path:'a.ts'});assert.equal(b.querySelector('.activity-diff').textContent,'');
 w.IexaChatActivity.updateTool(b,'file_write',undefined,{success:false,fileChange:{added:100,removed:12}});assert.equal(b.querySelector('.activity-diff').textContent,'');
});
test('native details buttons are bound once, preserve output and have unique DOM IDs',t=>{
 const w=setup(t),a=block(w),b=block(w);for(const row of [a,b])w.IexaChatActivity.updateTool(row,'shell_execute',{command:'npm test'});
 w.IexaChatActivity.updateTool(a,'shell_execute',{command:'npm test'});const h=a.querySelector('.tool-header');assert.equal(h.tagName,'BUTTON');assert.equal(h.hasAttribute('data-ui-action'),false);
 assert.notEqual(h.getAttribute('aria-controls'),b.querySelector('.tool-header').getAttribute('aria-controls'));h.click();assert.equal(h.getAttribute('aria-expanded'),'true');assert.equal(a.querySelector('.tool-body').style.display,'block');h.click();assert.equal(h.getAttribute('aria-expanded'),'false');assert.equal(a.querySelector('.tool-result').textContent,'真实输出');
});
test('thinking summary collapses by default and records only measured elapsed time',t=>{
 const w=setup(t),d=w.document.createElement('details');d.innerHTML='<summary><span class="thinking-title">思考</span><span class="thinking-effort">标准</span><span class="thinking-token-count">123</span><span class="thinking-chevron"></span></summary><pre class="thinking-content">推理内容</pre>';d.open=true;
 w.IexaChatActivity.prepareThinking(d);assert.equal(d.open,false);assert.equal(d.querySelector('summary .thinking-token-count'),null);assert.equal(d.querySelector('.thinking-details-meta').textContent,'标准123');
 w.IexaChatActivity.finishThinking(d,10000);assert.equal(d.querySelector('.thinking-elapsed').textContent,'');d.dataset.startedAt='1000';w.IexaChatActivity.finishThinking(d,30000);assert.match(d.querySelector('.thinking-elapsed').textContent,/29/);d.dataset.priorDurationMs='29000';d.dataset.startedAt='31000';w.IexaChatActivity.finishThinking(d,33000);assert.equal(d.dataset.durationMs,'31000');
});
test('actual waiting handler suppresses cancelled-turn recreation and creates no duplicate text',t=>{
 const w=setup(t);w.currentSessionId='s';w.runtimeForSession=()=>({turnStopPending:false});w.ensureAssistantMessage=()=>w.document.getElementById('msg');w.assistantFooterAnchor=()=>null;w.scrollToBottom=()=>{};loadFunctions(w,['showWaitingIndicator']);
 w.showWaitingIndicator();w.showWaitingIndicator();assert.equal(w.document.querySelectorAll('.waiting-indicator').length,1);w.document.querySelector('.waiting-indicator').remove();w.runtimeForSession=()=>({turnStopPending:true});w.showWaitingIndicator();assert.equal(w.document.querySelector('.waiting-indicator'),null);
});
test('production app integrates compact rendering for live and historical calls',()=>{
 assert.match(app,/IexaChatActivity\.updateTool\(block, tc\.name, tc\.args, tc\.result\)/);assert.match(app,/IexaChatActivity\.updateTool\(info\.block, info\.name, undefined, \{ success, fileChange, pluginUI \}\)/);
 const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');assert.ok(html.indexOf('services/ChatActivityView.js')<html.indexOf('src="app.js"'));
});

test('actual live completion handler prepares compact rows without falsely marking execution running',t=>{
 const w=setup(t),b=block(w);w.currentToolBlocks={call:{block:b,name:'file_write'}};w.setPagedText=(el,text)=>{el.textContent=text;};w.toolMeta=()=>'';w.toolLiveTitle=()=>'';w.updateTaskSummary=()=>{};w.scrollToBottom=()=>{};w.uiIcon=()=>'';
 loadFunctions(w,['handleToolComplete','setToolStepStatus']);w.handleToolComplete('call','file_write',{path:'src/fixture.ts',content:'hello'});
 assert.equal(b.querySelector('.tool-name').textContent,'fixture.ts');assert.equal(b.querySelector('.tool-meta').textContent,'src/');assert.equal(b.querySelector('.activity-operation').textContent,'写入');assert.equal(b.dataset.status,'queued');assert.equal(b.querySelector('.tool-header').tagName,'BUTTON');assert.equal(b.querySelector('.activity-diff').textContent,'');
});
