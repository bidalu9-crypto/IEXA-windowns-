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
 assert.equal(f.state.valid(),false);assert.throws(()=>f.state.apply(f.state.info.elements[1].id,'click_element','',true),/stale/);assert.equal(clicked,0);
});
test('snapshot appends without erasing prior value and consumes single-use capability',t=>{
 const f=page(t);f.input.value='prefix';const snapshot=f.window.eval(CREATE_PAGE_SNAPSHOT)('new-token');let events=0;f.input.addEventListener('input',()=>events++);
 snapshot.apply(snapshot.info.elements[0].id,'type_element','-suffix',false);assert.equal(f.input.value,'prefix-suffix');assert.equal(events,1);
 assert.equal(snapshot.valid(),false);assert.throws(()=>snapshot.apply(snapshot.info.elements[0].id,'type_element','wrong',true),/stale/);assert.equal(events,1);
});
test('user value/name/href/geometry changes invalidate stale capabilities',t=>{
 for(const mutate of [f=>f.input.value='user',f=>f.button.textContent='Different action',f=>f.button.setAttribute('href','/new-destination'),f=>f.button.getBoundingClientRect=()=>({left:200,top:10,width:100,height:25})]){
  const f=page(t);mutate(f);assert.equal(f.state.valid(),false);
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
