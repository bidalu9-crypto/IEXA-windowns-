const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-http-security-'));
process.env.IEXA_WORKSPACE = path.join(fixture, 'workspace');
fs.mkdirSync(process.env.IEXA_WORKSPACE);
const backend = require('../dist/main/server');
const { readBody } = require('../dist/main/api/HttpServer');
let server, port, credentials;
function request(route, options = {}) {
  const transport = options.tls ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { ...(options.auth === false ? {} : { Authorization: `Bearer ${credentials.token}` }), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    const req = transport.request({ hostname: '127.0.0.1', port: options.port || port, path: route, method: options.method || 'GET', headers, rejectUnauthorized: false }, res => {
      const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('request timeout')));req.end(options.body);
  });
}
test.before(async()=>{server=await backend.startServer(0,false);port=server.address().port;credentials=backend.getServerCredentials(server);});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(fixture,{recursive:true,force:true});});

test('default listener is loopback and anonymous sensitive APIs require identity', async()=>{
  assert.equal(server.address().address,'127.0.0.1');
  assert.equal((await request('/api/appearance',{auth:false})).status,401);
  assert.equal((await request('/api/terminal/sessions',{auth:false,method:'POST',body:'{}'})).status,401);
  assert.equal((await request('/api/appearance')).status,200);
  await assert.rejects(backend.startServer(0,false,'0.0.0.0'),/loopback/);
});
test('Host, Origin, Fetch Metadata and preflight fail closed even with credentials',async()=>{
  for(const headers of [{Host:`audit.invalid:${port}`},{Origin:'https://audit.invalid'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}]) assert.equal((await request('/api/appearance',{headers})).status,403);
  assert.equal((await request('/api/appearance',{method:'OPTIONS',headers:{Origin:'https://audit.invalid'}})).status,403);
  assert.equal((await request('/api/appearance')).headers['access-control-allow-origin'],undefined);
});
test('desktop one-time bootstrap uses HttpOnly Strict port-scoped cookie; root never issues identity',async()=>{
  const root=await request('/',{auth:false});assert.equal(root.status,200);assert.equal(root.headers['set-cookie'],undefined);assert.match(root.body,/auth-login.js/);
  const login=await request('/api/auth/bootstrap',{auth:false,method:'POST',body:JSON.stringify({token:credentials.loginCode})});assert.equal(login.status,200);
  const cookie=login.headers['set-cookie'][0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,new RegExp(credentials.cookieName));
  assert.equal((await request('/api/appearance',{auth:false,headers:{Cookie:cookie.split(';')[0]}})).status,200);
  assert.equal((await request('/api/auth/bootstrap',{auth:false,method:'POST',body:JSON.stringify({token:credentials.loginCode})})).status,401);
});
test('UTF8 request body preserves every split position including emoji',async()=>{
  const text=JSON.stringify({text:'中文😀'}), bytes=Buffer.from(text);
  for(let offset=1;offset<bytes.length;offset++){
    const req=new PassThrough();req.headers={};req.complete=true;const parsed=readBody(req);req.write(bytes.subarray(0,offset));req.end(bytes.subarray(offset));assert.equal(await parsed,text);
  }
});
test('oversize body returns 413 and aborted body settles without orphan timers',async()=>{
  const req=new PassThrough();req.headers={};const promise=readBody(req,2);req.end('four');await assert.rejects(promise,e=>e.status===413);
  const aborted=new PassThrough();aborted.headers={};const pending=readBody(aborted);aborted.emit('aborted');await assert.rejects(pending,e=>e.status===400);
});
test('malformed URL yields 400 without killing the server; legacy GET mutations rejected',async()=>{
  assert.equal((await request('/%ZZ')).status,400);
  assert.equal((await request('/api/health',{auth:false})).status,200);
  assert.equal((await request('/api/reset')).status,404);
  assert.equal((await request('/api/cancel')).status,404);
});
test('raw and preview block junction escapes and internal settings with positive public file control',async()=>{
  const outside=path.join(fixture,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'marker.txt'),'OUTSIDE');
  fs.symlinkSync(outside,path.join(process.env.IEXA_WORKSPACE,'junction'),'junction');
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE,'public.txt'),'PUBLIC');fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE,'.env'),'TEST_SECRET');
  assert.equal((await request('/api/fs/raw?path=public.txt')).body,'PUBLIC');
  for(const route of ['/api/fs/raw?path=junction/marker.txt','/api/fs/preview/workspace/junction/marker.txt','/api/fs/raw?path=.iexa-mobile-bridge.json','/api/fs/raw?path=.env']) assert.notEqual((await request(route)).status,200,route);
});
test('active raw and preview documents get response-level opaque sandbox and no API connectivity',async()=>{
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE,'preview.html'),'<script>document.title="fixture"</script>');
  for(const route of ['/api/fs/raw?path=preview.html','/api/fs/preview/workspace/preview.html']){
    const r=await request(route);assert.equal(r.status,200,route+" "+r.body);assert.match(r.headers['content-security-policy'],/sandbox allow-scripts;/);assert.doesNotMatch(r.headers['content-security-policy'],/allow-same-origin/);assert.match(r.headers['content-security-policy'],/connect-src 'none'/);assert.equal(r.headers['x-content-type-options'],'nosniff');
  }
  const app=await request('/');assert.match(app.headers['content-security-policy'],/script-src 'self';/);assert.doesNotMatch(app.body,/https:\/\/cdn/);
});
test('same-offset upload writes are serialized; identical retry is idempotent',async()=>{
  const initialized=await request('/api/uploads/init',{method:'POST',body:JSON.stringify({sessionId:'audit',name:'test.txt',size:8388609})});assert.equal(initialized.status,200);
  const id=JSON.parse(initialized.body).uploadId;
  function chunk(letter){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:`/api/uploads/chunk?uploadId=${id}&offset=0`,method:'POST',headers:{Authorization:`Bearer ${credentials.token}`,'Content-Length':'2'}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.write(letter);setTimeout(()=>req.end(letter),25);});}
  const r=await Promise.all([chunk('A'),chunk('B')]);assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);
  const file=path.join(process.env.IEXA_WORKSPACE,'uploads/audit/.chunks',id+'.part');const data=fs.readFileSync(file);assert.equal(data.length,2);
  const again=await request(`/api/uploads/chunk?uploadId=${id}&offset=0`,{method:'POST',body:data});assert.equal(again.status,200);assert.equal(JSON.parse(again.body).duplicate,true);assert.equal(fs.statSync(file).size,2);
  assert.equal((await request('/api/uploads/complete',{method:'POST',body:JSON.stringify({uploadId:id})})).status,409);
});
test('upload reservations have bounded per-owner quota',async()=>{
  let status;
  for(let n=0;n<9;n++){status=(await request('/api/uploads/init',{method:'POST',body:JSON.stringify({sessionId:'quota',name:'test.bin',size:8388609})})).status;}
  assert.equal(status,429);
});
test('mobile pairing only uses TLS, chat devices do not receive approvals or project mutation capability',async()=>{
  assert.equal((await request('/api/mobile-bridge/pair',{auth:false,method:'POST',body:'{}'})).status,403);
  const enabled=await request('/api/mobile-bridge/config',{method:'PUT',body:'{"enabled":true,"defaultCapability":"chat"}'});assert.equal(enabled.status,200,enabled.body);
  const mobilePort=JSON.parse(enabled.body).port;assert.ok(mobilePort);
  const token=JSON.parse((await request('/api/mobile-bridge/pair-token',{method:'POST',body:'{"address":"127.0.0.1"}'})).body);
  assert.match(token.url,/^https:/);assert.ok(token.url.includes('#pair='));
  const paired=await request('/api/mobile-bridge/pair',{tls:true,port:mobilePort,auth:false,method:'POST',body:JSON.stringify({token:token.token,name:'test-chat'})});assert.equal(paired.status,200,paired.body);
  const cookie=paired.headers['set-cookie'][0];assert.match(cookie,/Secure/);assert.match(cookie,/HttpOnly/);
  const options={tls:true,port:mobilePort,auth:false,headers:{Cookie:cookie.split(';')[0]}};
  assert.equal((await request('/api/sessions',options)).status,200);
  assert.equal((await request('/api/permissions',options)).status,403);
  assert.equal((await request('/api/permissions/approve',{...options,method:'POST',body:'{"id":"nothing"}'})).status,403);
  assert.equal((await request('/api/project',{...options,method:'POST',body:JSON.stringify({root:fixture})})).status,403);
  const disabled=await request('/api/mobile-bridge/config',{method:'PUT',body:'{"enabled":false}'});assert.equal(disabled.status,200);
});


test('canonical selected project root is protected even when selected through a directory alias',async()=>{
  const project=path.join(fixture,'selected-project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'marker.txt'),'KEEP');
  const alias=path.join(fixture,'project-alias');fs.symlinkSync(project,alias,'junction');
  const chosen=await request('/api/project',{method:'POST',body:JSON.stringify({root:alias})});assert.equal(chosen.status,200);assert.equal(JSON.parse(chosen.body).root,fs.realpathSync.native(project));
  const deletion=await request('/api/fs/delete',{method:'POST',body:'{"path":"."}'});assert.equal(deletion.status,400);assert.equal(fs.readFileSync(path.join(project,'marker.txt'),'utf8'),'KEEP');
  const list=await request('/api/fs/list');assert.equal(list.status,200);assert.doesNotMatch(list.body,/\.\.\//);
  await request('/api/project/clear',{method:'POST',body:'{}'});
});
