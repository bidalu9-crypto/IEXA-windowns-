const {test}=require('node:test');const assert=require('node:assert/strict');const {StreamBatcher}=require('../dist/main/api/StreamBatcher');
test('server stream batching preserves thinking/text/tool-input boundaries',()=>{
 const sent=[];const b=new StreamBatcher((event,data)=>sent.push([event,data]),60000);
 b.emit('thinking',{content:'first'});b.emit('thinking',{content:' phase'});b.emit('text',{content:'A'});b.emit('text',{content:'AB'});b.emit('thinking',{content:'second'});b.emit('tool_input',{id:'a',args:'{'});b.emit('tool_input',{id:'b',args:'{'});b.emit('tool_input',{id:'a',args:'{}'});b.emit('tool_start',{id:'c'});
 assert.deepEqual(sent.map(x=>x[0]),['thinking','text','thinking','tool_input','tool_input','tool_input','tool_start']);assert.equal(sent[0][1].content,'first phase');assert.equal(sent[1][1].content,'AB');assert.deepEqual(sent.slice(3,6).map(x=>x[1].id),['a','b','a']);
});
test('server batching replaces adjacent input snapshots and flush is idempotent',()=>{
 const sent=[];const b=new StreamBatcher((event,data)=>sent.push([event,data]),60000);b.emit('tool_input',{id:'a',args:'{'});b.emit('tool_input',{id:'a',args:'{}'});b.flush();b.flush();assert.equal(sent.length,1);assert.equal(sent[0][1].args,'{}');
});
test('server batch timer flushes in original event order',async()=>{
 const sent=[];const b=new StreamBatcher((event)=>sent.push(event),10);b.emit('thinking',{content:'r'});b.emit('text',{content:'t'});await new Promise(r=>setTimeout(r,35));assert.deepEqual(sent,['thinking','text']);
});
