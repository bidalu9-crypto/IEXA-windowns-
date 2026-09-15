const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSystemPrompt}=require('../dist/main/agent/SystemPrompt');
const {SoulStore,buildSoulPromptSection}=require('../dist/main/agent/SoulStore');
const {OpenAIProvider}=require('../dist/main/providers/OpenAIProvider');
const {AnthropicProvider}=require('../dist/main/providers/AnthropicProvider');
const {GeminiProvider}=require('../dist/main/providers/GeminiProvider');
const soul={metadata:{name:'星岚',style:'简洁温和',lang:'日本語'},body:'保持星岚的身份；每次回答先给结论。'};
test('saved persona leads the app envelope and no embedded competing override is injected',()=>{
 const prompt=buildSystemPrompt({soul,projectInstructions:'project-reference-marker',skillFragment:'skill-reference-marker'});
 assert.ok(prompt.startsWith('# IEXA 应用层身份与人格契约'));assert.match(prompt,/你是 星岚/);assert.match(prompt,/简洁温和/);assert.match(prompt,/日本語/);assert.equal(prompt.split(soul.body).length-1,1);assert.ok(prompt.indexOf(soul.body)<prompt.indexOf('## 核心能力'));assert.doesNotMatch(prompt,/内置系统技能|用户当前请求与明确指示优先于/);assert.match(prompt,/默认沟通风格（仅在灵魂配置未指定时使用）/);
});
test('long persona survives save, reload and full system prompt construction',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-long-soul-'));
 t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 const body='正文 English 日本語 한글 🧠\n'.repeat(3000)+'END-OF-PERSONA';
 assert.ok(body.length>24000);
 const longSoul={...soul,body};new SoulStore(dir).save(longSoul);
 const loaded=new SoulStore(dir).load();assert.deepEqual(loaded,longSoul);
 assert.ok(buildSoulPromptSection(loaded).includes(body));
 assert.ok(buildSystemPrompt({soul:loaded}).includes(body));
});
test('persona survives disk reload and later saves replace the next envelope',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-soul-test-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});const store=new SoulStore(dir);store.save(soul);assert.deepEqual(new SoulStore(dir).load(),soul);store.save({...soul,metadata:{...soul.metadata,name:'晴川'}});assert.match(buildSystemPrompt({soul:store.load()}),/你是 晴川/);
});
test('every provider wire format carries the same full persona in its system channel on repeated calls',async t=>{
 const original=global.fetch;t.after(()=>{global.fetch=original;});let captured;
 global.fetch=async(_url,options)=>{captured=JSON.parse(options.body);return new Response('',{headers:{'Content-Type':'text/event-stream'}});};
 const config={name:'fixture',model:'fixture-model',apiKey:'FIXTURE-NOT-A-KEY',thinkingLevel:'off'};
 const variants=[[new OpenAIProvider({...config,apiMode:'chat_completions'}),b=>b.messages[0].role==='system'&&b.messages[0].content],[new OpenAIProvider({...config,apiMode:'responses'}),b=>b.instructions],[new AnthropicProvider(config),b=>b.system[0].text],[new GeminiProvider(config),b=>b.systemInstruction.parts[0].text]];
 const prompt=buildSystemPrompt({soul});
 for(const [provider,getSystem] of variants)for(let turn=0;turn<2;turn++){
  const generator=provider.streamMessage([{role:'user',parts:[{type:'text',text:'请给结论'}]}],prompt,[],1024);
  // Obtain and inspect the real serialized request; local fetch fixture sends no network traffic.
  try{await generator.next();}finally{await generator.return();}
  assert.equal(getSystem(captured),prompt,provider.constructor.name+' turn '+turn);
 }
});
