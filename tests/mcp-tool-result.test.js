const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMcpToolResult: normalize } = require('../dist/main/mcp/McpToolResult');
const { McpManager } = require('../dist/main/mcp/McpManager');
const { AgentLoop } = require('../dist/main/agent/AgentLoop');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
test('MCP text, structured results, and explicit tool failure are not confused with transport success', () => {
  const r = normalize({ content: [{ type: 'text', text: 'Sending failed' }], structuredContent: { sent: false }, isError: true });
  assert.equal(r.success, false); assert.match(r.output, /Sending failed/); assert.match(r.output, /"sent": false/);
  assert.equal(normalize({ content: [], isError: false }).success, true);
});
test('MCP images use ordered binary channels rather than base64 tool text, without duplicate preview', () => {
  const r = normalize({ content: [{ type: 'text', text: 'Before/after images' }, image, image] });
  assert.equal(r.success, true); assert.equal(r.images.length, 2); assert.deepEqual(r.imageData, Buffer.from(png, 'base64'));
  assert.equal(r.images[0].data, r.imageData); assert.ok(!r.output.includes(png)); assert.match(r.output, /MCP image 2/);
});
test('an MCP error keeps its diagnostic image but never becomes a successful tool', () => {
  const r = normalize({ content: [image], isError: true });
  assert.equal(r.success, false); assert.equal(r.images.length, 1); assert.equal(r.metadata.mcp.reportedError, true);
});
test('malformed or missing MCP result data is reported, not accepted as successful', () => {
  for (const input of [null, 'ok', [], {}, { content: [] , isError: 'false' }, { content: 'bad', structuredContent: {} }, { content: [{type:'text'}] }, { content: [], structuredContent: [] }]) assert.equal(normalize(input).success, false, JSON.stringify(input));
});
test('MCP image validation rejects external URLs, invalid base64, misleading MIME and oversized input without fallback fetch', () => {
  for (const bad of [ { ...image, data:'https://example.invalid/screen.png' }, { ...image, data:'????' }, { ...image, mimeType:'text/html' }, { ...image, data:Buffer.from('<html>').toString('base64') }, { ...image, data:'A'.repeat(8*1024*1024+4) } ]) {
    const r=normalize({content:[bad]}); assert.equal(r.success,false);assert.equal(r.images,undefined);assert.match(r.output,/Do not repeat input/);
  }
});
test('MCP multiple images have a bounded count and omitted data is explicit failure', () => {
  const r = normalize({content:Array(9).fill(image)}); assert.equal(r.images.length,8);assert.equal(r.success,false);assert.match(r.output,/more than 8/);
});
test('MCP resource links stay references; unknown/binary blocks are not silently thrown away', () => {
  const r=normalize({content:[{type:'resource',resource:{uri:'test://note',text:'note'}},{type:'resource_link',name:'doc',uri:'https://example.invalid/doc'}]});
  assert.equal(r.success,true);assert.match(r.output,/note/);assert.match(r.output,/example.invalid/);
  for(const block of [{type:'audio',data:'SECRET_BINARY'},{type:'resource',resource:{uri:'test://binary',blob:'SECRET_BINARY'}}]) {
    const result=normalize({content:[block]});assert.equal(result.success,false);assert.ok(!result.output.includes('SECRET_BINARY'));
  }
});
for (const fail of [false,true]) test(`real stdio MCP -> tool runtime -> model input preserves two images and isError=${fail}`, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-mcp-contract-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^iexa-mcp-contract-/);fs.rmSync(dir,{recursive:true,force:true});});
  const manager=new McpManager(path.join(dir,'mcp.json'));
  const server=manager.add({name:'fixture',transport:'stdio',command:process.execPath,args:[path.resolve('scripts/fixtures/mcp-tool-result-server.cjs')],enabled:true});
  t.after(()=>manager.disconnect(server.id));
  assert.equal((await manager.connect(server.id)).status,'connected');
  const runtime=new ToolRuntime({workspaceDir:dir,memoryDir:path.join(dir,'memory'),permissionMode:'full'});
  runtime.registerDynamicTool({name:'mcp_snapshot',description:'Fixture only',parameters:{},required:[]},async()=>normalize(await manager.callTool(server.id,'snapshot',{fail})));
  runtime.beginRun();let requests=0,done=false;const events=[];
  const provider={model:'test-model',name:'openai',defaultMaxTokens:1024,async *streamMessage(messages){
    if(++requests===1){yield {type:'toolCallComplete',id:'snapshot-1',name:'mcp_snapshot',args:{}};yield {type:'done',stopReason:'toolUse'};}
    else {
      const parts=messages.at(-1).parts;const result=parts.find(p=>p.type==='toolResult'&&p.id==='snapshot-1');
      assert.equal(result.isError,fail);assert.ok(!result.content.includes(png));
      const images=parts.filter(p=>p.type==='imageData');assert.equal(images.length,2);assert.ok(images.every(i=>i.data.equals(Buffer.from(png,'base64'))));
      yield {type:'textDelta',text:'Protocol verified, not desktop task completion.'};yield {type:'done',stopReason:'endTurn'};
    }
  }};
  const loop=new AgentLoop({sessionId:'mcp-contract',workspaceDir:dir,memoryDir:path.join(dir,'memory'),memoryEnabled:false,provider,toolRuntime:runtime,contextWindow:200000,getAbortSignal:()=>new AbortController().signal});
  const noop=()=>{};await loop.run('Inspect the fixture',runtime.definitions(),{onTextDelta:noop,onThinkingDelta:noop,onToolCallStart:noop,onToolInputDelta:noop,onToolCallComplete:noop,onToolResult:noop,onUsage:noop,onContext:noop,onToolState:e=>events.push(e),onError:e=>assert.fail(e),onDone:()=>done=true,onCancelled:()=>assert.fail('unexpected cancellation')});
  assert.equal(requests,2);assert.equal(done,true);assert.ok(events.some(e=>e.status===(fail?'failed':'completed')));
});
