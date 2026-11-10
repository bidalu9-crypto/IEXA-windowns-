const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {handleRuntimeRoute}=require('../dist/main/api/RuntimeRoutes');
const {PermissionBroker}=require('../dist/main/security/PermissionManager');
const {QuestionBroker}=require('../dist/main/runtime/QuestionBroker');

test('real HTTP cancel route acknowledges the request without releasing the active-session fence',async t=>{
 const calls=[];const questionBroker=new QuestionBroker();
 const pending=questionBroker.request({sessionId:'s',title:'T',questions:[{id:'q1',question:'Q',options:[],multiSelect:false,allowFreeText:true,kind:'text'}]});
 let running=true;const agent={isRunning:()=>running,getState:()=>({status:running?'running':'cancelled'}),getObservability:()=>({})};
 const context={agents:new Map([['s',agent]]),permissionBroker:new PermissionBroker(),questionBroker,cancelSession:id=>calls.push(['cancel',id]),clearRunningSession:()=>assert.fail('active run fence released early'),cancelLiveJobs:(id,settled)=>calls.push(['jobs',id,settled])};
 const server=http.createServer((req,res)=>{handleRuntimeRoute(req,res,new URL(req.url,'http://localhost'),context).then(handled=>{if(!handled)res.writeHead(404).end();}).catch(e=>res.writeHead(500).end(e.message));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const address=`http://127.0.0.1:${server.address().port}/api/cancel?sessionId=s`;
 const get=await fetch(address);assert.equal(get.status,404);assert.equal(calls.length,0);
 const post=await fetch(address,{method:'POST'});assert.equal(post.status,200);assert.deepEqual(await post.json(),{ok:true,sessionId:'s',settled:false,status:'running'});assert.deepEqual(calls,[['cancel','s'],['jobs','s',false]]);
 const stateURL=address.replace('/api/cancel?','/api/agent/state?');assert.equal((await (await fetch(stateURL)).json()).running,true);
 running=false;const settled=await (await fetch(stateURL)).json();assert.equal(settled.running,false);assert.equal(settled.state.status,'cancelled');
 assert.equal(await pending,null,'pending question must be released by the cancel route');
});
