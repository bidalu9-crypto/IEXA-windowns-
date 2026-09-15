const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {assessModelEvidence}=require('../scripts/helpers/autonomous-evidence.cjs');
const {compactToolResultForContext}=require('../dist/main/agent/AgentLoop');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
test('autonomous evaluator accepts an exact post-action observed status without inventing verifyText',()=>{
 const report={actions:[{id:'observed',args:{action:'observe'}}],results:[{id:'observed',success:true,output:'token | status | Registered ORDER-1 | bounds'}]};
 assert.deepEqual(assessModelEvidence(report,'Registered ORDER-1'),[{id:'observed',method:'observed_status'}]);
 assert.deepEqual(assessModelEvidence(report,'Registered ORDER-2'),[]);
});
test('autonomous evaluator rejects final prose, wrong order, failed tools and mere action dispatch',()=>{
 for(const result of [
  {id:'observed',success:false,output:'x | status | Registered ORDER-1 | x'},
  {id:'clicked',success:true,output:'x | status | Registered ORDER-1 | x'},
  {id:'observed',success:true,output:'Model claims Registered ORDER-1'},
 ])assert.deepEqual(assessModelEvidence({answer:'Registered ORDER-1',actions:[{id:'observed',args:{action:'observe'}},{id:'clicked',args:{action:'click'}}],results:[result]},'Registered ORDER-1'),[]);
});
test('autonomous evaluator also accepts structured observations and exact verifyText',()=>{
 const report={actions:[{id:'a',args:{action:'observe'}},{id:'b',args:{action:'type',verifyText:'Registered ORDER-1'}}],results:[{id:'a',success:true,output:JSON.stringify({data:{elements:[{role:'status',text:'Registered ORDER-1'}]}})},{id:'b',success:true,desktop:{verified:true},output:''}]};
 assert.equal(assessModelEvidence(report,'Registered ORDER-1').length,2);
});
test('desktop context preserves selectors beyond generic 2400-character log cap',()=>{
 const observation=Array.from({length:35},(_,i)=>`element-${i} | button | Action ${i} | selector={"automationId":"control-${i}"}`).join('\n');
 assert.ok(observation.length>2400);assert.equal(compactToolResultForContext(observation,'desktop_control'),observation);
 assert.ok(compactToolResultForContext(observation,'shell_execute').length<=2400);
});
test('oversized desktop observations stop at complete lines and explicitly announce omission',()=>{
 const lines=Array.from({length:500},(_,i)=>`e-${i} | button | ${'x'.repeat(90)} | selector={"automationId":"complete-${i}"}`);
 const text=compactToolResultForContext(lines.join('\n'),'desktop_control');assert.ok(text.length<=16000);assert.match(text,/controls may be omitted/);
 const kept=text.split('\n').filter(line=>line.startsWith('e-'));assert.ok(kept.length>0);assert.ok(kept.every(line=>lines.includes(line)));
 assert.match(compactToolResultForContext('x'.repeat(17000),'desktop_control'),/No partial selector/);
});
test('CDP observations respect text-only versus explicit screenshot attachment',async()=>{
 for(const [defaults,args,expectImage] of [[false,{},false],[false,{captureFrame:true},true],[true,{},true],[true,{captureFrame:false},false]]){
  const agent=new DesktopAgent(process.cwd(),defaults);const endpoint='http://127.0.0.1:9222';
  agent.cdpAdapters.set(endpoint,{execute:async()=>({success:true,output:'{}',imageData:Buffer.from('test'),imageMimeType:'image/png'}),close(){}});
  const result=await agent.executeNative({action:'observe',backend:'chromium-cdp',cdpEndpoint:endpoint,...args});
  assert.equal(!!result.imageData,expectImage);agent.close();
 }
});
test('benchmark profile reader is read-only and fails when active profile is absent',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-profile-reader-'));t.after(()=>{assert.ok(path.basename(dir).startsWith('iexa-profile-reader-'));fs.rmSync(dir,{recursive:true,force:true});});
 const file=path.join(dir,'settings.json'),content=JSON.stringify({activeProfileId:'a',profiles:[{id:'a',provider:'custom',model:'fixture',apiKey:'FAKE-TEST-KEY'}]});fs.writeFileSync(file,content);
 const {selectedProfile}=require('../scripts/helpers/selected-model-profile.cjs');assert.equal(selectedProfile(file).model,'fixture');assert.equal(fs.readFileSync(file,'utf8'),content);assert.deepEqual(fs.readdirSync(dir),['settings.json']);
 fs.writeFileSync(file,JSON.stringify({profiles:[]}));assert.throws(()=>selectedProfile(file),/active configured/);
});
