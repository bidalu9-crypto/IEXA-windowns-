const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const script=fs.readFileSync(path.join(__dirname,'../src/renderer/components/PermissionDialog.js'),'utf8');
function fixture(t){const dom=new JSDOM('<button id="original">Send</button>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.IexaApi={json:async()=>({ok:true})};w.eval(script);w.document.getElementById('original').focus();return w;}
const data={id:'permission-1',sessionId:'s',toolCallId:'c',runId:'r',tool:{name:'test',risk:'low'},args:{command:'<script>bad</script>'}};
test('permission dialog renders text, traps keyboard focus and restores it on matched tool cancellation',t=>{
 const w=fixture(t);w.IexaPermissionDialog.show(data);const d=w.document;const overlay=d.querySelector('[role="dialog"]');assert.ok(overlay);assert.equal(d.querySelector('script'),null);assert.equal(d.activeElement.textContent,'拒绝');
 overlay.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(d.activeElement.textContent,'允许本会话');
 w.IexaPermissionDialog.closeForTool('s','c','old-run');assert.ok(overlay.isConnected);
 w.IexaPermissionDialog.closeForTool('s','c','r');assert.equal(overlay.isConnected,false);assert.equal(d.activeElement.id,'original');
});
test('permission acceptance is submitted once and a later cancellation dismisses stale UI',async t=>{
 const w=fixture(t);let calls=0,finish;w.IexaApi.json=()=>{calls++;return new Promise(r=>finish=r);};w.IexaPermissionDialog.show(data);
 const once=w.document.querySelectorAll('.permission-dialog button')[1];once.click();once.click();assert.equal(calls,1);
 w.IexaPermissionDialog.closeSession('s');finish({ok:true});await new Promise(r=>setImmediate(r));assert.equal(w.document.querySelector('[role="dialog"]'),null);
});
test('expiry dismisses the request without sending an approval',async t=>{
 const w=fixture(t);let calls=0;w.IexaApi.json=async()=>{calls++;};w.IexaPermissionDialog.show({...data,expiresAt:Date.now()+20});await new Promise(r=>setTimeout(r,40));assert.equal(w.document.querySelector('[role="dialog"]'),null);assert.equal(calls,0);
});
test('closing one session leaves another session approval intact',t=>{
 const w=fixture(t);w.IexaPermissionDialog.show(data);w.IexaPermissionDialog.show({...data,id:'p2',sessionId:'s2'});w.IexaPermissionDialog.closeSession('s');assert.equal(w.document.querySelectorAll('[role="dialog"]').length,1);assert.equal(w.document.querySelector('[role="dialog"]').dataset.permissionId,'p2');
});
