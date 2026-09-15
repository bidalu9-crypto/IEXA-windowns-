const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {handleRuntimeRoute}=require('../dist/main/api/RuntimeRoutes');
const {PermissionBroker}=require('../dist/main/security/PermissionManager');

test('real HTTP cancel route acknowledges the request without releasing the active-session fence',async t=>{
 const calls=[];const context={permissionBroker:new PermissionBroker(),cancelSession:id=>calls.push(['cancel',id]),clearRunningSession:()=>assert.fail('active run fence released early'),cancelLiveJobs:(id,settled)=>calls.push(['jobs',id,settled])};
 const server=http.createServer((req,res)=>{handleRuntimeRoute(req,res,new URL(req.url,'http://localhost'),context).then(handled=>{if(!handled)res.writeHead(404).end();}).catch(e=>res.writeHead(500).end(e.message));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const address=`http://127.0.0.1:${server.address().port}/api/cancel?sessionId=s`;
 const get=await fetch(address);assert.equal(get.status,404);assert.equal(calls.length,0);
 const post=await fetch(address,{method:'POST'});assert.equal(post.status,200);assert.deepEqual(await post.json(),{ok:true});assert.deepEqual(calls,[['cancel','s'],['jobs','s',false]]);
});
