const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopControlSession } = require('../dist/main/tools/desktop/DesktopControlSession');
const { DesktopControlScheduler } = require('../dist/main/tools/desktop/DesktopControlScheduler');
const { resolveDesktopTarget } = require('../dist/main/tools/desktop/DesktopTargetResolver');
const { DesktopAdapterRegistry } = require('../dist/main/tools/desktop/DesktopBackgroundAdapter');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function fixture(options = {}) {
  const calls = []; let token = 0, handle = 10, foreground = true;
  const elements = [{ id: 'save', role: 'button', text: 'Save', enabled: true, selector: { automationId: 'saveButton' } }, { id: 'edit', role: 'edit', text: 'Hello', enabled: true }];
  const transport = async (args, signal) => {
    calls.push(args);
    if (options.transport) { const result = await options.transport(args, signal); if (result) return result; }
    let data = {};
    if (args.action === 'observe') { handle = args.handle || handle; token++; data = { session: { handle, foreground, observationToken: `t${token}` }, elements, frame: { hash: `f${token}` } }; }
    if (args.action === 'list_windows') data = { windows: [{ handle, pid: 1, title: 'fixture', process: 'fixture' }] };
    if (args.action === 'session_state') data = { handle, foreground, observationToken: `t${token}` };
    if (args.action === 'activate') { handle = args.handle; foreground = true; data = { window: { handle } }; }
    return { output: JSON.stringify({ ok: true, action: args.action, data }), success: true };
  };
  const session = new DesktopControlSession(transport, options.scheduler || new DesktopControlScheduler(), options.journalDir);
  return { session, calls, elements, transport, focus: value => foreground = value, bind: value => handle = value, run: (args, owner = 'a', signal) => session.execute(args, signal, { owner }) };
}
test('desktop target matching rejects ambiguity, disabled controls and unknown fields', () => {
 const a = { id: 'a', text: 'Save', role: 'button', selector: { automationId: 'a' } };
 assert.equal(resolveDesktopTarget({ automationId: 'a' }, [a]).id, 'a');
 assert.throws(() => resolveDesktopTarget({ name: 'Save' }, [a, { ...a, id: 'b' }]), /ambiguous/);
 assert.throws(() => resolveDesktopTarget({ name: 'Save' }, [{ ...a, enabled: false }]), /not found/);
 assert.throws(() => resolveDesktopTarget({ arbitrary: 'Save' }, [a]), /Unknown/);
 assert.equal(resolveDesktopTarget({ name: 'Save' }, [a, { id: 'ocr', text: 'Save', role: 'text' }]).id, 'a');
});
test('background adapter fails closed without affecting foreground input', () => {
 const registry = new DesktopAdapterRegistry();
 const adapter = registry.resolve({ process: 'Weixin', windowTitle: '微信' });
 assert.equal(adapter.id, 'generic-uia');
 assert.equal(adapter.preflight({}, 'click').allowed, false);
 assert.equal(adapter.preflight({}, 'type').allowed, false);
 assert.equal(adapter.preflight({}, 'click_element').allowed, true);
 assert.equal(adapter.preflight({}, 'type_element').allowed, true);
});
test('desktop queue serializes whole cycles across owners and cancellation of waiter never cancels holder', async () => {
 const q = new DesktopControlScheduler(); const gate = deferred(); const order = []; const c = new AbortController();
 const first = q.run('a', '1', undefined, async lease => { order.push('a'); await gate.promise; assert.equal(lease.signal.aborted, false); order.push('end'); });
 const cancelled = q.run('b', '2', c.signal, async () => order.push('bad')); const rejected = assert.rejects(cancelled, /queue/);
 const third = q.run('c', '3', undefined, async () => order.push('c'));
 await tick(); c.abort(); await rejected; assert.deepEqual(order, ['a']); gate.resolve(); await Promise.all([first, third]); assert.deepEqual(order, ['a', 'end', 'c']);
});
test('expired lease waits for executor cleanup before next owner', async () => {
 const q = new DesktopControlScheduler(15); const cleaned = deferred(); let aborted = false, next = false;
 const first = q.run('a', '1', undefined, async lease => { await new Promise(r => lease.signal.addEventListener('abort', r, { once: true })); aborted = true; await cleaned.promise; });
 const second = q.run('b', '2', undefined, async () => next = true);
 await new Promise(r => setTimeout(r, 35)); assert.equal(aborted, true); assert.equal(next, false); cleaned.resolve(); await Promise.all([first, second]); assert.equal(next, true);
});
test('input requires owner snapshot and semantic click has full ordered post-verification cycle', async () => {
 const f = fixture(); assert.equal((await f.run({ action: 'click' })).success, false); assert.equal(f.calls.length, 0);
 await f.run({ action: 'observe' });
 const result = await f.run({ action: 'click', target: { automationId: 'saveButton' }, verifyText: 'Save' });
 assert.equal(result.success, true); assert.equal(result.metadata.desktop.verified, true);
 assert.deepEqual(result.metadata.desktop.events.map(e => e.phase), ['queued', 'resolve', 'action_start', 'action_end', 'observe', 'verify', 'completed']);
 assert.equal(f.calls.find(c => c.action === 'click_element').elementId, 'save');
 assert.equal(JSON.parse(result.output).data.postObservation.observationToken, 't2');
});
test('focus takeover, owner handoff and stale tokens never issue input', async () => {
 const f = fixture(); await f.run({ action: 'observe' }); f.focus(false);
 const takeover = await f.run({ action: 'type', text: 'secret' }); assert.equal(takeover.metadata.desktop.userTakeover, true);
 assert.equal(f.calls.some(c => c.action === 'type'), false);
 f.focus(true); await f.run({ action: 'observe' }); f.bind(20);
 assert.equal((await f.run({ action: 'click' })).success, false);
 await f.run({ action: 'observe' }); assert.equal((await f.run({ action: 'click', observationToken: 'stale' })).success, false);
 assert.equal((await f.run({ action: 'click' }, 'b')).success, false);
 assert.equal(f.calls.some(c => c.action === 'click'), false);
});
test('post-action observation is not falsely labeled business success; mismatch stops without retry', async () => {
 const f = fixture(); await f.run({ action: 'observe' });
 const first = await f.run({ action: 'click', target: { name: 'Save' } }); assert.equal(first.success, true); assert.equal(first.metadata.desktop.verified, false);
 const result = await f.run({ action: 'click', target: { name: 'Save' }, verifyText: 'Missing text' });
 assert.equal(result.success, false); assert.match(result.output, /verification failed/); assert.equal(f.calls.filter(c => c.action === 'click_element').length, 2);
 assert.equal((await f.run({ action: 'key', key: 'ENTER' })).success, false);
});
test('managed batch validates all action types before dispatch and resolves each step freshly', async () => {
 const f = fixture(); await f.run({ action: 'observe' });
 const bad = await f.run({ action: 'batch', actions: [{ action: 'click' }, { action: 'launch' }] }); assert.equal(bad.success, false); assert.equal(f.calls.some(c => c.action === 'click'), false);
 await f.run({ action: 'observe' });
 const good = await f.run({ action: 'batch', actions: [{ action: 'click', target: { name: 'Save' } }, { action: 'click', target: { name: 'Save' } }], verifyText: 'Save' });
 assert.equal(good.success, true); assert.equal(good.metadata.desktop.verified, true);
 const clicks = f.calls.filter(c => c.action === 'click_element'); assert.equal(clicks.length, 2); assert.notEqual(clicks[0].observationToken, clicks[1].observationToken);
});
test('journal records only ordered phases; reconstructed session never replays old input', async t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-desktop-control-'));
 t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('iexa-desktop-control-')); fs.rmSync(root, { recursive: true, force: true }); });
 const f = fixture({ journalDir: root }); await f.run({ action: 'observe' }, '../owner');
 const result = await f.run({ action: 'type', text: 'SECRET_NOT_IN_JOURNAL' }, '../owner'); assert.equal(result.success, true);
 const text = fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), 'utf8'); assert.equal(text.includes('SECRET_NOT_IN_JOURNAL'), false);
 const events = text.trim().split('\n').map(JSON.parse); const current = events.filter(e => e.operationId === result.metadata.desktop.operationId);
 assert.deepEqual(current, result.metadata.desktop.events);
 const restored = fixture({ journalDir: root }); assert.equal((await restored.run({ action: 'type', text: 'no replay' }, '../owner')).success, false); assert.equal(restored.calls.length, 0);
});
test('cancelling active transport invalidates snapshot and stops post observation', async () => {
 const c = new AbortController(); const f = fixture({ transport: async (args, signal) => {
   if (args.action === 'type') { c.abort(); return { output: 'cancelled', success: false }; }
 } });
 await f.run({ action: 'observe' }); const r = await f.run({ action: 'type', text: 'text' }, 'a', c.signal);
 assert.equal(r.cancelled, true); assert.equal(r.metadata.desktop.phase, 'cancelled'); assert.equal(f.calls.filter(c => c.action === 'observe').length, 1);
});
test('desktop progress uses monotonic tool lifecycle sequence without restarting tool', () => {
 const { ToolLifecycle } = require('../dist/main/runtime/ToolLifecycle'); const l = new ToolLifecycle();
 l.transition('s','i','desktop_control','queued'); const running = l.transition('s','i','desktop_control','running');
 const p = l.progress('s','i',{version:1,operationId:'o',sequence:1,phase:'observe',timestamp:Date.now(),action:'click'});
 assert.equal(p.startedAt,running.startedAt); assert.ok(p.sequence > running.sequence); l.transition('s','i','desktop_control','completed');
 assert.throws(() => l.progress('s','i',p.desktop), /active/);
});
test('desktop live events and history restore yield identical phases including missed SSE events', async () => {
 const { JSDOM } = await import('jsdom'); const dom = new JSDOM('<section id="live"></section><section id="history"></section>', { runScripts:'outside-only' });
 dom.window.eval(fs.readFileSync(path.join(__dirname,'../src/renderer/services/ToolLifecycleView.js'),'utf8'));
 const view=dom.window.IexaToolLifecycleView, live=dom.window.document.querySelector('#live'), history=dom.window.document.querySelector('#history');
 const events=['queued','resolve','action_start','action_end','observe','verify','completed'].map((phase,i)=>({version:1,operationId:'o',sequence:i+1,phase,timestamp:1234000+i,action:'click',verified:false}));
 const render=()=>{};
 view.apply(live,{version:1,runId:'r',sequence:3,status:'running',desktop:events[2]},render);
 assert.equal(live.querySelector('details').dataset.active,'true');
 const result={success:true,executionStatus:'completed',metadata:{desktop:{events}}};
 view.applyResult(live,result,render); view.applyResult(history,JSON.parse(JSON.stringify(result)),render);
 assert.equal(live.querySelector('details').innerHTML,history.querySelector('details').innerHTML);
 assert.equal(live.querySelectorAll('li').length,events.length); assert.equal(live.querySelector('details').dataset.active,'false'); dom.window.close();
});
test('recovery reads bounded journal tail and reports interrupted operation without replay', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-desktop-recovery-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-desktop-recovery-'));fs.rmSync(root,{recursive:true,force:true});});
 const file=path.join(root,require('node:crypto').createHash('sha256').update('a').digest('hex')+'.jsonl');
 fs.writeFileSync(file,JSON.stringify({version:1,operationId:'interrupted',phase:'action_start',timestamp:1234})+'\n{"torn":');
 const f=fixture({journalDir:root});const state=await f.run({action:'session_state'});assert.equal(state.success,true);
 assert.equal(JSON.parse(state.output).data.control.recovered.interrupted,true);
 assert.equal(JSON.parse(state.output).data.control.needsObservation,true);
 assert.equal((await f.run({action:'type',text:'never replay'})).success,false);assert.equal(f.calls.some(c=>c.action==='type'),false);
});
test('desktop input respects risk approval before it reaches control queue; full mode is explicit', async t => {
 const {ToolRuntime}=require('../dist/main/runtime/ToolRuntime');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-desktop-permission-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-desktop-permission-'));fs.rmSync(root,{recursive:true,force:true});});
 const runtime=new ToolRuntime({workspaceDir:root,memoryDir:path.join(root,'memory')});runtime.registerDefaults();let calls=0;
 runtime.desktop.execute=async()=>{calls++;return {output:'fixture',success:true};};
 const context=id=>({sessionId:'s',toolCallId:id,workspaceDir:root,signal:new AbortController().signal});
 const denied=await runtime.execute('desktop_control',{tool_title:'type',action:'type',text:'no'},context('one'));
 assert.equal(denied.executionStatus,'denied');assert.equal(calls,0);
 const observed=await runtime.execute('desktop_control',{tool_title:'observe',action:'observe'},context('two'));assert.equal(observed.success,true);assert.equal(calls,1);
 runtime.setPermissionMode('full');const full=await runtime.execute('desktop_control',{tool_title:'type',action:'type',text:'yes'},context('three'));assert.equal(full.success,true);assert.equal(calls,2);
});
test('actual server save retains desktop phases through new SessionManager reader', async t => {
 const vm=require('node:vm'),ts=require('typescript');const {SessionManager}=require('../dist/main/session/SessionManager');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-desktop-history-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-desktop-history-'));fs.rmSync(root,{recursive:true,force:true});});
 const f=fixture();await f.run({action:'observe'});const result=await f.run({action:'click',target:{name:'Save'},verifyText:'Save'});
 const source=fs.readFileSync(path.join(__dirname,'../src/main/server.ts'),'utf8'),tree=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);
 const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='saveSessionMessages');
 const store=new SessionManager(root);const context={saveMessages:(id,messages)=>store.save(id,messages),agentCache:new Map(),saveSessionContext:()=>{},loadSessionStore:()=>({sessions:[]}),saveSessionStore:()=>{},normalizeThinkingLevel:x=>x,getThinkingLevel:()=> 'medium'};
 vm.runInNewContext(ts.transpileModule(fn.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 await context.saveSessionMessages('s',[],{role:'user',content:'run',timestamp:1},'done',[{id:'desktop',name:'desktop_control',args:{action:'click'},result}],undefined);
 const saved=new SessionManager(root).loadSync('s');assert.deepEqual(saved[1].toolCalls[0].result.metadata.desktop,JSON.parse(JSON.stringify(result.metadata.desktop)));
});

test('window selectors reject duplicate titles, conflicting PID and missing targets', () => {
 const {resolveDesktopWindow}=require('../dist/main/tools/desktop/DesktopTargetResolver');
 const windows=[{handle:10,pid:1,title:'same.txt - Notepad',process:'notepad'},{handle:20,pid:2,title:'same.txt - Notepad',process:'notepad'}];
 assert.throws(()=>resolveDesktopWindow({window:'same.txt'},windows),/ambiguous/);
 assert.equal(resolveDesktopWindow({window:'same.txt',pid:2},windows).handle,20);
 assert.throws(()=>resolveDesktopWindow({handle:10,pid:2},windows),/not found/);
 assert.throws(()=>resolveDesktopWindow({window:'gone.txt'},windows),/not found/);
 assert.throws(()=>resolveDesktopWindow({},windows),/Specify/);
});
test('ambiguous binding is rejected before native activation; no accidental foreground fallback', async () => {
 const f=fixture({transport:async args=>args.action==='list_windows'?{success:true,output:JSON.stringify({ok:true,data:{windows:[{handle:10,pid:1,title:'same',process:'app'},{handle:20,pid:2,title:'same',process:'app'}]}})}:undefined});
 const result=await f.run({action:'activate',window:'same'});assert.equal(result.success,false);assert.match(result.output,/ambiguous/);assert.equal(f.calls.some(c=>c.action==='activate'),false);
 const absent=await f.run({action:'observe',window:'missing'});assert.equal(absent.success,false);assert.equal(f.calls.some(c=>c.action==='observe'),false);
});

test('new model run clears reusable desktop capability while preserving recovery journal', async () => {
 const f=fixture(); await f.run({action:'observe'}); assert.equal((await f.run({action:'click',target:{name:'Save'}})).success,true);
 f.session.reset(); const result=await f.run({action:'click',target:{name:'Save'}});
 assert.equal(result.success,false); assert.match(result.output,/Fresh observe/); assert.equal(f.calls.filter(c=>c.action==='click_element').length,1);
});

test('background-unverified OCR never becomes a semantic input target', async () => {
 const f=fixture({transport:async args=>args.action==='observe'?{success:true,output:JSON.stringify({ok:true,data:{session:{handle:10,foreground:false,observationToken:'bg'},frame:{hash:'black',trust:'background-unverified'},elements:[{id:'ocr',role:'button',text:'File Transfer Assistant',source:'ocr',enabled:true}],ocr:{count:1}}})}:undefined});
 const observed=await f.run({action:'observe',handle:10,includeOcr:true});assert.equal(observed.success,true);
 const result=await f.run({action:'click',target:{name:'File Transfer Assistant',role:'button'},background:true});assert.equal(result.success,false);assert.match(result.output,/not found|trusted UI Automation|stale/);assert.equal(f.calls.some(c=>c.action==='click_element'),false);
});

test('background physical fallback and activation are denied before native side effects', async () => {
 for (const action of [
  {action:'click',relativeX:10,relativeY:10},
  {action:'type',text:'NO-INPUT'},
  {action:'click',target:{automationId:'saveButton'},forcePointer:true},
  {action:'activate',handle:10}, {action:'launch',app:'notepad'}, {action:'minimize'},
 ]) {
  const f=fixture(); await f.run({action:'observe'}); f.focus(false);
  const r=await f.run({...action,background:true});
  assert.equal(r.success,false,JSON.stringify(action));
  assert.equal(r.metadata.desktop.dispatchedActions,0);
  assert.equal(f.calls.some(c=>['click','click_element','type','type_element','activate','launch','minimize'].includes(c.action)),false);
 }
});
test('background rendered pixels without native selector are not an input capability',async()=>{
 const f=fixture(); f.elements.push({id:'vision',role:'button',text:'Painted',source:'local_cv',enabled:true});
 await f.run({action:'observe'}); f.focus(false);
 const result=await f.run({action:'click',target:{elementId:'vision'},background:true});
 assert.equal(result.success,false);assert.match(result.output,/native UIA selector/);assert.equal(result.metadata.desktop.dispatchedActions,0);
});
test('background semantic action dispatches resolved selector and preserves no-autoActivate',async()=>{
 const f=fixture();await f.run({action:'observe'});f.focus(false);
 const result=await f.run({action:'click',target:{automationId:'saveButton'},background:true,verifyText:'Save'});
 assert.equal(result.success,true,result.output);
 const input=f.calls.find(c=>c.action==='click_element');assert.equal(input.background,true);assert.equal(input.autoActivate,false);
 assert.equal(result.metadata.desktop.verified,true);
});
test('managed background batch never silently downgrades steps to foreground',async()=>{
 const f=fixture();await f.run({action:'observe'});f.focus(false);
 const result=await f.run({action:'batch',background:true,actions:[{action:'click',target:{automationId:'saveButton'}}]});
 assert.equal(result.success,true,result.output);assert.equal(f.calls.find(c=>c.action==='click_element').background,true);
});
test('background frame request is bound to owner observation token',async()=>{
 const f=fixture();await f.run({action:'observe'});f.focus(false);
 const r=await f.run({action:'frame',background:true});assert.equal(r.success,true,r.output);
 assert.equal(f.calls.find(c=>c.action==='frame').observationToken,'t1');
});

test('desktop model schema exposes background and compact observations retain trust and semantic selectors',()=>{
 const {makeAgentTools}=require('../dist/main/tools/ToolDefinitions');
 const tool=makeAgentTools().find(t=>t.name==='desktop_control');
 assert.equal(tool.parameters.background.type,'boolean');
 for(const key of tool.propertyOrdering)assert.ok(tool.parameters[key],`Unknown ordered parameter: ${key}`);
 const {formatDesktopResult}=require('../dist/main/tools/DesktopAgent');
 const output=formatDesktopResult({ok:true,action:'observe',data:{frame:{trust:'background-unverified'},elements:[{id:'e1',role:'button',text:'Save',selector:{automationId:'SaveButton',name:'Save'}}]}});
 assert.match(output,/background-unverified/);assert.match(output,/SaveButton/);
});

test('backend switching invalidates prior owner capability before any input',async()=>{
 const f=fixture();await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const r=await f.run({action:'click',target:{automationId:'saveButton'},backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9223',background:true});
 assert.equal(r.success,false);assert.equal(r.metadata.desktop.dispatchedActions,0);assert.equal(f.calls.some(c=>c.action==='click_element'),false);
});
test('batch steps cannot override backend context to dispatch input to another endpoint',async()=>{
 const f=fixture();await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const r=await f.run({action:'batch',background:true,actions:[{action:'click',target:{automationId:'saveButton'},backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9223'}]});
 assert.equal(r.success,false);assert.match(r.output,/Backend target changed/);assert.equal(r.metadata.desktop.dispatchedActions,0);
});
