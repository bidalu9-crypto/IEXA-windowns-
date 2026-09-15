const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readDesktopPreview } = require('../dist/main/tools/desktop/DesktopPreview');
async function fixture(t, health, mode = 'cached-observation') {
 const paths=[];
 const server=http.createServer((req,res)=>{paths.push(req.url);if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(health));}
 else {res.setHeader('Content-Type','image/png');res.setHeader('X-IEXA-Frame-Mode',mode);res.setHeader('X-Captured-At','1000');res.end(Buffer.from('cached-image-fixture'));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return {endpoint:`http://127.0.0.1:${server.address().port}`,paths};
}
test('paused native agent receives health only, not any frame request',async t=>{
 const f=await fixture(t,{product:'IEXA Desktop Agent',cachedPreview:true,paused:true});const result=await readDesktopPreview(f.endpoint);assert.equal(result.status,423);assert.equal((await result.json()).paused,true);assert.deepEqual(f.paths,['/health']);
});
test('legacy agents which silently ignore cached=1 are not queried for preview',async t=>{
 const f=await fixture(t,{product:'IEXA Desktop Agent',protocolVersion:5,paused:false});assert.equal((await readDesktopPreview(f.endpoint)).status,409);assert.deepEqual(f.paths,['/health']);
});
test('preview rejects wrong helper identity without a frame request',async t=>{
 const f=await fixture(t,{product:'other server',cachedPreview:true,paused:false});assert.equal((await readDesktopPreview(f.endpoint)).status,409);assert.deepEqual(f.paths,['/health']);
});
test('preview requests only cached bound-window pixels, preserving their original timestamp',async t=>{
 const f=await fixture(t,{product:'IEXA Desktop Agent',cachedPreview:true,paused:false});const result=await readDesktopPreview(f.endpoint);assert.equal(result.status,200);assert.equal(result.headers.get('x-captured-at'),'1000');assert.equal(await result.text(),'cached-image-fixture');assert.equal(f.paths.length,2);assert.match(f.paths[1],/^\/frame\?full=0&cached=1&/);
});
test('a helper returning fresh capture for a cached request gets no retry or fallback',async t=>{
 const f=await fixture(t,{product:'IEXA Desktop Agent',cachedPreview:true,paused:false},'capture');assert.equal((await readDesktopPreview(f.endpoint)).status,409);assert.equal(f.paths.length,2);
});
