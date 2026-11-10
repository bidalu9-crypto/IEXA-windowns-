const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {JSDOM}=require('jsdom');
const {ChromiumCdpAdapter}=require('../dist/main/tools/desktop/ChromiumCdpAdapter');
const {CREATE_PAGE_SNAPSHOT}=require('../dist/main/tools/desktop/CdpPageSnapshot');
function page(t,html='<label>Reference<input id="input"></label><button id="send">Send</button>'){
 const dom=new JSDOM(html,{url:'http://127.0.0.1:1234/',runScripts:'outside-only'});t.after(()=>dom.window.close());
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({left:10,top:10,width:100,height:25});
 const state=dom.window.eval(CREATE_PAGE_SNAPSHOT)('unique-token');return {window:dom.window,state,input:dom.window.document.querySelector('input'),button:dom.window.document.querySelector('button')};
}
test('snapshot preserves DOM identity across identical replacement and never acts on the clone',t=>{
 const f=page(t);let clicked=0;const clone=f.button.cloneNode(true);clone.onclick=()=>clicked++;f.button.replaceWith(clone);
 assert.equal(f.state.valid(),true);assert.equal(f.state.valid(f.state.info.elements[1].id),false);assert.throws(()=>f.state.apply(f.state.info.elements[1].id,'click_element','',true),/stale/);assert.equal(clicked,0);
});
test('snapshot appends without erasing prior value and consumes single-use capability',t=>{
 const f=page(t);f.input.value='prefix';const snapshot=f.window.eval(CREATE_PAGE_SNAPSHOT)('new-token');let events=0;f.input.addEventListener('input',()=>events++);
 snapshot.apply(snapshot.info.elements[0].id,'type_element','-suffix',false);assert.equal(f.input.value,'prefix-suffix');assert.equal(events,1);
 assert.equal(snapshot.valid(),false);assert.throws(()=>snapshot.apply(snapshot.info.elements[0].id,'type_element','wrong',true),/stale/);assert.equal(events,1);
});
test('user value/name/href/geometry changes invalidate the affected target capability',t=>{
 for(const [id,mutate] of [['input',f=>f.input.value='user'],['send',f=>f.button.textContent='Different action'],['send',f=>f.button.setAttribute('href','/new-destination')],['send',f=>f.button.getBoundingClientRect=()=>({left:200,top:10,width:100,height:25})]]){
  const f=page(t),target=f.state.info.elements.find(e=>e.selector?.automationId===id);mutate(f);assert.equal(f.state.valid(),true);assert.equal(f.state.valid(target.id),false);
  assert.throws(()=>f.state.apply(target.id,id==='input'?'type_element':'click_element','no-input',true),/stale/);
 }
});
test('snapshot read-only and non-input elements reject value mutation without textContent fallback',t=>{
 const f=page(t,'<input id="input" readonly value="original"><button id="send">Send</button>');
 assert.throws(()=>f.state.apply(f.state.info.elements[0].id,'type_element','wrong',true),/read-only/);assert.equal(f.input.value,'original');
 assert.throws(()=>f.state.apply(f.state.info.elements[1].id,'type_element','wrong',true),/writable/);assert.equal(f.button.textContent,'Send');
});
test('document text evidence has no writable selector; passwords are redacted',t=>{
 const f=page(t,'<input type="password" value="SECRET"><button>Send</button>');
 assert.equal(f.state.info.elements[0].text,'[redacted]');assert.ok(!JSON.stringify(f.state.info).includes('SECRET'));
 assert.equal(f.state.info.elements.at(-1).selector,undefined);assert.throws(()=>f.state.apply(f.state.info.elements.at(-1).id,'type_element','overwrite',true),/absent/);
});
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
test('CDP only accepts literal loopback origin without credentials or path injection',()=>{
 for(const origin of ['http://example.test:9222','http://localhost:9222','http://user:pass@127.0.0.1:9222','http://127.0.0.1:9222/path','http://127.0.0.1:9222/?redirect=1','file:///tmp/cdp'])assert.throws(()=>new ChromiumCdpAdapter(origin),/loopback/);
 new ChromiumCdpAdapter('http://127.0.0.1:9222').close();
});
test('CDP discovery rejects HTTP redirects instead of following them',async t=>{
 let reached=0;const remote=await server(t,(req,res)=>{reached++;res.end('[]');});const endpoint=await server(t,(req,res)=>{res.writeHead(302,{location:remote+'/json/list'});res.end();});
 const adapter=new ChromiumCdpAdapter(endpoint);t.after(()=>adapter.close());const r=await adapter.execute({action:'list_windows'});assert.equal(r.success,false);assert.equal(reached,0);
});
test('multiple page targets are listed but never implicitly bound; debugger URL stays on-origin',async t=>{
 let targets;const endpoint=await server(t,(req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(targets));});
 targets=[{type:'page',id:'first',title:'Same',url:'http://fixture/'},{type:'page',id:'second',title:'Same',url:'http://fixture/'}];
 const adapter=new ChromiumCdpAdapter(endpoint);t.after(()=>adapter.close());
 assert.equal(JSON.parse((await adapter.execute({action:'list_windows'})).output).data.windows.length,2);
 const ambiguous=await adapter.execute({action:'observe'});assert.equal(ambiguous.success,false);assert.match(ambiguous.output,/ambiguous/);
 targets=[{...targets[0],webSocketDebuggerUrl:'ws://example.test/devtools/page/first'}];
 const remote=await adapter.execute({action:'observe'});assert.equal(remote.success,false);assert.match(remote.output,/loopback origin/);
});
test('pre-cancelled CDP call does not even discover pages',async t=>{
 let requests=0;const endpoint=await server(t,(req,res)=>{requests++;res.end('[]');});const adapter=new ChromiumCdpAdapter(endpoint);t.after(()=>adapter.close());
 const abort=new AbortController();abort.abort();const r=await adapter.execute({action:'list_windows'},abort.signal);assert.equal(r.cancelled,true);assert.equal(requests,0);
});

test('snapshot discovers and invokes summary, native treeitem, checkbox and custom button',t=>{
 for(const [html,id,assertEffect] of [
  ['<details><summary id="settings">设置与拓展</summary><div>Options</div></details>','settings',(w)=>assert.equal(w.document.querySelector('details').open,true)],
  ['<button id="tree" role="treeitem">src</button>','tree',(w)=>assert.equal(w.document.getElementById('tree').dataset.clicked,'yes')],
  ['<input id="check" type="checkbox">','check',(w)=>assert.equal(w.document.getElementById('check').checked,true)],
  ['<div id="custom" style="cursor:pointer">Custom</div>','custom',(w)=>assert.equal(w.document.getElementById('custom').dataset.clicked,'yes')],
 ]){
  const f=page(t,html),node=f.window.document.getElementById(id);node.onclick=()=>node.dataset.clicked='yes';
  const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('components'),element=state.info.elements.find(e=>e.selector?.automationId===id);
  assert.ok(element?.capabilities.includes('invoke'),id);if(id==='tree')assert.equal(element.role,'treeitem');if(id==='check')assert.equal(element.checked,false);
  state.apply(element.id,'click_element','',true);assertEffect(f.window);assert.equal(state.valid(),false);
 }
});

test('native select applies exact option and rejects disabled or duplicate labels without mutation',t=>{
 const f=page(t,'<select id="model"><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Disabled</option><option value="d">Same</option><option value="e">Same</option></select>');
 const select=f.window.document.querySelector('select');let changes=0;select.addEventListener('change',()=>changes++);
 for(const [text,options] of [['Disabled',{}],['Same',{}],['',{value:'absent'}]])assert.throws(()=>f.state.apply(f.state.info.elements[0].id,'select_option',text,true,options),/absent|disabled|ambiguous/);
 assert.equal(select.value,'a');assert.equal(changes,0);assert.equal(f.state.valid(),true);
 const result=f.state.apply(f.state.info.elements[0].id,'select_option','Beta',true,{});assert.equal(select.value,'b');assert.equal(changes,1);assert.equal(result.inputMechanism,'cdp-dom');
});

test('range uses real min/max/step and rejects value drift',t=>{
 const f=page(t,'<input id="range" type="range" min="10" max="30" step="5" value="15">');
 const id=f.state.info.elements[0].id;
 for(const value of ['9','31','12','NaN'])assert.throws(()=>f.state.apply(id,'set_value','',true,{value}),/min\/max\/step/);
 f.state.apply(id,'set_value','',true,{value:25});assert.equal(f.input.value,'25');
 const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('range-new');f.input.value='20';assert.equal(state.valid(state.info.elements[0].id),false);assert.throws(()=>state.apply(state.info.elements[0].id,'set_value','',true,{value:25}),/stale/);
});

test('scroll is scoped to the actual observed scroll region and consumes capability',t=>{
 const f=page(t,'<div id="scroll" style="overflow-y:auto"><button>Item</button></div>'),node=f.window.document.getElementById('scroll');
 Object.defineProperties(node,{scrollHeight:{value:800},clientHeight:{value:80}});let scrolled;
 node.scrollBy=options=>{scrolled=options;node.scrollTop+=options.top;};
 const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('scroll'),element=state.info.elements.find(e=>e.selector?.automationId==='scroll');
 assert.ok(element.capabilities.includes('scroll'));state.apply(element.id,'scroll','',true,{deltaY:120});assert.equal(node.scrollTop,120);assert.equal(scrolled.top,120);assert.equal(state.valid(),false);
});

test('renderer preparation focuses editor DOM input and rejects covered pointer targets',t=>{
 const f=page(t,'<div id="editor" class="monaco-editor"><textarea></textarea></div><button id="cover">Cover</button>');
 let modelWrites=0;f.window.monaco={editor:{getModels:()=>{modelWrites++;return [];}}};
 const editor=f.state.info.elements.find(e=>e.selector?.automationId==='editor');
 assert.ok(editor.capabilities.includes('textInput'));f.state.prepare(editor.id,'textInput');assert.equal(f.window.document.activeElement.tagName,'TEXTAREA');assert.equal(modelWrites,0);
 const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('pointer');f.window.document.elementFromPoint=()=>f.window.document.getElementById('cover');
 const target=state.info.elements.find(e=>e.selector?.automationId==='editor');assert.throws(()=>state.prepare(target.id,'rendererPointer',{x:20,y:20}),/covered/);assert.equal(state.valid(),true);
});

function mockedRenderer(t,capabilities=['keyInput','textInput','rendererPointer']){
 const adapter=new ChromiumCdpAdapter('http://127.0.0.1:9222');t.after(()=>adapter.close());
 const target={id:'renderer',type:'page',title:'IEXA',url:'http://fixture/'};
 const element={id:'node',role:'code',text:'Editor',enabled:true,focused:true,selector:{automationId:'editor'},capabilities,bounds:{left:10,top:10,width:100,height:100}};
 const calls=[],commands=[];adapter.targets=async()=>[target];adapter.connect=async()=>{adapter.target=target;};adapter.valid=async()=>true;
 adapter.socket={close(){},send(){},addEventListener(){}};
 adapter.snapshot={targetId:target.id,handle:-10,token:'token',objectId:'remote',capturedAt:Date.now(),info:{title:'IEXA',url:target.url,elements:[element],width:800,height:600},frame:Buffer.alloc(24),valid:true};
 adapter.call=async(object,fn,args)=>{calls.push({fn,args});return fn.includes('this.paste')?{method:'cdp_editor_paste',inputMechanism:'cdp-dom-paste',eventConsumed:true}:{bounds:element.bounds,width:800,height:600,editorPaste:element.role==='code'};};
 adapter.command=async(method,params,signal)=>{commands.push({method,params});if(signal?.aborted)throw new Error('cancelled');return {};};
 return {adapter,calls,commands,element,run:args=>adapter.execute({background:true,observationToken:'token',elementId:'node',...args})};
}

test('Monaco insertion uses its paste handler with optional keyboard replacement',async t=>{
 const f=mockedRenderer(t);const result=await f.run({action:'insert_text',text:'typed through renderer',replace:true});
 assert.equal(result.success,true,result.output);assert.equal(JSON.parse(result.output).data.inputMechanism,'cdp-dom-paste');
 assert.ok(f.calls[0].fn.includes('prepare'));assert.equal(f.calls[0].args[1],'textInput');
 assert.deepEqual(f.calls.find(c=>c.fn.includes('this.paste')).args,['node','typed through renderer']);
 assert.ok(f.commands.some(c=>c.method==='Input.dispatchKeyEvent'&&c.params.key==='a'&&c.params.modifiers===2));
 assert.equal(f.commands.some(c=>/Runtime\.evaluate/.test(c.method)),false);
});

test('bulk editor text uses paste while single characters keep ordinary typing',async t=>{
 for(const text of ['<h1>中文</h1>\n', '<', '']) {
  const f=mockedRenderer(t); const result=await f.run({action:'insert_text',text}); assert.equal(result.success,true,result.output);
  const input=f.commands.filter(c=>c.method.startsWith('Input.'));
  assert.deepEqual(input.map(c=>c.method),text.length>1?[]:['Input.insertText']);
  if(text.length>1)assert.deepEqual(f.calls.at(-1).args,['node',text]);
 }
});

test('failed editor paste is not retried or followed by a second text insertion',async t=>{
 const f=mockedRenderer(t);const call=f.adapter.call;f.adapter.call=async(object,fn,args)=>{const result=await call(object,fn,args);if(fn.includes('this.paste'))throw Error('Paste transport failure');return result;};
 const result=await f.run({action:'insert_text',text:'<h1>failure</h1>\n'});
 assert.equal(result.success,false);assert.match(result.output,/Paste transport failure/);
 assert.equal(f.calls.filter(c=>c.fn.includes('this.paste')).length,1);
 assert.equal(f.commands.some(c=>c.method==='Input.insertText'),false);
});

test('prepared editor paste is single-use and rejects replacement, focus loss and navigation',t=>{
 for(const change of ['none','replace','focus','navigate']) {
  const f=page(t,'<div id="editor" role="code" class="monaco-editor"><textarea></textarea></div><input id="other">');
  const w=f.window;w.DataTransfer=class{setData(type,value){this[type]=value;}};
  w.ClipboardEvent=class extends w.Event{constructor(type,options){super(type,options);this.clipboardData=options.clipboardData;}};
  const input=w.document.querySelector('textarea'),node=f.state.info.elements.find(e=>e.selector.automationId==='editor');let pasted=[];
  input.addEventListener('paste',event=>{event.preventDefault();pasted.push(event.clipboardData['text/plain']);});
  assert.equal(f.state.prepare(node.id,'textInput').editorPaste,true);
  if(change==='replace')input.replaceWith(input.cloneNode());
  if(change==='focus')w.document.querySelector('#other').focus();
  if(change==='navigate')w.history.replaceState({},'','/changed');
  if(change==='none'){assert.equal(f.state.paste(node.id,'<h1>文本</h1>').eventConsumed,true);assert.deepEqual(pasted,['<h1>文本</h1>']);}
  else {assert.throws(()=>f.state.paste(node.id,'WRONG'),/stale|focused/);assert.equal(pasted.length,0);}
  assert.throws(()=>f.state.paste(node.id,'REPLAY'),/stale|focused/);
 }
});

test('ordinary contenteditable bulk input keeps the browser input path',async t=>{
 const f=mockedRenderer(t);f.element.role='edit';const result=await f.run({action:'insert_text',text:'ordinary content'});
 assert.equal(result.success,true,result.output);assert.equal(f.calls.some(c=>c.fn.includes('this.paste')),false);
 assert.equal(f.commands.filter(c=>c.method==='Input.insertText').length,1);
});

test('targetless ESC requires a currently observed focused node and uses CDP keyboard',async t=>{
 const f=mockedRenderer(t);const result=await f.run({action:'key',elementId:undefined,key:'ESC'});
 assert.equal(result.success,true,result.output);assert.deepEqual(f.commands.map(c=>c.params.type),['rawKeyDown','keyUp']);assert.equal(f.commands[0].params.key,'Escape');
 const unfocused=mockedRenderer(t);unfocused.element.focused=false;
 const rejected=await unfocused.run({action:'key',elementId:undefined,key:'ESC'});assert.equal(rejected.success,false);assert.equal(unfocused.commands.length,0);
});

test('renderer drag releases mouse on interruption and never retries input',async t=>{
 const f=mockedRenderer(t);let moves=0;const original=f.adapter.command;
 f.adapter.command=async(method,params,signal)=>{const result=await original(method,params,signal);if(params.type==='mouseMoved'&&++moves===2)throw new Error('renderer interrupted');return result;};
 const result=await f.run({action:'drag',relativeX:20,relativeY:20,toRelativeX:180,toRelativeY:60});
 assert.equal(result.success,false);assert.equal(f.commands.filter(c=>c.params.type==='mousePressed').length,1);assert.equal(f.commands.at(-1).params.type,'mouseReleased');
});

test('renderer close hotkey fails before event dispatch unless explicitly allowed',async t=>{
 const f=mockedRenderer(t);const result=await f.run({action:'hotkey',keys:['ALT','F4']});assert.equal(result.success,false);assert.match(result.output,/allowClose/);assert.equal(f.commands.length,0);
});

test('right click uses renderer mouse events against the validated observed target',async t=>{
 const f=mockedRenderer(t);const result=await f.run({action:'click_element',button:'right'});
 assert.equal(result.success,true,result.output);assert.equal(JSON.parse(result.output).data.inputMechanism,'cdp-renderer');
 assert.ok(f.calls[0].fn.includes('prepare'));assert.deepEqual(f.commands.filter(c=>c.params.type!=='mouseMoved').map(c=>[c.params.type,c.params.button]),[['mousePressed','right'],['mouseReleased','right']]);
});

test('ordinary left click of an input surface uses validated renderer pointer to focus',async t=>{
 const f=mockedRenderer(t,['keyInput','textValue','rendererPointer']);f.element.role='edit';
 const result=await f.run({action:'click_element'});assert.equal(result.success,true,result.output);
 assert.equal(JSON.parse(result.output).data.inputMechanism,'cdp-renderer');assert.deepEqual(f.commands.filter(c=>c.params.type!=='mouseMoved').map(c=>[c.params.type,c.params.button]),[['mousePressed','left'],['mouseReleased','left']]);
});

test('bounded generic discovery includes pointer spans and delegated action attributes',t=>{
 const f=page(t,'<span id="title" class="session-item-title" style="cursor:pointer">Session title</span><span id="rename" data-ui-action="rename-session">Rename</span><span id="git" class="git-file-path" style="cursor:pointer">src/main.ts</span><span id="delegated" data-action="open">Open</span><span id="plain">Static</span>');
 for(const id of ['title','rename','git','delegated']){
  const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('span-'+id),element=state.info.elements.find(e=>e.selector?.automationId===id);
  assert.ok(element,id);assert.ok(element.capabilities.includes('invoke'),id);let invoked=0;f.window.document.getElementById(id).addEventListener('click',()=>invoked++);
  state.apply(element.id,'click_element','',true);assert.equal(invoked,1,id);
 }
 assert.equal(f.state.info.elements.some(e=>e.selector?.automationId==='plain'),false);
 const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('action-drift'),target=state.info.elements.find(e=>e.selector?.automationId==='rename');f.window.document.getElementById('rename').dataset.uiAction='delete-session';assert.equal(state.valid(target.id),false);assert.throws(()=>state.apply(target.id,'click_element','',true),/stale/);
});

test('explicit rendererInput click sends real left mouse events even for semantic buttons',async t=>{
 const f=mockedRenderer(t,['invoke','keyInput','rendererPointer']);f.element.role='button';
 const result=await f.run({action:'click_element',rendererInput:true});assert.equal(result.success,true,result.output);assert.equal(JSON.parse(result.output).data.inputMechanism,'cdp-renderer');
 assert.ok(f.calls[0].fn.includes('prepare'));assert.deepEqual(f.commands.filter(c=>c.params.type!=='mouseMoved').map(c=>c.params.type),['mousePressed','mouseReleased']);
 const normal=mockedRenderer(t,['invoke','keyInput','rendererPointer']);const dom=await normal.run({action:'click_element'});assert.equal(dom.success,true,dom.output);assert.ok(normal.calls[0].fn.includes('apply'));assert.equal(normal.commands.length,0);
});

test('rendererInput rejects malformed flags and non-click actions before renderer events',async t=>{
 for(const args of [{action:'click_element',rendererInput:'true'},{action:'key',key:'ESC',rendererInput:true}]){
  const f=mockedRenderer(t);const result=await f.run(args);assert.equal(result.success,false);assert.match(result.output,/rendererInput/);assert.equal(f.commands.length,0);
 }
});

test('native disclosure/button captions and decorative SVG are not duplicate click capabilities',t=>{
 const f=page(t,'<details><summary id="more" style="cursor:pointer"><svg id="icon" style="cursor:pointer" aria-hidden="true"><path id="path" style="cursor:pointer" d="M0 0"></path></svg><span id="caption" style="cursor:pointer">设置与拓展</span></summary></details><button id="action" style="cursor:pointer"><span id="button-caption" style="cursor:pointer">Action</span></button><label id="label" for="enabled" style="cursor:pointer"><input id="enabled" type="checkbox"><span id="check-caption" style="cursor:pointer">Enabled</span></label>');
 f.window.SVGElement.prototype.getBoundingClientRect=()=>({left:10,top:10,width:20,height:20});
 const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('decorated'),ids=state.info.elements.map(e=>e.selector?.automationId);
 for(const id of ['more','action','label','enabled'])assert.ok(ids.includes(id),id);
 for(const id of ['icon','path','caption','button-caption','check-caption'])assert.equal(ids.includes(id),false,id);
 assert.equal(state.info.elements.filter(e=>e.selector?.name==='设置与拓展').length,1);
});

test('independent span actions survive decorated-ancestor filtering while inherited duplicates do not',t=>{
 const f=page(t,'<div id="session" data-ui-action="switchSession" style="cursor:pointer"><span id="rename" data-ui-action="startRename" style="cursor:pointer">Session</span><span id="time" style="cursor:pointer">Yesterday</span></div><div id="git-row" style="cursor:pointer"><span id="git-path" title="note.txt" style="cursor:pointer">note.txt</span></div><div id="duplicate-parent" style="cursor:pointer"><span id="duplicate" style="cursor:pointer">Duplicate</span></div>');
 const row=f.window.document.getElementById('git-row');row.getBoundingClientRect=()=>({left:10,top:10,width:300,height:35});
 const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('distinct'),ids=state.info.elements.map(e=>e.selector?.automationId);
 for(const id of ['session','rename','git-row','git-path','duplicate-parent'])assert.ok(ids.includes(id),id);
 for(const id of ['time','duplicate'])assert.equal(ids.includes(id),false,id);
 let renamed=0;f.window.document.getElementById('rename').addEventListener('click',()=>renamed++);
 state.apply(state.info.elements.find(e=>e.selector?.automationId==='rename').id,'click_element','',true);assert.equal(renamed,1);
});

test('unrelated processing timers, streaming text and other control changes leave a stable target usable',t=>{
 const f=page(t,'<div id="timer">处理 1 秒</div><div id="stream">First token</div><input id="other" value="old"><button id="send">Stable choice</button><button id="changing">Other 1</button>');
 let displayedText='处理 1 秒 First token';Object.defineProperty(f.window.document.body,'innerText',{configurable:true,get:()=>displayedText});
 const state=f.window.eval(CREATE_PAGE_SNAPSHOT)('dynamic'),target=state.info.elements.find(e=>e.selector?.automationId==='send');let clicked=0;f.button.onclick=()=>clicked++;
 // Assign the handler before the observed state: onclick itself is an action.
 const observed=f.window.eval(CREATE_PAGE_SNAPSHOT)('dynamic-handler'),id=observed.info.elements.find(e=>e.selector?.automationId==='send').id;
 let unrelatedGeometryReads=0;const unrelated=f.window.document.getElementById('changing');unrelated.getBoundingClientRect=()=>{unrelatedGeometryReads++;return {left:10,top:10,width:100,height:25};};
 for(let tick=2;tick<=5;tick++){
  displayedText='处理 '+tick+' 秒 '+('streaming '.repeat(tick));f.window.document.getElementById('timer').textContent='处理 '+tick+' 秒';f.window.document.getElementById('stream').textContent='streaming '.repeat(tick);
  f.input.value='changed '+tick;unrelated.textContent='Other '+tick;
  assert.equal(observed.valid(),true);assert.equal(observed.valid(id),true);
 }
 assert.equal(unrelatedGeometryReads,0,'Freshness only reads the actual input target, not every other control');
 observed.apply(id,'click_element','',true);assert.equal(clicked,1);assert.equal(observed.valid(),false);assert.ok(target);
});

test('target disabled, hidden, detached, changed delegated arguments and geometry still reject input',t=>{
 for(const mutate of [
  e=>e.disabled=true,e=>e.hidden=true,e=>e.remove(),e=>e.dataset.uiArg='different-session',e=>e.dataset.path='different-file',
  e=>e.getBoundingClientRect=()=>({left:40,top:10,width:100,height:25}),e=>e.textContent='Changed choice',e=>e.onclick=()=>{},
 ]){
  const f=page(t,'<button id="send" data-ui-action="choose" data-ui-arg="original-session" data-path="original-file">Choice</button>');let clicked=0;f.button.addEventListener('click',()=>clicked++);const id=f.state.info.elements[0].id;
  mutate(f.button);assert.equal(f.state.valid(),true);assert.equal(f.state.valid(id),false);assert.throws(()=>f.state.apply(id,'click_element','',true),/stale|disabled/);assert.equal(clicked,0);
 }
});

test('new overlay prevents semantic click as well as renderer pointer input',t=>{
 const f=page(t,'<button id="send">Choice</button><div id="overlay">Overlay</div>');let clicked=0;f.button.addEventListener('click',()=>clicked++);
 f.window.document.elementFromPoint=()=>f.window.document.getElementById('overlay');
 const id=f.state.info.elements[0].id;assert.equal(f.state.valid(id),true);
 assert.throws(()=>f.state.apply(id,'click_element','',true),/covered/);assert.throws(()=>f.state.prepare(id,'rendererPointer',{x:20,y:20}),/covered/);assert.equal(clicked,0);
});

test('editor auxiliary input replacement is rejected even while its outer surface remains',t=>{
 const f=page(t,'<div id="editor" class="monaco-editor"><textarea>original</textarea></div>'),id=f.state.info.elements.find(e=>e.selector?.automationId==='editor').id;
 const input=f.window.document.querySelector('textarea');input.replaceWith(input.cloneNode(true));
 assert.throws(()=>f.state.prepare(id,'textInput'),/stale/);assert.notEqual(f.window.document.activeElement.tagName,'TEXTAREA');
});

test('unlabelled editor and page keyboard targets do not name themselves after live output',t=>{
 const f=page(t,'<div id="terminal" class="xterm"><textarea></textarea><div id="output">first line</div></div><div id="timer">1 sec</div>');
 const terminal=f.state.info.elements.find(e=>e.selector?.automationId==='terminal'),body=f.state.info.elements.find(e=>e.selector?.name==='Page keyboard');
 assert.ok(terminal);assert.equal(terminal.selector.name,'Terminal');assert.ok(body);
 f.window.document.getElementById('output').textContent='more live terminal output';f.window.document.getElementById('timer').textContent='2 sec';
 assert.equal(f.state.valid(terminal.id),true);assert.equal(f.state.valid(body.id),true);
});

test('document navigation and viewport changes revoke the whole observation context',t=>{
 for(const mutate of [w=>w.history.replaceState(null,'','/different'),w=>Object.defineProperty(w,'innerWidth',{value:800,configurable:true})]){
  const f=page(t);mutate(f.window);assert.equal(f.state.valid(),false);assert.throws(()=>f.state.apply(f.state.info.elements[1].id,'click_element','',true),/document or viewport/);
 }
});

test('CDP screenshot capture tolerates unrelated live text but still rejects a target changed during capture',async t=>{
 for(const changeTarget of [false,true]){
  const f=page(t,'<div id="timer">1 sec</div><button id="send">Stable choice</button>');let clicked=0;f.button.addEventListener('click',()=>clicked++);
  const adapter=new ChromiumCdpAdapter('http://127.0.0.1:9222');t.after(()=>adapter.close());const target={id:'live',type:'page',title:'IEXA',url:'http://fixture/'};
  const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(800,16);png.writeUInt32BE(600,20);
  adapter.targets=async()=>[target];adapter.connect=async()=>{adapter.target=target;};
  adapter.call=async(object,fn,args)=>f.window.eval('('+fn+')').apply(f.state,args);
  adapter.command=async(method)=>{
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};
   if(method==='Page.createIsolatedWorld')return {executionContextId:1};
   if(method==='Runtime.evaluate')return {result:{objectId:'snapshot'}};
   if(method==='Page.captureScreenshot'){
    f.window.document.getElementById('timer').textContent='2 seconds of live processing';Object.defineProperty(f.window.document.body,'innerText',{value:'different streaming text',configurable:true});
    if(changeTarget)f.button.disabled=true;return {data:png.toString('base64')};
   }
   return {};
  };
  const observed=await adapter.execute({action:'observe'});assert.equal(observed.success,true,observed.output);const data=JSON.parse(observed.output).data;
  const state=await adapter.execute({action:'session_state'});assert.equal(JSON.parse(state.output).data.geometryChanged,false);
  const action=await adapter.execute({action:'click_element',background:true,observationToken:data.session.observationToken,elementId:f.state.info.elements.find(e=>e.selector?.automationId==='send').id});
  assert.equal(action.success,!changeTarget,action.output);assert.equal(clicked,changeTarget?0:1);if(changeTarget)assert.match(action.output,/stale|disabled/);
 }
});
