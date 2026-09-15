const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const { JSDOM } = require('jsdom');
const { TranscriptRecorder } = require('../dist/main/session/TranscriptRecorder');
const pause = () => new Promise(r => setTimeout(r, 10));
function fixture(t, customFetch) {
 const dom = new JSDOM('<textarea id="chatInput"></textarea><aside id="panel"></aside>', {url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}); const w=dom.window;
 for(const file of ['vendor/marked.umd.js','vendor/highlight.min.js','vendor/purify.min.js','services/SafeMarkdown.js']) w.eval(fs.readFileSync(path.join(__dirname,'../src/renderer',file),'utf8'));
 for(const script of ['ChatActivityView','TranscriptView','SubAgentView']) w.eval(fs.readFileSync(path.join(__dirname,`../src/renderer/services/${script}.js`),'utf8'));
 const r=new TranscriptRecorder();r.recordText('先说正文');r.recordThinking('再思考');r.recordTool('tool','file_read');r.recordText('先说正文然后总结');r.finish('completed');
 let record={id:'a',rootSessionId:'s',parentId:'s',nickname:'审查代理<script>bad()</script>',model:'fixture',status:'running',revision:1,depth:1,prompt:'审查任务',output:'结果',pendingCount:0,messages:[{role:'user',content:'审查'}, {role:'assistant',content:'先说正文然后总结',thinking:'再思考',toolCalls:[{id:'tool',name:'file_read',args:{path:'fixture'},result:{success:true,output:'文件结果'}}],transcript:r.snapshot()}]};
 const calls=[]; const fetcher=async(url,init)=>{calls.push({url,init});if(customFetch)return customFetch(url,init,record);if(init){if(url.includes('/close'))record={...record,status:'closed',revision:record.revision+1};if(url.includes('/resume'))record={...record,status:'idle',revision:record.revision+1};return {ok:true,json:async()=>({ok:true})};}return {ok:true,json:async()=>url.includes('/a?')?{agent:record}:{agents:[record]}};};
 const view=w.IexaSubAgentView.create(w.document.getElementById('panel'),{fetch:fetcher});t.after(()=>{view.dispose();w.close();});return {w,view,calls,get record(){return record;},set record(value){record=value;}};
}
test('sub-agent panel renders inert names and actual ordered body/thinking/tool segments', async t=>{
 const {w,view}=fixture(t);view.session('s');await pause();assert.equal(w.document.getElementById('panel').hidden,false);w.document.querySelector('.subagent-toggle').click();await pause();
 assert.equal(w.document.querySelectorAll('script').length,0);assert.match(w.document.querySelector('.subagent-name').textContent,/<script>/);
 const message=w.document.querySelectorAll('.subagent-message')[1];assert.deepEqual([...message.children].map(n=>n.classList.contains('subagent-text')?'text':n.classList.contains('subagent-thought')?'thinking':'tool'),['text','thinking','tool','text']);
 assert.match(w.document.querySelector('.subagent-info').textContent,/共享项目目录（非 worktree）/);
 assert.equal(w.document.querySelector('.subagent-toggle').getAttribute('aria-expanded'),'true');
});
test('send, interrupt, close and resume use real scoped routes with errors visible', async t=>{
 const {w,view,calls}=fixture(t);view.session('s');await pause();w.document.querySelector('.subagent-toggle').click();await pause();
 w.document.querySelector('.subagent-input textarea').value='新任务';w.document.querySelector('input[type=checkbox]').checked=true;
 w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await pause();
 const sent=calls.find(c=>c.url.includes('/send'));assert.deepEqual(JSON.parse(sent.init.body),{message:'新任务',interrupt:true});assert.match(sent.url,/sessionId=s/);assert.equal(w.document.querySelector('.subagent-input textarea').value,'');
 w.document.querySelector('.subagent-close-agent').click();await pause();assert.equal(w.document.querySelector('.subagent-input textarea').disabled,true);
 w.document.querySelector('.subagent-resume-agent').click();await pause();assert.equal(w.document.querySelector('.subagent-input textarea').disabled,false);
});
test('older SSE revisions and old-session HTTP responses cannot overwrite current child UI',async t=>{
 let resolve;const gate=new Promise(r=>resolve=r);
 const f=fixture(t,async url=>{if(url.endsWith('sessionId=old'))return gate;return {ok:true,json:async()=>({agents:[]})};});
 f.view.session('old');f.view.session('s');await pause();f.view.event({sessionId:'s',agent:f.record});
 f.view.event({sessionId:'s',agent:{...f.record,revision:0,status:'failed'}});assert.equal(f.w.document.querySelector('.subagent-status').textContent,'运行中');
 resolve({ok:true,json:async()=>({agents:[{...f.record,rootSessionId:'old',nickname:'stale'}]})});await pause();assert.doesNotMatch(f.w.document.querySelector('.subagent-name').textContent,/stale/);
});
test('failed send keeps draft and exposes error; menu can be operated via native buttons',async t=>{
 const f=fixture(t,async(url,init,record)=>({ok:!init,status:init?400:200,json:async()=>init?{error:'子代理已关闭'}:url.includes('/a?')?{agent:record}:{agents:[record]}}));
 f.view.session('s');await pause();f.w.document.querySelector('.subagent-toggle').click();await pause();const input=f.w.document.querySelector('.subagent-input textarea');input.value='不要丢失';f.w.document.querySelector('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await pause();assert.equal(input.value,'不要丢失');assert.match(f.w.document.querySelector('.subagent-feedback').textContent,/子代理已关闭/);
});

test('actual tool result links open the matching child without interpreting result text as HTML', async t=>{
 const f=fixture(t);f.view.session('s');await pause();f.w.eval(fs.readFileSync(path.join(__dirname,'../src/renderer/services/ChatActivityView.js'),'utf8'));
 const block=f.w.document.createElement('div');block.className='tool-block';block.innerHTML='<div class="tool-header"><span class="tool-heading"><span class="tool-name"></span><span class="tool-meta"></span></span><span class="tool-status"></span></div><div class="tool-body"><pre class="tool-args"></pre><pre class="tool-result"></pre></div>';f.w.document.body.appendChild(block);
 const result={success:true,output:JSON.stringify({id:'a',nickname:'<b>Agent</b>'})};f.w.IexaChatActivity.updateTool(block,'spawn_agent',{message:'任务'},result);f.w.IexaChatActivity.updateTool(block,'spawn_agent',{message:'任务'},result);
 assert.equal(block.querySelectorAll('.tool-agent-link').length,1);assert.equal(block.querySelector('.tool-agent-link b'),null);
 f.w.addEventListener('iexa:open-subagent',event=>void f.view.open(event.detail.id));block.querySelector('.tool-agent-link').click();await pause();assert.equal(f.w.document.querySelector('.subagent-body').hidden,false);assert.equal(f.w.document.querySelector('.subagent-row').getAttribute('aria-pressed'),'true');
});

test('all terminal and idle-only records hide the composer dock on reload, but remain inspectable from history',async t=>{
 for(const status of ['completed','failed','cancelled','closed','interrupted','idle']){
  const f=fixture(t);f.record={...f.record,status};f.view.session('s');await pause();assert.equal(f.w.document.getElementById('panel').hidden,true,status);
  await f.view.open('a');assert.equal(f.w.document.querySelector('dialog').open,true);assert.equal(f.w.document.getElementById('panel').hidden,true);assert.equal(f.w.document.querySelector('dialog').parentNode,f.w.document.body);
  if(status==='closed'||status==='interrupted') {assert.equal(f.w.document.querySelector('form').hidden,true);assert.equal(f.w.document.querySelector('.subagent-resume-agent').hidden,false);}
 }
});
test('live completion hides the dock; active siblings and approval/cancellation keep it until genuinely terminal',async t=>{
 const f=fixture(t);f.view.session('s');await pause();
 const emit=(id,status,revision)=>f.view.event({sessionId:'s',agent:{...f.record,id,status,revision}});
 emit('b','awaiting_approval',1);emit('a','completed',2);assert.equal(f.w.document.getElementById('panel').hidden,false);assert.match(f.w.document.querySelector('.subagent-count').textContent,/1 个进行中/);
 emit('b','cancelling',2);assert.equal(f.w.document.getElementById('panel').hidden,false);
 emit('b','cancelled',3);assert.equal(f.w.document.getElementById('panel').hidden,true);
 emit('a','running',1);assert.equal(f.w.document.getElementById('panel').hidden,true,'stale event must not resurrect dock');
 emit('a','queued',3);assert.equal(f.w.document.getElementById('panel').hidden,false,'new task resumes visibility');
});
test('Markdown is rendered and sanitized; command/output use the same Shell surface as main chat',async t=>{
 const f=fixture(t);f.record={...f.record,status:'closed',messages:[{role:'assistant',content:'**命令结果**\n\n```text\nsubagent-ok 42\n```\n<script>bad()</script><img src=x onerror="bad()">',toolCalls:[{id:'cmd',name:'shell_execute',args:{command:'echo subagent-ok 42'},result:{success:true,output:'subagent-ok 42'}}]}]};
 f.view.session('s');await pause();await f.view.open('a');
 assert.equal(f.w.document.querySelector('.subagent-text strong').textContent,'命令结果');assert.match(f.w.document.querySelector('.subagent-text pre code').textContent,/subagent-ok 42/);
 assert.equal(f.w.document.querySelector('script,[onerror]'),null);assert.equal(f.w.document.querySelector('.subagent-text').textContent.includes('```'),false);
 assert.equal(f.w.document.querySelector('.tool-detail-title').textContent,'Shell');assert.equal(f.w.document.querySelector('.tool-command').textContent,'$ echo subagent-ok 42');
 assert.equal(f.w.document.querySelector('.tool-raw-input').hidden,true);assert.equal(f.w.document.querySelector('form').hidden,true);
});
test('details close without closing the agent; session changes dismiss and retain no stale inspector',async t=>{
 const f=fixture(t);f.view.session('s');await pause();await f.view.open('a');f.w.document.querySelector('.subagent-dismiss').click();assert.equal(f.w.document.querySelector('dialog').open,false);assert.equal(f.calls.some(c=>c.init),false);
 await f.view.open('a');f.view.session('other');assert.equal(f.w.document.querySelector('dialog').open,false);assert.equal(f.w.document.querySelector('.subagent-history').textContent,'');
});
test('closed historical records never show an inactive input form and switching agents does not leak drafts',async t=>{
 const f=fixture(t);f.view.session('s');await pause();await f.view.open('a');f.w.document.querySelector('.subagent-input textarea').value='仅给 A 的草稿';
 f.record={...f.record,id:'b',status:'closed',revision:1};f.view.event({sessionId:'s',agent:f.record});await f.view.open('b');
 assert.equal(f.w.document.querySelector('.subagent-input textarea').value,'');assert.equal(f.w.document.querySelector('form').hidden,true);
});
test('details preserve expanded reasoning and tool state across updates without changing event order',async t=>{
 const f=fixture(t);f.view.session('s');await pause();await f.view.open('a');f.w.document.querySelector('.subagent-thought').open=true;f.w.document.querySelector('.tool-header').click();
 f.record={...f.record,revision:2};await f.view.refresh();
 assert.equal(f.w.document.querySelector('.subagent-thought').open,true);assert.equal(f.w.document.querySelector('.tool-header').getAttribute('aria-expanded'),'true');
 assert.equal(f.w.document.querySelector('.subagent-message.is-assistant').dataset.transcriptState,'ordered');
});

test('only the current live reasoning segment shimmers; historical and tool-followed reasoning are settled',async t=>{
 const f=fixture(t);const live=new TranscriptRecorder();live.recordThinking('正在核查');
 f.record={...f.record,messages:[{role:'assistant',content:'',thinking:'正在核查',toolCalls:[],transcript:live.snapshot()}]};f.view.session('s');await pause();await f.view.open('a');
 assert.equal(f.w.document.querySelector('.thinking-block').classList.contains('is-complete'),false);assert.equal(f.w.document.querySelector('.thinking-content').textContent.trim(),'正在核查');
 live.recordTool('next','file_read');f.record={...f.record,revision:2,messages:[{...f.record.messages[0],toolCalls:[{id:'next',name:'file_read',args:{path:'fixture'},executionStatus:'running'}],transcript:live.snapshot()}]};await f.view.refresh();
 assert.equal(f.w.document.querySelector('.thinking-block').classList.contains('is-complete'),true);assert.equal(f.w.document.querySelector('.tool-block').dataset.executionStatus,'running');
 live.finish('cancelled');f.record={...f.record,revision:3,status:'cancelled',messages:[{...f.record.messages[0],transcript:live.snapshot()}]};await f.view.refresh();assert.equal(f.w.document.querySelector('.tool-block').dataset.executionStatus,'interrupted');
});
