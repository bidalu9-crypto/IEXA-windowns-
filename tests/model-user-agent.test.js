const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');const fs=require('node:fs');
const {CODEX_COMPAT_USER_AGENT,modelRequestHeaders,normalizeCustomUserAgent}=require('../dist/main/providers/RequestHeaders');
const utils=require('../dist/main/providers/stream-utils');
const {OpenAIProvider}=require('../dist/main/providers/OpenAIProvider');
const {isGptReasoningModel,maxThinkingLevel,shouldUseVisionProxy,modelSupportsVision}=require('../dist/main/providers/ModelCapabilities');
const {AnthropicProvider}=require('../dist/main/providers/AnthropicProvider');
const {GeminiProvider}=require('../dist/main/providers/GeminiProvider');
async function serverFixture(t){const calls=[];const server=http.createServer((req,res)=>{calls.push({url:req.url,headers:req.headers});req.resume();res.writeHead(req.url==='/retry'&&calls.filter(c=>c.url==='/retry').length===1?503:200,{'content-type':'text/event-stream'});res.end('data: ' + JSON.stringify({type:'response.completed',response:{status:'completed'},choices:[{delta:{content:'fixture'},finish_reason:'stop'}],candidates:[{content:{parts:[{text:'fixture'}]},finishReason:'STOP'}]}) + '\n\ndata: {"type":"message_stop"}\n\ndata: [DONE]\n\n');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return {url:'http://127.0.0.1:'+server.address().port,calls};}
test('model UA matches local Codex wire capture and preserves caller-owned headers',()=>{
 const source=new Headers({'Authorization':'Bearer FIXTURE','Content-Type':'application/json','User-Agent':'old'});const result=modelRequestHeaders(source);
 assert.equal(result.get('user-agent'),'codex_vscode/0.153.0 (Windows 10.0.19045; x86_64) dumb (codex_exec; 0.153.0)');assert.equal(result.get('authorization'),'Bearer FIXTURE');assert.equal(result.get('content-type'),'application/json');assert.equal(source.get('user-agent'),'old');assert.equal(result.has('originator'),false);
});
test('actual HTTP transport includes the same UA on initial request, retries and Request input',async t=>{
 const f=await serverFixture(t);const delays=[...utils.STREAM_RETRY_DELAYS_MS];utils.STREAM_RETRY_DELAYS_MS.fill(1);t.after(()=>{utils.STREAM_RETRY_DELAYS_MS.splice(0,delays.length,...delays);});
 await (await utils.fetchWithRetry(f.url+'/retry',{headers:{Authorization:'Bearer FIXTURE'}})).text();
 await (await utils.fetchWithRetry(new Request(f.url+'/request',{headers:{'X-Test':'request-header',Authorization:'Bearer INHERITED'}}),{})).text();
 assert.equal(f.calls.length,3);for(const call of f.calls)assert.equal(call.headers['user-agent'],CODEX_COMPAT_USER_AGENT);assert.equal(f.calls[2].headers.authorization,'Bearer INHERITED');assert.equal(f.calls[2].headers['x-test'],'request-header');
});
test('all four provider envelopes carry UA without changing authentication or model settings',async t=>{
 const f=await serverFixture(t),original=global.fetch;t.after(()=>{global.fetch=original;});
 // Redirect only the test transport to loopback, including Gemini's fixed URL.
 global.fetch=(_url,init)=>original(f.url+'/provider',init);
 const config={model:'fixture-model',apiKey:'FIXTURE',name:'fixture',thinkingLevel:'off'};
 for(const provider of [new OpenAIProvider({...config,apiMode:'chat_completions'}),new OpenAIProvider({...config,apiMode:'responses'}),new AnthropicProvider(config),new GeminiProvider(config)]){
  const stream=provider.streamMessage([{role:'user',parts:[{type:'text',text:'fixture'}]}],'fixture-system',[],1024);try{await stream.next();}finally{await stream.return();}
 }
 assert.equal(f.calls.length,4);for(const call of f.calls)assert.equal(call.headers['user-agent'],CODEX_COMPAT_USER_AGENT);assert.equal(f.calls[0].headers.authorization,'Bearer FIXTURE');assert.equal(f.calls[2].headers['x-api-key'],'FIXTURE');assert.equal(f.calls[2].headers['anthropic-version'],'2023-06-01');
});
test('model list uses the shared UA policy; browser traffic is not globally rewritten',()=>{
 const server=fs.readFileSync('src/main/server.ts','utf8');assert.ok(server.includes('headers: Object.fromEntries(modelRequestHeaders(isAnthropic'));assert.ok(server.includes("{ 'Authorization': `Bearer ${effectiveApiKey}`, 'Accept': 'application/json' }"));assert.ok(server.includes("{ 'x-api-key': effectiveApiKey, 'anthropic-version': '2023-06-01'"));
 const browser=fs.readFileSync('src/main/tools/ToolExecutors.ts','utf8');assert.match(browser,/Mozilla\/5\.0/);assert.doesNotMatch(browser,/modelRequestHeaders/);
 const titleCall=server.slice(server.indexOf('const result = await callModelForTitle('));assert.ok(titleCall.slice(0,titleCall.indexOf('    summary,')).includes('userAgent: profile.userAgent'));
 assert.ok(fs.readFileSync('src/main/session-title.ts','utf8').includes('userAgent: profile.userAgent'));
});

test('custom UA is trimmed, blank resets default, and control/non-ASCII/oversized inputs fail early',()=>{
 assert.equal(modelRequestHeaders(undefined,'  MyClient/2.0  ').get('user-agent'),'MyClient/2.0');assert.equal(modelRequestHeaders(undefined,' ').get('user-agent'),CODEX_COMPAT_USER_AGENT);
 for(const input of ['bad\r\nAuthorization: fake','bad\tvalue','中文UA','a'.repeat(513),12])assert.throws(()=>normalizeCustomUserAgent(input),/User-Agent/);
});
test('GPT reasoning capability covers GPT-6+ aliases and preserves GPT-5 chat exclusions',()=>{
 for(const model of ['gpt-6-astra','gpt-6-sol','gpt-6-luna','provider/gpt-6-astra-2026-09-23','provider/gpt-6-sol-2026-09-23','provider/gpt-6-luna-2026-09-23','gpt-5.4','provider/gpt-5.3-2027-01-01']) assert.equal(isGptReasoningModel(model),true,model);
 for(const model of ['gpt-4.1','gpt-5-chat-latest','gpt-5-mini','gpt-5-nano','o3']) assert.equal(isGptReasoningModel(model),false,model);
 assert.equal(maxThinkingLevel('openai','gpt-6-astra'),'xhigh');
 assert.equal(maxThinkingLevel('openai','gpt-6-sol'),'max');
 assert.equal(maxThinkingLevel('openai','gpt-6-luna'),'max');
 assert.equal(maxThinkingLevel('openai','provider/gpt-6-sol-2026-09-23'),'max');
 assert.equal(maxThinkingLevel('openai','gpt6-astra'),'xhigh');
 assert.equal(maxThinkingLevel('openai','gpt-5.4'),'xhigh');
 assert.equal(maxThinkingLevel('openai','gpt-4.1'),'off');
});
test('GPT-6 Astra, Sol and Luna send shared reasoning_effort on Chat Completions',async t=>{
 const f=await serverFixture(t),original=global.fetch;t.after(()=>{global.fetch=original;});
 const requestBodies=[];
 global.fetch=async (_url,init)=>{requestBodies.push(JSON.parse(init.body));return original(f.url+'/gpt6',init);};
 for(const model of ['gpt-6-astra','gpt-6-sol','gpt-6-luna']) {
  const provider=new OpenAIProvider({model,apiKey:'FIXTURE',name:'openai',thinkingLevel:'high',baseURL:f.url});
  const stream=provider.streamMessage([{role:'user',parts:[{type:'text',text:'fixture'}]}],'fixture-system',[],1024);try{await stream.next();}finally{await stream.return();}
 }
 assert.deepEqual(requestBodies.map(body=>[body.model,body.reasoning_effort]),[
  ['gpt-6-astra','high'],['gpt-6-sol','high'],['gpt-6-luna','high'],
 ]);
 assert.ok(requestBodies.every(body=>!('enable_thinking' in body)));
});
test('Responses reasoning fields fall back when a gateway rejects them',async t=>{
 const f=await serverFixture(t),original=global.fetch;t.after(()=>{global.fetch=original;});
 const bodies=[];
 global.fetch=async (_url,init)=>{const body=JSON.parse(init.body);bodies.push(body);if(bodies.length===1)return new Response(JSON.stringify({error:{message:'unknown field reasoning'}}),{status:400,headers:{'content-type':'application/json'}});return original(f.url+'/responses-fallback',init);};
 const provider=new OpenAIProvider({model:'gpt-6-pro',apiKey:'FIXTURE',name:'openai',thinkingLevel:'high',baseURL:f.url,apiMode:'responses'});
 const stream=provider.streamMessage([{role:'user',parts:[{type:'text',text:'fixture'}]}],'fixture-system',[],1024);try{await stream.next();}finally{await stream.return();}
 assert.equal(bodies.length,2);
 assert.deepEqual(bodies[0].reasoning,{effort:'high',summary:'auto'});
 assert.equal('reasoning' in bodies[1],false);
});
test('per-profile custom UA reaches all provider transports independently',async t=>{
 const f=await serverFixture(t),original=global.fetch;t.after(()=>{global.fetch=original;});global.fetch=(_url,init)=>{assert.equal('userAgent' in init,false);return original(f.url+'/custom',init);};
 const config={model:'fixture-model',apiKey:'FIXTURE',name:'fixture',thinkingLevel:'off',userAgent:'PersonalClient/9.1'};
 for(const provider of [new OpenAIProvider({...config,apiMode:'chat_completions'}),new OpenAIProvider({...config,apiMode:'responses'}),new AnthropicProvider(config),new GeminiProvider(config)]){
  const stream=provider.streamMessage([{role:'user',parts:[{type:'text',text:'fixture'}]}],'fixture-system',[],1024);try{await stream.next();}finally{await stream.return();}
 }
 assert.equal(f.calls.length,4);for(const call of f.calls)assert.equal(call.headers['user-agent'],'PersonalClient/9.1');
});

test('native vision takes precedence over a separately configured vision fallback',()=>{
 assert.equal(shouldUseVisionProxy('openai','gpt-4o',true,false),false);
 assert.equal(shouldUseVisionProxy('anthropic','claude-3-7-sonnet',true,false),false);
 assert.equal(shouldUseVisionProxy('openai','text-only-model',true,false),true);
 assert.equal(shouldUseVisionProxy('openai','text-only-model',false,false),false);
 assert.equal(shouldUseVisionProxy('openai','text-only-model',true,true),false);
 assert.equal(shouldUseVisionProxy('custom','private-alias',true,false,'native'),false);
 assert.equal(shouldUseVisionProxy('openai','gpt-4o',true,false,'text'),true);
 assert.equal(modelSupportsVision('custom','private-alias','native'),true);
 assert.equal(modelSupportsVision('openai','gpt-4o','text'),false);
 assert.equal(modelSupportsVision('custom','private-alias','auto'),false);
});
