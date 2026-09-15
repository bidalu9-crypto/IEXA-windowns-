/* Actual production server + local OpenAI-compatible HTTP fixture; no account/gateway calls. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');const root=path.resolve(__dirname,'..'),out=process.env.IEXA_TEST_ARTIFACT_DIR ? path.resolve(process.env.IEXA_TEST_ARTIFACT_DIR) : path.join(root,'.iexa-artifacts/multi-agent-20260915');
if(process.argv[2]==='--worker'){
 process.env.IEXA_WORKSPACE=process.argv[3];
 const {startServer,getServerCredentials}=require('../dist/main/server');
 startServer(0,false).then(server=>{
  process.send({ready:true,port:server.address().port,token:getServerCredentials(server).token});
  process.on('message',message=>{if(message==='stop'){server.closeAllConnections();server.close(()=>process.exit(0));}});
 }).catch(error=>{console.error(error);process.exit(1);});
}else{
 const result={cases:[]};let fixture,worker,temp,controller,streamWork;const pause=ms=>new Promise(r=>setTimeout(r,ms));
 async function boot(){
  worker=fork(__filename,['--worker',temp],{cwd:root,stdio:['ignore','pipe','pipe','ipc']});
  worker.stdout.on('data',data=>fs.appendFileSync(path.join(out,'http-server.log'),data));worker.stderr.on('data',data=>fs.appendFileSync(path.join(out,'http-server.log'),data));
  const info=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timed out')),15000);worker.once('message',info=>{clearTimeout(timer);resolve(info);});worker.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});});
  return {base:`http://127.0.0.1:${info.port}`,headers:{Authorization:'Bearer '+info.token,'Content-Type':'application/json'}};
 }
 async function stop(){if(!worker)return;const current=worker;worker=undefined;await new Promise(resolve=>{const timer=setTimeout(()=>{current.kill();},5000);current.once('exit',()=>{clearTimeout(timer);resolve();});current.send('stop');});}
 (async()=>{
  fs.mkdirSync(out,{recursive:true});temp=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-subagents-http-'));fs.writeFileSync(path.join(temp,'fixture.txt'),'HTTP child file evidence');
  let requests=0;
  fixture=http.createServer(async(req,res)=>{
   try{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests++;
    if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"title":"多代理测试","category":"code"}'}}]}));return;}
    const system=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');const child=system.includes('You are sub-agent');const tools=body.messages.filter(m=>m.role==='tool');
    res.setHeader('Content-Type','text/event-stream');
    const delta=d=>res.write('data: '+JSON.stringify({choices:[{index:0,delta:d,finish_reason:null}]})+'\n\n');
    const done=reason=>{res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:reason}]})+'\n\n');res.end('data: [DONE]\n\n');};
    const call=(index,id,name,args)=>delta({tool_calls:[{index,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
    if(child){
     if(!tools.length){delta({content:'先检查文件。'});delta({reasoning_content:'确认本地文件内容。'});call(0,'read','file_read',{path:'fixture.txt',tool_title:'读取测试文件'});done('tool_calls');}
     else {assert.match(tools[0].content,/HTTP child file evidence/);delta({content:'子代理验证完成。'});done('stop');}
    }else if(!tools.length){call(0,'spawn-A','spawn_agent',{message:'读取测试文件 A',nickname:'Reader A'});call(1,'spawn-B','spawn_agent',{message:'读取测试文件 B',nickname:'Reader B'});done('tool_calls');}
    else if(!tools.some(t=>t.tool_call_id.startsWith('wait-'))){let index=0;for(const tool of tools.filter(t=>t.tool_call_id.startsWith('spawn-'))){const id=JSON.parse(tool.content).id;call(index,'wait-'+index,'wait_agent',{ids:[id],timeout_ms:3000});index++;}done('tool_calls');}
    else{delta({content:'两个子代理均已完成。'});done('stop');}
   }catch(error){res.statusCode=500;res.end(String(error.stack));}
  });await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(temp,'.iexa-settings.json'),JSON.stringify({profiles:[{id:'fixture',name:'Local fixture',provider:'openai',model:'gpt-5',apiKey:'LOCAL_FIXTURE_ONLY',baseURL:`http://127.0.0.1:${fixture.address().port}/v1`,maxOutputTokens:2000}],activeProfileId:'fixture',thinkingLevel:'medium',permissionMode:'risk'}));
  let api=await boot();const json=async(route,method='GET',body)=>{const response=await fetch(api.base+route,{method,headers:api.headers,body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
  const session=(await json('/api/sessions','POST',{})).session;const sid=session.id;
  controller=new AbortController();const sse=await fetch(api.base+'/api/session-events?clientId=fixture',{headers:api.headers,signal:controller.signal});let stream='';streamWork=(async()=>{try{for await(const chunk of sse.body)stream+=Buffer.from(chunk).toString('utf8');}catch(error){if(!controller.signal.aborted)result.streamError=String(error);}})();
  const chat=await fetch(api.base+'/api/chat',{method:'POST',headers:api.headers,body:JSON.stringify({sessionId:sid,message:'请并行委派两个子代理读取本地测试文件。'})});assert.equal(chat.status,200);const chatEvents=await chat.text();assert.match(chatEvents,/两个子代理均已完成/);assert.doesNotMatch(chatEvents,/event: error/);
  const agents=(await json('/api/subagents?sessionId='+sid)).agents;assert.equal(agents.length,2);assert.ok(agents.every(a=>a.status==='completed'));assert.match(stream,/event: subagent_changed/);result.cases.push('actual chat route advertises and executes spawn/wait with two local provider children and SSE statuses');
  const id=agents[0].id;let detail=(await json(`/api/subagents/${id}?sessionId=${sid}`)).agent;assert.deepEqual(detail.messages[1].transcript.items.map(i=>i.type),['text','thinking','tool','text']);assert.match(detail.messages[1].toolCalls[0].result.output,/HTTP child file evidence/);result.cases.push('child body-thinking-tool-body order and executed file evidence are persisted');
  const route=`/api/subagents/${id}`;
  await json(`${route}/close?sessionId=${sid}`,'POST',{});assert.equal((await json(route+'?sessionId='+sid)).agent.status,'closed');
  await json(`${route}/resume?sessionId=${sid}`,'POST',{});await json(`${route}/send?sessionId=${sid}`,'POST',{message:'继续总结之前读到的文件。'});
  for(let i=0;i<200;i++){detail=(await json(route+'?sessionId='+sid)).agent;if(detail.status==='completed'&&detail.messages.length===4)break;await pause(20);}
  assert.equal(detail.status,'completed');assert.equal(detail.messages.length,4);result.cases.push('actual close/resume/send endpoints reuse child history');
  const unauthorized=await fetch(api.base+'/api/subagents?sessionId='+sid);assert.equal(unauthorized.status,401);
  const other=(await json('/api/sessions','POST',{})).session;
  const cross=await fetch(api.base+`${route}/send?sessionId=${other.id}`,{method:'POST',headers:api.headers,body:JSON.stringify({message:'wrong owner'})});assert.equal(cross.status,404);result.cases.push('authentication and cross-session control rejection');
  controller.abort();await streamWork;
  const before=JSON.parse(JSON.stringify(detail));await stop();const beforeRequests=requests;api=await boot();
  const restored=(await json(route+'?sessionId='+sid)).agent;assert.deepEqual(restored.messages,before.messages);assert.equal(restored.status,'completed');assert.equal(requests,beforeRequests);result.cases.push('fresh server process reloads exact child histories without provider replay');
  result.providerRequests=requests;result.passed=true;console.log('PASS: '+result.cases.length+' actual HTTP/restart cases.');
 })().catch(error=>{result.error=error.stack;result.passed=false;console.error(error);process.exitCode=1;}).finally(async()=>{
  controller?.abort();await streamWork;await stop();if(fixture){fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));}
  fs.writeFileSync(path.join(out,'http-checks.json'),JSON.stringify(result,null,2));
  if(temp){assert.ok(temp.startsWith(path.join(os.tmpdir(),'iexa-subagents-http-')));fs.rmSync(temp,{recursive:true,force:true});}
 });
}
