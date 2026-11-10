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
test('explicit popup handle is retained during discovery so untitled windows can be observed', async () => {
 const f=fixture({transport:async args=>args.action==='list_windows'?{success:true,output:JSON.stringify({ok:true,data:{windows:args.handle===77?[{handle:77,pid:7,process:'chrome',title:''}]:[]}})}:undefined});
 const result=await f.run({action:'observe',backend:'native',controlMode:'foreground',handle:77});
 assert.equal(result.success,true,result.output);
 assert.equal(f.calls.find(call=>call.action==='list_windows').handle,77);
 assert.equal(f.calls.find(call=>call.action==='observe').handle,77);
});

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
test('pointer movement without foreground takeover does not cancel a managed desktop action', async () => {
 let cursorX=0;
 const f=fixture({transport:async args=>args.action==='session_state'?{success:true,output:JSON.stringify({ok:true,data:{handle:10,foreground:true,observationToken:'t1',geometryChanged:false,cursor:{x:++cursorX,y:12}}})}:undefined});
 await f.run({action:'observe'});
 const r=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(r.success,true,r.output);assert.equal(r.metadata.desktop.dispatchedActions,1);assert.ok(cursorX>=2);
});
test('forcePointer requires one matching UIA no-effect result and fresh observation', async () => {
 const f = fixture({ transport: async args => args.action === 'click_element'
  ? { output: JSON.stringify({ ok: true, action: args.action, data: { method: 'InvokePattern', automation: { success: true }, effectObserved: false, foregroundVerified: true } }), success: true }
  : undefined });
 await f.run({ action: 'observe', controlMode: 'foreground' });
 const rejected = await f.run({ action: 'click', target: { name: 'Save' }, forcePointer: true });
 assert.equal(rejected.success, false); assert.match(rejected.output, /prior UIA click/);
 assert.equal(f.calls.filter(call => call.action === 'click_element').length, 0);
 await f.run({ action: 'observe' });
 const semantic = await f.run({ action: 'click', target: { name: 'Save' } });
 assert.equal(semantic.success, true, semantic.output);
 const forced = await f.run({ action: 'click', target: { name: 'Save' }, forcePointer: true });
 assert.equal(forced.success, true, forced.output);
 const clicks = f.calls.filter(call => call.action === 'click_element');
 assert.equal(clicks.length, 2); assert.notEqual(clicks[0].forcePointer, true); assert.equal(clicks[1].forcePointer, true);
 const replay = await f.run({ action: 'click', target: { name: 'Save' }, forcePointer: true });
 assert.equal(replay.success, false); assert.match(replay.output, /prior UIA click/);
 assert.equal(f.calls.filter(call => call.action === 'click_element').length, 2);
});

test('foreground loss blocks dispatch without falsely claiming the operation lease was revoked', async () => {
 const f = fixture(); await f.run({ action: 'observe', controlMode: 'foreground' }); f.focus(false);
 const blocked = await f.run({ action: 'type', text: 'secret', focusPolicy: 'stop' });
 assert.equal(blocked.success, false); assert.equal(blocked.metadata.desktop.userTakeover, false); assert.equal(blocked.metadata.desktop.phase, 'failed');
 assert.match(blocked.output, /not foreground; no physical input dispatched/);
 assert.equal(blocked.metadata.desktop.dispatchedActions, 0); assert.equal(f.calls.some(c => c.action === 'type'), false);
 f.focus(true); await f.run({ action: 'observe' }); f.bind(20);
 assert.equal((await f.run({ action: 'click', focusPolicy: 'stop' })).success, false);
 await f.run({ action: 'observe' }); assert.equal((await f.run({ action: 'click', observationToken: 'stale', focusPolicy: 'stop' })).success, false);
 assert.equal((await f.run({ action: 'click', focusPolicy: 'stop' }, 'b')).success, false);
 assert.equal(f.calls.some(c => c.action === 'click'), false);
});

test('verified native foreground input follows a late owned modal only during its post-action state check without replay', async () => {
 let acted=false;
 const f=fixture({transport:async args=>{
  if(args.action==='click_element'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{foregroundVerified:true}})};}
  if(acted&&args.action==='session_state'){
   if(args.followOwnedModal===true){f.bind(11);return {success:true,output:JSON.stringify({ok:true,data:{handle:11,foreground:true,observationToken:''}})};}
   return {success:true,output:JSON.stringify({ok:true,data:{handle:10,foreground:false,observationToken:'t1'}})};
  }
 }});
 await f.run({action:'observe',backend:'native',controlMode:'foreground'});
 const result=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(result.success,true,result.output);
 assert.equal(JSON.parse(result.output).data.postObservation.handle,11);
 assert.equal(result.metadata.desktop.dispatchedActions,1);assert.equal(result.metadata.desktop.acknowledgedActions,1);
 assert.equal(result.metadata.desktop.verified,false,'ownership observation is not a business assertion');
 const states=f.calls.filter(call=>call.action==='session_state');
 assert.equal(states.length,2);assert.equal(states[0].followOwnedModal,undefined);assert.equal(states[1].followOwnedModal,true);
 assert.equal(f.calls.filter(call=>call.action==='click_element').length,1);
 assert.equal(f.calls.some(call=>['activate','bind_window'].includes(call.action)),false);
 assert.equal(f.calls.some(call=>call.action!=='session_state'&&call.followOwnedModal!==undefined),false);
});

test('late-modal following requires a strict successful native foreground proof and preserves unrelated focus-loss failures', async () => {
 for(const proof of [undefined,false,'true',true]){
  let acted=false;
  const f=fixture({transport:async args=>{
   if(args.action==='click_element'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{foregroundVerified:proof}})};}
   // Native policy rejects an unrelated foreground even when an earlier input
   // genuinely completed while the intended window was still foreground.
   if(acted&&args.action==='session_state')return {success:true,output:JSON.stringify({ok:true,data:{handle:10,foreground:false,observationToken:'t1'}})};
  }});
  await f.run({action:'observe',backend:'native',controlMode:'foreground'});
  const result=await f.run({action:'click',target:{automationId:'saveButton'}});
  assert.equal(result.success,false);assert.match(result.output,/Target lost foreground/);
  assert.equal(result.metadata.desktop.dispatchedActions,1);assert.equal(result.metadata.desktop.acknowledgedActions,1);assert.equal(result.metadata.desktop.verified,false);
  const states=f.calls.filter(call=>call.action==='session_state');
  assert.equal(states[0].followOwnedModal,undefined);assert.equal(states.at(-1).followOwnedModal,proof===true?true:undefined);
  assert.equal(f.calls.filter(call=>call.action==='click_element').length,1);
  assert.equal(f.calls.some(call=>['activate','bind_window'].includes(call.action)),false);
  const blocked=await f.run({action:'click',target:{automationId:'saveButton'}});
  assert.equal(blocked.success,false);assert.match(blocked.output,/Fresh observe/);
  assert.equal(f.calls.filter(call=>call.action==='click_element').length,1);
 }
});

test('native proof never requests modal following for background native, isolated or Chromium input', async () => {
 for(const mode of [
  {backend:'native',controlMode:'background'},
  {backend:'native-isolated'},
  {backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'},
 ]){
  const f=fixture({transport:async args=>args.action==='click_element'?{success:true,output:JSON.stringify({ok:true,data:{foregroundVerified:true}})}:undefined});
  const observed=await f.run({action:'observe',...mode});assert.equal(observed.success,true,observed.output);
  const result=await f.run({action:'click',target:{automationId:'saveButton'}});assert.equal(result.success,true,result.output);
  assert.equal(f.calls.some(call=>call.followOwnedModal!==undefined),false);
 }
});

test('failed native input never reaches a modal-follow state check or replays input', async () => {
 const f=fixture({transport:async args=>args.action==='click_element'?{success:false,output:'Native input failed before foreground verification.'}:undefined});
 await f.run({action:'observe',backend:'native',controlMode:'foreground'});
 const result=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(result.success,false);assert.equal(result.metadata.desktop.acknowledgedActions,0);assert.equal(result.metadata.desktop.dispatchedActions,1);
 assert.equal(f.calls.filter(call=>call.action==='session_state').length,1);assert.equal(f.calls.some(call=>call.followOwnedModal!==undefined),false);
 assert.equal(f.calls.filter(call=>call.action==='click_element').length,1);
});

test('internal modal-follow arguments are rejected before passive transport or any managed batch input', async () => {
 for(const args of [
  {action:'session_state',followOwnedModal:true},
  {action:'click',target:{automationId:'saveButton'},followOwnedModal:true},
  {action:'click',target:{automationId:'saveButton'},followOwnedModal:false},
  {action:'batch',actions:[{action:'click',target:{automationId:'saveButton'}},{action:'key',key:'ENTER',followOwnedModal:true}]},
 ]){
  const f=fixture();await f.run({action:'observe',backend:'native',controlMode:'foreground'});const before=f.calls.length;
  const result=await f.run(args);assert.equal(result.success,false);assert.match(result.output,/internal post-action verification field/);
  assert.equal(result.metadata.desktop.dispatchedActions,0);assert.equal(f.calls.length,before);
 }
});

test('native expected-close verification forwards only the validated close expectation to its modal follow query', async () => {
 let acted=false;
 const f=fixture({transport:async args=>{
  if(args.action==='key'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{foregroundVerified:true}})};}
  if(acted&&args.action==='list_windows'&&args.handle===10)return {success:true,output:JSON.stringify({ok:true,data:{windows:[]}})};
 }});
 await f.run({action:'observe',backend:'native',controlMode:'foreground'});
 const result=await f.run({action:'key',key:'ESC',expectWindowClosed:true});assert.equal(result.success,true,result.output);
 const state=f.calls.find(call=>call.action==='session_state'&&call.followOwnedModal===true);
 assert.ok(state);assert.equal(state.expectWindowClosed,true);assert.equal(state.key,undefined);assert.equal(state.elementId,undefined);
 assert.equal(f.calls.filter(call=>call.action==='key').length,1);
});
test('foreground focus activation requires explicit policy and refreshes observation before input', async () => {
 const f = fixture(); await f.run({ action: 'observe', controlMode: 'foreground' }); f.focus(false);
 const result = await f.run({ action: 'click', target: { automationId: 'saveButton' }, focusPolicy: 'activate' });
 assert.equal(result.success, true, result.output);
 const actions = f.calls.map(call => call.action);
 const activateAt = actions.lastIndexOf('activate');
 assert.ok(activateAt > -1, 'the reclaim activates the bound window');
 assert.ok(actions.lastIndexOf('observe') > activateAt, 'a fresh observation follows the activation');
 assert.equal(result.metadata.desktop.dispatchedActions, 1);
});
test('foreground re-acquisition activates only with explicit foreground and activate policy', async () => {
 const f = fixture();
 await f.run({ action: 'observe', controlMode: 'foreground', focusPolicy: 'activate' });
 // The app re-created its window: the old handle is gone, the process is the same.
 f.bind(21);
 const result = await f.run({ action: 'type', text: 'hello' });
 assert.equal(result.success, true, result.output);
 const actions = f.calls.map(call => call.action);
 assert.ok(actions.includes('list_windows'), 'the session looks the window up again');
 assert.ok(actions.lastIndexOf('activate') > -1, 'the new handle is activated');
});

test('omitted mode uses background and every internal observation retains it across calls', async () => {
 const f=fixture(); f.focus(false);
 const observed=await f.run({action:'observe',background:true});assert.equal(observed.success,true);
 const clicked=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(clicked.success,true,clicked.output);
 assert.equal(clicked.metadata.desktop.control.mode,'background');
 assert.equal(clicked.metadata.desktop.control.physicalInput,false);
 assert.equal(clicked.metadata.desktop.control.capability,'uia-provider-semantic');
 assert.equal(clicked.metadata.desktop.control.providerMayChangeFocus,true);
 assert.ok(f.calls.every(call=>call.background===true),'internal session checks and post-observe must preserve background');
 assert.equal(f.calls.some(call=>call.action==='activate'),false);
 const batch=await f.run({action:'batch',actions:[{action:'click',target:{automationId:'saveButton'}}]});
 assert.equal(batch.success,true,batch.output);assert.equal(f.calls.at(-3).background,true);
});

test('a background window is re-acquired without activation even when activate policy was previously selected', async () => {
 const f=fixture();f.focus(false);await f.run({action:'observe',controlMode:'background',focusPolicy:'activate'});
 f.bind(21);
 const result=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(result.success,true,result.output);
 assert.equal(f.calls.some(call=>call.action==='activate'),false);
 assert.ok(f.calls.some(call=>call.action==='observe'&&call.handle===21&&call.background===true));
 assert.equal(JSON.parse(result.output).data.postObservation.handle,21);
});

test('default focus policy never activates an unfocused explicitly foreground target', async () => {
 const f=fixture();await f.run({action:'observe',controlMode:'foreground'});f.focus(false);
 const result=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(result.success,false);assert.match(result.output,/not foreground/);
 assert.equal(result.metadata.desktop.control.focusPolicy,'stop');
 assert.equal(result.metadata.desktop.noAction,true);assert.equal(result.metadata.desktop.dispatchedActions,0);
 assert.equal(f.calls.some(call=>call.action==='activate'||call.action==='click_element'),false);
});

test('default background rejects physical input without dispatch or foreground fallback', async () => {
 for(const action of [{action:'key',key:'ENTER'},{action:'type',text:'NO'},{action:'click',x:1,y:2},{action:'activate',handle:10}]){
  const f=fixture();await f.run({action:'observe'});f.focus(false);
  const result=await f.run(action);assert.equal(result.success,false,JSON.stringify(action));
  assert.equal(result.metadata.desktop.noAction,true);assert.equal(result.metadata.desktop.dispatchedActions,0);
  assert.equal(f.calls.some(call=>['key','type','click','click_element','activate'].includes(call.action)),false);
 }
});

test('mode changes are explicit, owner-scoped, and background batches reject a foreground step before any input', async () => {
 const f=fixture();await f.run({action:'observe',controlMode:'foreground'});
 assert.equal((await f.run({action:'type',text:'foreground'})).success,true);
 await f.run({action:'observe'},'other');
 const other=await f.run({action:'type',text:'must not dispatch'},'other');assert.equal(other.success,false);
 await f.run({action:'observe',controlMode:'background'});
 const before=f.calls.length;
 const invalid=await f.run({action:'batch',actions:[{action:'click',target:{automationId:'saveButton'}},{action:'key',key:'ENTER',background:false}]});
 assert.equal(invalid.success,false);assert.match(invalid.output,/cannot switch to foreground/);assert.equal(f.calls.length,before);
 const conflict=await f.run({action:'observe',controlMode:'background',background:false});
 assert.equal(conflict.success,false);assert.match(conflict.output,/disagree/);assert.equal(f.calls.length,before);
 await f.run({action:'observe',background:false});
 const foreground=await f.run({action:'type',text:'explicit foreground'});assert.equal(foreground.success,true,foreground.output);
 assert.equal(foreground.metadata.desktop.control.mode,'foreground');
 f.session.reset();await f.run({action:'observe'});
 assert.equal((await f.run({action:'type',text:'new run defaults background'})).success,false);
});

test('binding never activates implicitly in either mode', async () => {
 for(const controlMode of ['background','foreground']){
  const f=fixture();const bound=await f.run({action:'bind_window',handle:10,controlMode});assert.equal(bound.success,true,bound.output);
  const bind=f.calls.find(call=>call.action==='bind_window');assert.equal(bind.activate,false);assert.equal(bind.background,controlMode==='background');
  assert.equal(f.calls.some(call=>call.action==='activate'),false);
 }
});
test('explicit focusPolicy wait pauses dispatch until user restores target focus, then re-observes', async () => {
 const f = fixture(); await f.run({ action: 'observe', controlMode: 'foreground' }); f.focus(false);
 const before = f.calls.filter(c => c.action === 'observe').length;
 const restore = setTimeout(() => f.focus(true), 40);
 const result = await f.run({ action: 'click', target: { automationId: 'saveButton' }, focusPolicy: 'wait', focusWaitMs: 1000 });
 clearTimeout(restore);
 assert.equal(result.success, true, result.output); assert.equal(result.metadata.desktop.dispatchedActions, 1);
 assert.equal(f.calls.filter(c => c.action === 'observe').length, before + 2);
 const actions = f.calls.map(c => c.action); const refreshed = actions.lastIndexOf('observe', actions.lastIndexOf('click_element'));
 assert.ok(refreshed > before - 1, 'the refreshed observation must precede semantic input');
 assert.equal(f.calls.some(c => c.action === 'activate'), false);
});
test('focus wait timeout and explicit operation-lease revocation dispatch no unsafe input', async () => {
 const timed = fixture(); await timed.run({ action: 'observe', background: false }); timed.focus(false);
 const timeoutResult = await timed.run({ action: 'click', target: { automationId: 'saveButton' }, focusPolicy: 'wait', focusWaitMs: 20 });
 assert.equal(timeoutResult.success, false); assert.equal(timeoutResult.metadata.desktop.dispatchedActions, 0); assert.equal(timeoutResult.metadata.desktop.userTakeover, false);
 assert.match(timeoutResult.output, /Focus wait timed out/);
 const { DesktopControlScheduler } = require('../dist/main/tools/desktop/DesktopControlScheduler');
 const scheduler = new DesktopControlScheduler(); const entered = deferred();
 const revoked = fixture({ scheduler, transport: async (args, signal) => {
  if (args.action !== 'click_element') return undefined;
  entered.resolve(); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ success: false, output: signal.reason?.message || 'Lease revoked.' }), { once: true }));
 }});
 await revoked.run({ action: 'observe' });
 const pending = revoked.run({ action: 'click', target: { automationId: 'saveButton' } });
 await entered.promise; scheduler.pause();
 const result = await pending;
 assert.equal(result.cancelled, true); assert.equal(result.metadata.desktop.userTakeover, true);
 assert.equal(result.metadata.desktop.dispatchedActions, 1); scheduler.resume();
});
test('cancelling during focus wait exits promptly and invalidates the prior observation', async () => {
 const f = fixture(); await f.run({ action: 'observe', controlMode: 'foreground' }); f.focus(false);
 const controller = new AbortController();
 const pending = f.run({ action: 'click', target: { automationId: 'saveButton' }, focusPolicy: 'wait', focusWaitMs: 5000 }, 'a', controller.signal);
 await new Promise(resolve => setTimeout(resolve, 25)); controller.abort(new Error('User cancelled desktop wait.'));
 const result = await pending;
 assert.equal(result.success, false); assert.equal(result.cancelled, true);
 assert.equal(result.metadata.desktop.dispatchedActions, 0);
 assert.equal(f.calls.some(call => call.action === 'click_element'), false);
 assert.equal(result.metadata.desktop.userTakeover, false);
 assert.equal((await f.run({ action: 'click', target: { automationId: 'saveButton' } })).success, false);
 assert.equal(f.calls.some(call => call.action === 'click_element'), false);
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
 const malformed = [
  { action: 'click_element' },
  { action: 'type' },
  { action: 'hotkey', keys: [] },
  { action: 'drag', relativeX: 1, relativeY: 1 },
 ];
 for (const invalid of malformed) {
  const before = f.calls.length;
  const result = await f.run({ action: 'batch', actions: [{ action: 'click', target: { name: 'Save' } }, invalid] });
  assert.equal(result.success, false); assert.equal(f.calls.length, before, `${invalid.action} validation dispatched transport`);
  assert.equal(result.metadata.desktop.dispatchedActions, 0);
 }
 await f.run({ action: 'observe' });
 const good = await f.run({ action: 'batch', actions: [{ action: 'click', target: { name: 'Save' } }, { action: 'click', target: { name: 'Save' } }], verifyText: 'Save' });
 assert.equal(good.success, true); assert.equal(good.metadata.desktop.verified, true);
 const clicks = f.calls.filter(c => c.action === 'click_element'); assert.equal(clicks.length, 2); assert.notEqual(clicks[0].observationToken, clicks[1].observationToken);
});
test('journal records only ordered phases; reconstructed session never replays old input', async t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-desktop-control-'));
 t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('iexa-desktop-control-')); fs.rmSync(root, { recursive: true, force: true }); });
 const f = fixture({ journalDir: root }); await f.run({ action: 'observe', controlMode: 'foreground' }, '../owner');
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
 await f.run({ action: 'observe', controlMode: 'foreground' }); const r = await f.run({ action: 'type', text: 'text' }, 'a', c.signal);
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
test('uncertain dispatch survives session restart, requires fresh observation, and is never auto-replayed', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-desktop-restart-recovery-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-desktop-restart-recovery-'));fs.rmSync(root,{recursive:true,force:true});});
 let oldDispatches=0;
 const crashed=fixture({journalDir:root,transport:async args=>args.action==='click_element'?(oldDispatches++,{success:false,output:'Worker disconnected after dispatch began.'}):undefined});
 await crashed.run({action:'observe'});
 const uncertain=await crashed.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(uncertain.success,false);assert.equal(uncertain.metadata.desktop.dispatchedActions,1);assert.equal(oldDispatches,1);
 const restarted=fixture({journalDir:root});
 const observed=await restarted.run({action:'observe'});assert.equal(observed.success,true);
 const state=await restarted.run({action:'session_state'});assert.equal(state.success,true);
 const recovered=JSON.parse(state.output).data.control.recovered;
 assert.equal(recovered.unresolvedOperationCount,1);assert.equal(recovered.replayPolicy,'observe_and_verify_no_automatic_replay');
 assert.equal(restarted.calls.some(call=>call.action==='click_element'),false,'restarting and observing must not replay the uncertain click');
 const fresh=await restarted.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(fresh.success,true,fresh.output);
 assert.equal(restarted.calls.filter(call=>call.action==='click_element').length,1,'only a new explicit action after observation is dispatched');
});
test('desktop recovery journal survives actual Node process exit and prevents replay in a new process', async t => {
 const {execFileSync}=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-desktop-os-recovery-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-desktop-os-recovery-'));fs.rmSync(root,{recursive:true,force:true});});
 const runner=path.join(__dirname,'desktop-recovery-process.cjs');
 const failed=JSON.parse(execFileSync(process.execPath,[runner,'fail',root],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'}));
 assert.equal(failed.success,false);assert.equal(failed.dispatched,1);assert.equal(failed.calls.filter(action=>action==='click_element').length,1);
 const recovered=JSON.parse(execFileSync(process.execPath,[runner,'recover',root],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'}));
 assert.equal(recovered.success,true);assert.equal(recovered.warning,true);assert.match(recovered.output,/action=click, phase=failed, dispatched=1/);
 assert.equal(recovered.calls[0],'observe');assert.equal(recovered.calls.some(action=>['click_element','type','key','hotkey','click'].includes(action)),false,'fresh OS process must observe recovery without replaying old input');
});
test('production DesktopAgent surfaces persisted recovery warning after a simulated restart', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-desktop-agent-recovery-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-desktop-agent-recovery-'));fs.rmSync(root,{recursive:true,force:true});});
 const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
 const firstTransport=fixture({transport:async args=>args.action==='click_element'?{success:false,output:'Worker disconnected after dispatch began.'}:undefined});
 const first=new DesktopAgent(process.cwd(),false,root);first.executeNative=(args,signal)=>firstTransport.transport(args,signal);
 await first.execute({action:'observe'},undefined,{owner:'session-1'});
 const failed=await first.execute({action:'click',target:{automationId:'saveButton'}},undefined,{owner:'session-1'});
 assert.equal(failed.success,false);assert.equal(failed.metadata.desktop.dispatchedActions,1);first.close();
 const secondTransport=fixture();
 const second=new DesktopAgent(process.cwd(),false,root);second.executeNative=(args,signal)=>secondTransport.transport(args,signal);
 const recovered=await second.execute({action:'observe'},undefined,{owner:'session-1'});
 assert.equal(recovered.success,true);assert.match(recovered.output,/恢复警告：1 项历史操作可能已执行但结果未确认/);
 assert.match(recovered.output,/不要重复提交/);
 assert.match(recovered.output,/action=click, phase=failed, dispatched=1/);
 assert.equal(secondTransport.calls.some(call=>call.action==='click_element'),false,'recovery observation must not replay prior input');
 const followup=await second.execute({action:'session_state'},undefined,{owner:'session-1'});assert.doesNotMatch(followup.output,/恢复警告：/,'one delivered recovery notice should not repeat on every tool result in the same run');
 second.resetControl();const nextRun=await second.execute({action:'observe'},undefined,{owner:'session-1'});assert.match(nextRun.output,/恢复警告：1 项历史操作可能已执行但结果未确认/,'unresolved warning should be re-armed for the next model run');
 second.close();
});
test('ToolRuntime beginRun preserves owner recovery journal and delivers warning to the resumed session', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-runtime-recovery-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-runtime-recovery-'));fs.rmSync(root,{recursive:true,force:true});});
 const {ToolRuntime}=require('../dist/main/runtime/ToolRuntime');
 const runtime=new ToolRuntime({workspaceDir:root,memoryDir:path.join(root,'memory'),auditDir:path.join(root,'audit')});runtime.registerDefaults();runtime.setPermissionMode('full');
 const failedTransport=fixture({transport:async args=>args.action==='click_element'?{success:false,output:'Worker disconnected after dispatch began.'}:undefined});
 runtime.desktop.executeNative=(args,signal)=>failedTransport.transport(args,signal);
 const invoke=(id,args)=>runtime.execute('desktop_control',{tool_title:args.action,...args},{sessionId:'persistent-session',toolCallId:id,workspaceDir:root,signal:new AbortController().signal});
 const initial=await invoke('observe-before',{action:'observe'});assert.equal(initial.success,true,initial.output);
 const failed=await invoke('uncertain-click',{action:'click',target:{automationId:'saveButton'}});
 assert.equal(failed.success,false);assert.equal(failed.metadata.desktop.dispatchedActions,1);
 runtime.beginRun(['desktop_control']);
 const resumedTransport=fixture();runtime.desktop.executeNative=(args,signal)=>resumedTransport.transport(args,signal);
 const resumed=await invoke('observe-after-restart',{action:'observe'});
 assert.equal(resumed.success,true);assert.match(resumed.output,/恢复警告：1 项历史操作可能已执行但结果未确认/);
 assert.equal(resumedTransport.calls.some(call=>call.action==='click_element'),false);
 runtime.desktop.close();
});
test('AgentRuntime restores saved chat and exposes unresolved desktop action before recovery decisions', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-agentruntime-recovery-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-agentruntime-recovery-'));fs.rmSync(root,{recursive:true,force:true});});
 const {AgentRuntime}=require('../dist/main/runtime/AgentRuntime');const sessionId='persistent-agent-runtime';
 const failedTransport=fixture({transport:async args=>args.action==='click_element'?{success:false,output:'Worker disconnected after dispatch began.'}:undefined});
 let initialRequests=0;const initialProvider={name:'fixture',model:'fixture',defaultMaxTokens:1024,async *streamMessage(messages){
  initialRequests++;
  if(initialRequests===1){yield {type:'toolCallComplete',id:'initial-observe',name:'desktop_control',args:{tool_title:'Observe',action:'observe'}};yield {type:'done',stopReason:'toolUse'};return;}
  if(initialRequests===2){yield {type:'toolCallComplete',id:'uncertain-click',name:'desktop_control',args:{tool_title:'Click Save',action:'click',target:{automationId:'saveButton'}}};yield {type:'done',stopReason:'toolUse'};return;}
  const result=messages.flatMap(message=>message.parts).find(part=>part.type==='toolResult'&&part.id==='uncertain-click');
  assert.ok(result);assert.match(result.content,/Worker disconnected after dispatch began/);
  yield {type:'textDelta',text:'The click outcome is uncertain; do not replay before checking state.'};yield {type:'done',stopReason:'endTurn'};
 }};
 const config={sessionId,workspaceDir:root,memoryDir:path.join(root,'memory'),auditDir:path.join(root,'audit'),memoryEnabled:false,permissionMode:'full',contextWindow:200000,provider:initialProvider};
 const firstRuntime=new AgentRuntime(config);await firstRuntime.initialize();firstRuntime.tools.desktop.executeNative=(args,signal)=>failedTransport.transport(args,signal);
 const noop=()=>{};const callbacks=()=>({onTextDelta:noop,onThinkingDelta:noop,onToolCallStart:noop,onToolInputDelta:noop,onToolCallComplete:noop,onToolResult:noop,onUsage:noop,onContext:noop,onError:error=>assert.fail(error),onDone:noop,onCancelled:()=>assert.fail('unexpected cancellation')});
 await firstRuntime.run({message:'Original task: change and save the document through the desktop UI.',tools:firstRuntime.toolDefinitions(),callbacks:callbacks()});
 assert.equal(initialRequests,3);assert.equal(failedTransport.calls.filter(call=>call.action==='click_element').length,1);
 firstRuntime.tools.desktop.close();
 const resumedTransport=fixture();let resumedRequests=0,finalText='';
 const resumedProvider={name:'fixture',model:'fixture',defaultMaxTokens:1024,async *streamMessage(messages){
  resumedRequests++;
  if(resumedRequests===1){assert.ok(messages.some(message=>message.role==='user'&&message.parts.some(part=>part.type==='text'&&part.text.includes('Original task:'))),'saved task history must be rehydrated');yield {type:'toolCallComplete',id:'recovery-observe',name:'desktop_control',args:{tool_title:'Check current state',action:'observe'}};yield {type:'done',stopReason:'toolUse'};return;}
  const result=messages.flatMap(message=>message.parts).find(part=>part.type==='toolResult'&&part.id==='recovery-observe');
  assert.ok(result);assert.match(result.content,/恢复警告：1 项历史操作可能已执行但结果未确认/);assert.match(result.content,/action=click, phase=failed, dispatched=1/);assert.match(result.content,/不要重复提交/);
  assert.equal(resumedTransport.calls.some(call=>call.action==='click_element'),false,'the restored agent must see recovery evidence before considering a new click');
  yield {type:'textDelta',text:'先核对状态，不重放未确认点击。'};yield {type:'done',stopReason:'endTurn'};
 }};
 const resumedRuntime=new AgentRuntime({...config,provider:resumedProvider});await resumedRuntime.initialize();resumedRuntime.tools.desktop.executeNative=(args,signal)=>resumedTransport.transport(args,signal);
 resumedRuntime.seedHistoryFromChat([{role:'user',content:'Original task: change and save the document through the desktop UI.'},{role:'assistant',content:'',toolCalls:[{id:'uncertain-click',name:'desktop_control',args:{action:'click'},result:{output:'Worker disconnected after dispatch began.',success:false}}]}]);
 await resumedRuntime.run({message:'Resume the previous task only after inspecting its current state.',tools:resumedRuntime.toolDefinitions(),callbacks:callbacks()});
 assert.equal(resumedRequests,2);resumedRuntime.tools.desktop.close();
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
 const store=new SessionManager(root);const context={groupFileChanges:require('../dist/main/session/FileChangeUndo').groupFileChanges,saveMessages:(id,messages)=>store.save(id,messages),agentCache:new Map(),saveSessionContext:()=>{},loadSessionStore:()=>({sessions:[]}),saveSessionStore:()=>{},normalizeThinkingLevel:x=>x,getThinkingLevel:()=> 'medium'};
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
 const result=await f.run({action:'activate',window:'same',controlMode:'foreground'});assert.equal(result.success,false);assert.match(result.output,/ambiguous/);assert.equal(f.calls.some(c=>c.action==='activate'),false);
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
 assert.deepEqual(tool.parameters.focusPolicy.enumValues,['stop','wait','activate']);
 assert.match(tool.parameters.focusPolicy.description,/default stop/i);
 assert.match(tool.parameters.focusPolicy.description,/never activates in background/i);
 assert.deepEqual(tool.parameters.controlMode.enumValues,['background','foreground']);
 assert.match(tool.parameters.backend.description,/explicitly requested for this task/);
 assert.match(tool.parameters.includeOcr.description,/confidence:null/);
 const prompt=require('../dist/main/agent/SystemPrompt').buildSystemPrompt({});
 assert.match(prompt,/普通指针移动不转移或撤销租约/);assert.match(prompt,/默认 controlMode=background/);
 for(const key of tool.propertyOrdering)assert.ok(tool.parameters[key],`Unknown ordered parameter: ${key}`);
 const {formatDesktopResult}=require('../dist/main/tools/DesktopAgent');
 const output=formatDesktopResult({ok:true,action:'observe',data:{frame:{trust:'background-unverified'},elements:[{id:'e1',role:'button',text:'Save',source:'uia',confidence:1,selector:{automationId:'SaveButton',name:'Save'}},{id:'e2',role:'button',text:'Save',source:'ocr',confidence:null}]}});
 assert.match(output,/background-unverified/);assert.match(output,/SaveButton/);assert.match(output,/source=ocr/);assert.match(output,/confidence=unavailable/);
});

test('compact production DesktopAgent output reports actual mode/backend and provider limits',async()=>{
 const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');const transport=fixture();
 const agent=new DesktopAgent(process.cwd());agent.executeNative=transport.transport;
 try{
  const result=await agent.execute({action:'observe'},undefined,{owner:'mode-report'});
  assert.equal(result.success,true,result.output);assert.match(result.output,/实际操控：后台/);assert.match(result.output,/后端=native/);
  assert.match(result.output,/物理输入=禁用/);assert.match(result.output,/前台回退=禁用/);assert.match(result.output,/应用控件\/页面事件可能改变焦点/);
 }finally{agent.close();}
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

test('CDP component actions resolve exact observed nodes while native rejects them without dispatch',async()=>{
 for(const action of [
  {action:'select_option',value:'beta'}, {action:'set_value',value:25}, {action:'insert_text',text:'renderer text'},
  {action:'scroll',deltaY:100}, {action:'key',key:'ENTER'}, {action:'hotkey',keys:['CTRL','a']},
  {action:'drag',relativeX:10,relativeY:10,toRelativeX:80,toRelativeY:50},
 ]){
  const native=fixture();await native.run({action:'observe'});
  const rejected=await native.run({...action,target:{automationId:'saveButton'}});assert.equal(rejected.success,false,action.action);assert.equal(rejected.metadata.desktop.dispatchedActions,0);
  const cdp=fixture();await cdp.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
  const result=await cdp.run({...action,target:{automationId:'saveButton'}});assert.equal(result.success,true,result.output);
  const sent=cdp.calls.find(c=>c.action===action.action);assert.equal(sent.elementId,'save');assert.equal(sent.observationToken,'t1');assert.equal(sent.background,true);assert.equal(sent.autoActivate,false);
 }
});

test('targetless CDP keyboard resolves only a focused observed actual control',async()=>{
 const f=fixture();f.elements[1].focused=true;f.elements[1].capabilities=['keyInput','textValue'];f.elements[1].selector={automationId:'editor'};
 await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const result=await f.run({action:'key',key:'ESC'});assert.equal(result.success,true,result.output);assert.equal(f.calls.find(c=>c.action==='key').elementId,'edit');
 const empty=fixture();await empty.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const rejected=await empty.run({action:'key',key:'ESC'});assert.equal(rejected.success,false);assert.equal(rejected.metadata.desktop.dispatchedActions,0);assert.equal(empty.calls.some(c=>c.action==='key'),false);
});

test('CDP post-action capture retries only observation and never submits a second action',async()=>{
 let observations=0;
 const f=fixture({transport:async args=>{
  if(args.action==='observe'&&++observations>1&&observations<4)return {success:false,output:'Chromium page changed during capture; observe again.'};
 }});
 await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const result=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(result.success,true,result.output);assert.equal(observations,4);assert.equal(f.calls.filter(c=>c.action==='click_element').length,1);
 assert.equal(result.metadata.desktop.dispatchedActions,1);assert.equal(result.metadata.desktop.acknowledgedActions,1);assert.equal(JSON.parse(result.output).data.postObservation.observationToken,'t2');
});

test('exhausted capture retry reports acknowledged input and pending observation without replay',async()=>{
 let observations=0;
 const f=fixture({transport:async args=>args.action==='observe'&&++observations>1?{success:false,output:'Chromium page changed during capture; observe again.'}:undefined});
 await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const result=await f.run({action:'click',target:{automationId:'saveButton'}});
 assert.equal(result.success,false);assert.match(result.output,/Input acknowledged; post-action observation is pending/);assert.equal(observations,4);
 assert.equal(result.metadata.desktop.acknowledgedActions,1);assert.equal(result.metadata.desktop.dispatchedActions,1);assert.equal(result.metadata.desktop.observationPending,true);assert.equal(result.metadata.desktop.noAction,false);
 const blocked=await f.run({action:'click',target:{automationId:'saveButton'}});assert.equal(blocked.success,false);assert.equal(blocked.metadata.desktop.dispatchedActions,0);assert.equal(f.calls.filter(c=>c.action==='click_element').length,1);
});

test('CDP capture retry stops for non-capture errors and lease cancellation',async()=>{
 for(const cancel of [false,true]){
  let observations=0;const abort=new AbortController();
  const f=fixture({transport:async args=>{
   if(args.action==='observe'&&++observations>1){if(cancel)abort.abort();return {success:false,output:cancel?'Chromium page changed during capture; observe again.':'CDP connection closed'};}
  }});
  await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
  const result=await f.run({action:'click',target:{automationId:'saveButton'}},'a',abort.signal);assert.equal(result.success,false);assert.equal(observations,2);assert.equal(f.calls.filter(c=>c.action==='click_element').length,1);
 }
});

test('compact observation preserves component capabilities and native value metadata',()=>{
 const {formatDesktopResult}=require('../dist/main/tools/DesktopAgent');
 const component={capabilities:['select','keyInput'],focused:true,checked:false,expanded:false,options:[{value:'a',label:'Alpha',disabled:false,selected:true}],scroll:{top:12,left:0,width:100,height:500,clientWidth:100,clientHeight:80},min:'0',max:'100',step:'5'};
 const output=formatDesktopResult({ok:true,action:'observe',data:{elements:[{id:'component',role:'combobox',text:'Model',...component}]}});
 for(const [key,value] of Object.entries(component))assert.ok(output.includes(JSON.stringify(key)+':'+JSON.stringify(value)),key);
});

test('explicit foreground native dialog closure verifies disappearance and revokes its observation',async()=>{
 for(const action of [{action:'click',target:{automationId:'saveButton'}},{action:'key',key:'ENTER'},{action:'hotkey',keys:['ALT','F4'],allowClose:true}]){
  let closed=false;
  const f=fixture({transport:async args=>{
   if(['click_element','key','hotkey'].includes(args.action)){closed=true;return {success:true,output:JSON.stringify({ok:true,data:{foregroundVerified:true}})};}
   if(closed&&args.action==='session_state')return {success:true,output:JSON.stringify({ok:true,data:{handle:10,foreground:false,observationToken:''}})};
   if(closed&&args.action==='list_windows')return {success:true,output:JSON.stringify({ok:true,data:{windows:args.handle===10?[]:[{handle:11,pid:1,title:'IEXA',process:'fixture'}]}})};
  }});
  await f.run({action:'observe',handle:10,controlMode:'foreground'});
  const result=await f.run({...action,expectWindowClosed:true});assert.equal(result.success,true,result.output);
  const data=JSON.parse(result.output).data;assert.equal(data.windowClosed,true);assert.equal(data.closedHandle,10);assert.equal(data.pid,1);assert.equal(data.needsObservation,true);
  assert.equal(result.metadata.desktop.verified,true);assert.equal(result.metadata.desktop.verificationMethod,'window_closed');assert.equal(result.metadata.desktop.observationToken,undefined);assert.equal(result.metadata.desktop.acknowledgedActions,1);
  assert.equal(f.calls.filter(c=>c.action==='observe').length,1);assert.equal(f.calls.some(c=>['activate','bind_window'].includes(c.action)),false);
  const blocked=await f.run({action:'key',key:'ENTER'});assert.equal(blocked.success,false);assert.equal(blocked.metadata.desktop.dispatchedActions,0);assert.match(blocked.output,/Fresh observe/);
 }
});

test('expected closure without foreground or completed-input acknowledgement preserves focus-loss failure',async()=>{
 for(const windows of [
  [{handle:10,pid:1,title:'dialog',process:'fixture'},{handle:11,pid:1,title:'main',process:'fixture'}],
  [{handle:11,pid:99,title:'other app',process:'other'}],
  [],
 ]){
  let acted=false;const f=fixture({transport:async args=>{
   if(args.action==='key')acted=true;
   if(acted&&args.action==='session_state')return {success:true,output:JSON.stringify({ok:true,data:{handle:10,foreground:false}})};
   if(acted&&args.action==='list_windows')return {success:true,output:JSON.stringify({ok:true,data:{windows}})};
  }});
  await f.run({action:'observe',controlMode:'foreground'});const result=await f.run({action:'key',key:'ESC',expectWindowClosed:true});
  assert.equal(result.success,false);assert.match(result.output,/Target lost foreground/);assert.equal(result.metadata.desktop.verified,false);assert.equal(result.metadata.desktop.acknowledgedActions,1);assert.equal(f.calls.filter(c=>c.action==='key').length,1);
 }
});

test('dialog disappearance without explicit expectation retains normal focus-loss protection',async()=>{
 let acted=false;const f=fixture({transport:async args=>{
  if(args.action==='key')acted=true;
  if(acted&&args.action==='session_state')return {success:true,output:JSON.stringify({ok:true,data:{handle:10,foreground:false}})};
 }});
 await f.run({action:'observe',controlMode:'foreground'});const result=await f.run({action:'key',key:'ESC'});
 assert.equal(result.success,false);assert.match(result.output,/Target lost foreground/);assert.equal(f.calls.filter(c=>c.action==='list_windows').length,1);
});

test('window-closure expectation rejects background, CDP, unsupported actions and invalid flags before dispatch',async()=>{
 for(const [mode,action] of [
  [{},{action:'key',key:'ESC',expectWindowClosed:true}],
  [{backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'},{action:'click',target:{automationId:'saveButton'},expectWindowClosed:true}],
  [{controlMode:'foreground'},{action:'type',text:'not closure',expectWindowClosed:true}],
  [{controlMode:'foreground'},{action:'key',key:'ESC',expectWindowClosed:'true'}],
  [{controlMode:'foreground'},{action:'key',key:'ESC',expectWindowClosed:true,verifyText:'closed target'}],
 ]){
  const f=fixture();await f.run({action:'observe',...mode});const result=await f.run(action);assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);
  assert.equal(f.calls.some(c=>['key','click_element','type','type_element'].includes(c.action)),false);
 }
});

test('window-closure flag is prevalidated across the complete managed batch',async()=>{
 const f=fixture();await f.run({action:'observe',controlMode:'foreground'});
 const result=await f.run({action:'batch',actions:[{action:'click',target:{automationId:'saveButton'}},{action:'type',text:'bad',expectWindowClosed:true}]});
 assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);assert.equal(f.calls.some(c=>c.action==='click_element'),false);
});

test('native closure verifies the exact handle even for the last app window or a failed post-action session query',async()=>{
 for(const throwState of [false,true]){
  let acted=false;const f=fixture({transport:async args=>{
   if(args.action==='hotkey'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{inputCompleted:true,foregroundVerified:false}})};}
   if(acted&&args.action==='session_state')return throwState?{success:false,output:'bound window disappeared'}:{success:true,output:JSON.stringify({ok:true,data:{handle:0,foreground:false}})};
   if(acted&&args.action==='list_windows')return {success:true,output:JSON.stringify({ok:true,data:{windows:[]}})};
  }});
  await f.run({action:'observe',controlMode:'foreground'});
  const result=await f.run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true});
  assert.equal(result.success,true,result.output);assert.equal(result.metadata.desktop.verificationMethod,'window_closed');
  const query=f.calls.filter(c=>c.action==='list_windows').at(-1);
  assert.equal(query.handle,10);assert.equal(query.includeHidden,true);assert.equal(query.limit,1);
  assert.equal(result.metadata.desktop.observationToken,undefined);assert.equal(f.calls.some(c=>['activate','bind_window'].includes(c.action)),false);
  const next=await f.run({action:'key',key:'ENTER'});assert.equal(next.success,false);assert.equal(next.metadata.desktop.dispatchedActions,0);
 }
});

test('native closure refuses live hidden handles, malformed lists or rows, unrelated handles and incomplete input',async()=>{
 for(const scenario of ['hidden','malformed','malformed-row','unrelated-handle','failed-input']){
  let acted=false,polls=0;const f=fixture({transport:async args=>{
   if(args.action==='hotkey'){acted=true;return scenario==='failed-input'?{success:false,output:'partial input, no complete acknowledgement'}:{success:true,output:JSON.stringify({ok:true,data:{inputCompleted:true}})};}
   if(acted&&args.action==='session_state')return {success:false,output:'post-action session failed'};
   if(acted&&args.action==='list_windows'){polls++;return {success:true,output:JSON.stringify({ok:true,data:{windows:
    scenario==='hidden'?[{handle:10,pid:1,title:'hidden',visible:false}]:scenario==='malformed-row'?[{foo:'x'}]:scenario==='unrelated-handle'?[{handle:11,pid:1,title:'other'}]:null}})};}
  }});
  await f.run({action:'observe',controlMode:'foreground'});const before=f.calls.length;
  const result=await f.run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true});
  assert.equal(result.success,false);assert.equal(result.metadata.desktop.verified,false);
  assert.equal(f.calls.filter(c=>c.action==='hotkey').length,1);
  if(scenario==='failed-input'){assert.equal(result.metadata.desktop.acknowledgedActions,0);assert.equal(f.calls.slice(before).some(c=>c.action==='list_windows'),false);}
  if(['malformed','malformed-row','unrelated-handle'].includes(scenario))assert.equal(polls,1,'untrusted exact-query results fail immediately without polling');
 }
});

test('asynchronous native close polls only the original HWND until disappearance without replay or owner transfer',async()=>{
 let acted=false,polls=0;
 const f=fixture({transport:async args=>{
  if(args.action==='hotkey'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{inputCompleted:true,closurePendingVerification:true,foregroundVerified:false}})};}
  if(acted&&args.action==='session_state')return {success:true,output:JSON.stringify({ok:true,data:{handle:22,foreground:true,actualForeground:{handle:22,pid:99,title:'other'}}})};
  if(acted&&args.action==='list_windows'){
   assert.equal(args.handle,10);assert.equal(args.includeHidden,true);assert.equal(args.limit,1);
   return {success:true,output:JSON.stringify({ok:true,data:{windows:++polls<3?[{handle:10,pid:1,isVisible:false}]:[]}})};
  }
 }});
 await f.run({action:'observe',controlMode:'foreground'});
 const result=await f.run({action:'hotkey',keys:['ALT','F4'],allowClose:true,expectWindowClosed:true});
 assert.equal(result.success,true,result.output);assert.equal(polls,3);assert.equal(result.metadata.desktop.verificationMethod,'window_closed');
 assert.equal(JSON.parse(result.output).data.closedHandle,10);assert.equal(result.metadata.desktop.observationToken,undefined);
 assert.equal(f.calls.filter(c=>c.action==='hotkey').length,1);assert.equal(f.calls.filter(c=>c.action==='observe').length,1);
 assert.equal(f.calls.some(c=>['activate','bind_window'].includes(c.action)),false);
 const next=await f.run({action:'key',key:'ENTER'});assert.equal(next.success,false);assert.equal(next.metadata.desktop.dispatchedActions,0);
});

test('expected close of a permanently present HWND times out even when it stays foreground',async()=>{
 let acted=false,polls=0;
 const f=fixture({transport:async args=>{
  if(args.action==='key'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{inputCompleted:true,foregroundVerified:true}})};}
  if(acted&&args.action==='list_windows'){polls++;return {success:true,output:JSON.stringify({ok:true,data:{windows:[{handle:10,pid:1,isVisible:true}]}})};}
 }});
 await f.run({action:'observe',controlMode:'foreground'});
 const started=Date.now(),result=await f.run({action:'key',key:'ESC',expectWindowClosed:true});
 assert.equal(result.success,false);assert.match(result.output,/within 1500ms/);assert.equal(result.metadata.desktop.verified,false);
 assert.ok(polls>1&&polls<=16);assert.ok(Date.now()-started<2200,'one bounded closure wait, not repeated retry windows');
 assert.equal(f.calls.filter(c=>c.action==='key').length,1);assert.equal(f.calls.filter(c=>c.action==='observe').length,1);
});

test('cancellation during close polling stops reads and never dispatches another input',async()=>{
 let acted=false,polls=0;const abort=new AbortController();
 const f=fixture({transport:async args=>{
  if(args.action==='key'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{inputCompleted:true}})};}
  if(acted&&args.action==='list_windows'){polls++;setTimeout(()=>abort.abort(),15);return {success:true,output:JSON.stringify({ok:true,data:{windows:[{handle:10}]}})};}
 }});
 await f.run({action:'observe',controlMode:'foreground'});
 const result=await f.run({action:'key',key:'ESC',expectWindowClosed:true},'a',abort.signal);
 assert.equal(result.success,false);assert.equal(result.cancelled,true);assert.equal(result.metadata.desktop.verified,false);assert.equal(polls,1);
 await new Promise(resolve=>setTimeout(resolve,130));assert.equal(polls,1);
 assert.equal(f.calls.filter(c=>c.action==='key').length,1);assert.equal(f.calls.some(c=>['activate','bind_window'].includes(c.action)),false);
});

test('a stalled exact-window query is bounded and its late completion cannot resume close polling',async()=>{
 let acted=false,polls=0,release;
 const gate=new Promise(resolve=>release=resolve);
 const f=fixture({transport:async(args,signal)=>{
  if(args.action==='key'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{inputCompleted:true}})};}
  if(acted&&args.action==='list_windows'){polls++;await gate;assert.equal(signal.aborted,true);return {success:true,output:JSON.stringify({ok:true,data:{windows:[]}})};}
 }});
 await f.run({action:'observe',controlMode:'foreground'});const started=Date.now();
 const result=await f.run({action:'key',key:'ESC',expectWindowClosed:true});assert.equal(result.success,false);assert.match(result.output,/within 1500ms/);assert.ok(Date.now()-started<2200);
 release();await tick();assert.equal(polls,1);assert.equal(f.calls.filter(c=>c.action==='key').length,1);
});

test('hotkey count is validated before any single or batch dispatch and valid counts are forwarded',async()=>{
 for(const count of [0,51,-1,1.5,'2',null]){
  for(const batch of [false,true]){
   const f=fixture();await f.run({action:'observe',controlMode:'foreground'});const before=f.calls.length;
   const hotkey={action:'hotkey',keys:['CTRL','Z'],count};
   const result=await f.run(batch?{action:'batch',actions:[{action:'key',key:'ENTER'},hotkey]}:hotkey);
   assert.equal(result.success,false);assert.match(result.output,/hotkey count/);assert.equal(result.metadata.desktop.dispatchedActions,0);assert.equal(f.calls.length,before);
  }
 }
 for(const count of [1,50]){
  const f=fixture();await f.run({action:'observe',controlMode:'foreground'});
  const result=await f.run({action:'hotkey',keys:['CTRL','Z'],count});assert.equal(result.success,true,result.output);
  assert.equal(f.calls.find(c=>c.action==='hotkey').count,count);
 }
});

test('acknowledged focus loss returns bounded read-only foreground candidates without transferring ownership',async()=>{
 let acted=false;const f=fixture({transport:async args=>{
  if(args.action==='key'){acted=true;return {success:true,output:JSON.stringify({ok:true,data:{foregroundVerified:true,inputCompleted:true}})};}
  if(acted&&args.action==='session_state')return {success:true,output:JSON.stringify({ok:true,data:{handle:10,foreground:false,actualForeground:{handle:22,pid:2,title:'Archive dialog',process:'other'}}})};
  if(acted&&args.action==='list_windows')return {success:true,output:JSON.stringify({ok:true,data:{windows:Array.from({length:20},(_,i)=>({handle:100+i,pid:1,title:'candidate '+i,process:'fixture'}))}})};
 }});
 await f.run({action:'observe',controlMode:'foreground'});
 const result=await f.run({action:'key',key:'ENTER'});
 assert.equal(result.success,false);assert.equal(result.metadata.desktop.acknowledgedActions,1);
 const recovery=result.metadata.desktop.foregroundRecovery;
 assert.equal(recovery.actualForeground.handle,22);assert.equal(recovery.relatedCandidates.length,12);
 assert.deepEqual(recovery.nextObservation,{action:'observe',handle:22});
 assert.deepEqual(JSON.parse(result.output.split('\n').find(line=>line.startsWith('{'))).foregroundRecovery.nextObservation,{action:'observe',handle:22});
 assert.equal(recovery.nextObservation.activate,undefined);assert.equal(recovery.nextObservation.focusPolicy,undefined);
 assert.equal(f.calls.some(c=>c.action==='observe'&&c.handle===22),false,'recovery hint never executes the candidate observation automatically');
 assert.equal(f.calls.some(c=>['activate','bind_window'].includes(c.action)),false);
 const next=await f.run({action:'key',key:'ENTER'});assert.equal(next.success,false);assert.equal(next.metadata.desktop.dispatchedActions,0);
 assert.equal(f.calls.filter(c=>c.action==='key').length,1);
});

test('explicit rendererInput is forwarded for observed CDP clicks and rejected on native',async()=>{
 const f=fixture();await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const result=await f.run({action:'click',target:{automationId:'saveButton'},rendererInput:true});assert.equal(result.success,true,result.output);
 const click=f.calls.find(c=>c.action==='click_element');assert.equal(click.rendererInput,true);assert.equal(click.elementId,'save');assert.equal(click.background,true);assert.equal(click.autoActivate,false);
 for(const [observe,args] of [
  [{controlMode:'foreground'},{action:'click',target:{automationId:'saveButton'},rendererInput:true}],
  [{backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'},{action:'key',key:'ESC',rendererInput:true}],
  [{backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'},{action:'click',target:{automationId:'saveButton'},rendererInput:'true'}],
 ]){
  const rejected=fixture();await rejected.run({action:'observe',...observe});const r=await rejected.run(args);assert.equal(r.success,false);assert.equal(r.metadata.desktop.dispatchedActions,0);assert.match(r.output,/rendererInput/);
 }
});

test('rendererInput is validated for all batch steps before the first click dispatch',async()=>{
 const f=fixture();await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 const result=await f.run({action:'batch',actions:[{action:'click',target:{automationId:'saveButton'}},{action:'type',target:{automationId:'saveButton'},text:'no',rendererInput:true}]});
 assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);assert.equal(f.calls.some(c=>c.action==='click_element'),false);
});

function cdpClosingFixture({stillOpen=false,acknowledged=true,throwState=false,closeDuringObserve=false}={}){
 let acted=false,postListed=0;
 const window={handle:10,pid:0,title:'Desktop live',process:'chromium',cdpTargetId:'live-target'};
 const f=fixture({transport:async args=>{
  if(args.action==='click_element'){
   acted=true;return {success:acknowledged,output:acknowledged?JSON.stringify({ok:true,data:{inputMechanism:'cdp-dom'}}):'CDP connection interrupted before acknowledgement'};
  }
  if(args.action==='list_windows'){
   if(acted)postListed++;
   const visible=!acted||stillOpen||closeDuringObserve&&postListed===1;
   return {success:true,output:JSON.stringify({ok:true,data:{windows:visible?[window]:[{handle:11,pid:0,title:'Main',process:'chromium',cdpTargetId:'main-target'}]}})};
  }
  if(acted&&args.action==='session_state'&&throwState)return {success:false,output:'Chromium page target not found; no first-tab fallback'};
  if(acted&&args.action==='observe'&&closeDuringObserve)return {success:false,output:'Chromium page target not found during post-observation'};
 }});
 return f;
}

test('acknowledged CDP close verifies exact target disappearance without selecting another tab',async()=>{
 const f=cdpClosingFixture();await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222',cdpTargetId:'live-target'});
 const result=await f.run({action:'click',target:{automationId:'saveButton'},expectWindowClosed:true});assert.equal(result.success,true,result.output);
 const data=JSON.parse(result.output).data;assert.equal(data.targetClosed,true);assert.equal(data.windowClosed,true);assert.equal(data.cdpTargetId,'live-target');assert.equal(data.needsObservation,true);
 assert.equal(result.metadata.desktop.acknowledgedActions,1);assert.equal(result.metadata.desktop.verified,true);assert.equal(result.metadata.desktop.verificationMethod,'window_closed');assert.equal(result.metadata.desktop.observationToken,undefined);
 assert.equal(f.calls.filter(c=>c.action==='observe').length,1);assert.equal(f.calls.filter(c=>c.action==='click_element').length,1);assert.equal(f.calls.some(c=>['activate','bind_window'].includes(c.action)),false);
 const queries=f.calls.filter(c=>c.action==='list_windows');assert.ok(queries.every(c=>c.cdpEndpoint==='http://127.0.0.1:9222'&&c.cdpTargetId==='live-target'));
 const blocked=await f.run({action:'key',key:'ESC'});assert.equal(blocked.success,false);assert.equal(blocked.metadata.desktop.dispatchedActions,0);assert.match(blocked.output,/Fresh observe/);
});

test('CDP close never swallows missing acknowledgement or errors while exact target remains',async()=>{
 for(const options of [{acknowledged:false},{stillOpen:true,throwState:true}]){
  const f=cdpClosingFixture(options);await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222',cdpTargetId:'live-target'});
  const before=f.calls.filter(c=>c.action==='list_windows').length;
  const result=await f.run({action:'click',target:{automationId:'saveButton'},expectWindowClosed:true});assert.equal(result.success,false);assert.equal(result.metadata.desktop.verified,false);
  if(options.acknowledged===false){assert.equal(result.metadata.desktop.acknowledgedActions,0);assert.equal(f.calls.filter(c=>c.action==='list_windows').length,before);assert.match(result.output,/before acknowledgement/);}
  else {assert.equal(result.metadata.desktop.acknowledgedActions,1);assert.match(result.output,/target not found/);}
 }
});

test('CDP closure between session state and post-observation still verifies disappearance without replay',async()=>{
 const f=cdpClosingFixture({closeDuringObserve:true});await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222',cdpTargetId:'live-target'});
 const result=await f.run({action:'click',target:{automationId:'saveButton'},expectWindowClosed:true});assert.equal(result.success,true,result.output);assert.equal(JSON.parse(result.output).data.targetClosed,true);
 assert.equal(f.calls.filter(c=>c.action==='click_element').length,1);assert.equal(result.metadata.desktop.acknowledgedActions,1);
});

test('CDP closure expectation requires exact target identity before any action in a batch',async()=>{
 const f=fixture();await f.run({action:'observe',backend:'chromium-cdp',cdpEndpoint:'http://127.0.0.1:9222'});
 for(const action of [
  {action:'click',target:{automationId:'saveButton'},expectWindowClosed:true},
  {action:'batch',actions:[{action:'click',target:{automationId:'saveButton'}},{action:'click',target:{automationId:'saveButton'},expectWindowClosed:true}]},
 ]){const result=await f.run(action);assert.equal(result.success,false);assert.equal(result.metadata.desktop.dispatchedActions,0);assert.match(result.output,/exact observed cdpTargetId/);}
 assert.equal(f.calls.some(c=>c.action==='click_element'),false);
});
