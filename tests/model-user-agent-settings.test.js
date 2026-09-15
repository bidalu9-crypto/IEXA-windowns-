const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {JSDOM}=require('jsdom');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-ua-settings-'));
process.env.IEXA_WORKSPACE=path.join(directory,'workspace');
const backend=require('../dist/main/server');
const {CODEX_COMPAT_USER_AGENT}=require('../dist/main/providers/RequestHeaders');
let server,endpoint,token,upstream,baseURL;const calls=[];
test.before(async()=>{server=await backend.startServer(0,false);endpoint='http://127.0.0.1:'+server.address().port;token=backend.getServerCredentials(server).token;upstream=http.createServer((req,res)=>{calls.push(req.headers);req.resume();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));baseURL='http://127.0.0.1:'+upstream.address().port;});
test.after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise(r=>s.close(r));}assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});});
async function api(route,body){const response=await fetch(endpoint+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};}
const profile=()=>({id:'ua-fixture',name:'UA fixture',provider:'custom',model:'fixture-model',apiKey:'FIXTURE-NOT-A-REAL-KEY',baseURL});
test('profile CRUD persists custom UA, model discovery uses it, blank resets to Codex',async()=>{
 let result=await api('/api/profiles',{...profile(),userAgent:'  TeamClient/1.2  '});assert.equal(result.status,200);assert.equal(result.body.profile.userAgent,'TeamClient/1.2');
 result=await api('/api/profiles');assert.equal(result.body.defaultUserAgent,CODEX_COMPAT_USER_AGENT);assert.equal(result.body.profiles.find(p=>p.id==='ua-fixture').userAgent,'TeamClient/1.2');
 result=await api('/api/profiles/fetch-models',{baseURL,profileId:'ua-fixture'});assert.equal(result.status,200);assert.equal(calls.at(-1)['user-agent'],'TeamClient/1.2');assert.equal(calls.at(-1).authorization,'Bearer FIXTURE-NOT-A-REAL-KEY');
 await api('/api/profiles',{...profile(),apiKey:'',name:'Updated name'});result=await api('/api/profiles');assert.equal(result.body.profiles.find(p=>p.id==='ua-fixture').userAgent,'TeamClient/1.2');
 await api('/api/profiles',{...profile(),apiKey:'',userAgent:''});result=await api('/api/profiles');assert.equal(result.body.profiles.find(p=>p.id==='ua-fixture').userAgent,'');
 await api('/api/profiles/fetch-models',{baseURL,profileId:'ua-fixture'});assert.equal(calls.at(-1)['user-agent'],CODEX_COMPAT_USER_AGENT);
 await api('/api/profiles/fetch-models',{baseURL,profileId:'ua-fixture',userAgent:'UnsavedPreview/3'});assert.equal(calls.at(-1)['user-agent'],'UnsavedPreview/3');
});
test('invalid custom UA is rejected without overwriting saved settings or reaching upstream',async()=>{
 const count=calls.length;const result=await api('/api/profiles',{...profile(),userAgent:'injected\r\nX-Other: value'});assert.equal(result.status,400);assert.match(result.body.error,/User-Agent/);assert.equal((await api('/api/profiles')).body.profiles.find(p=>p.id==='ua-fixture').userAgent,'');
 const discovery=await api('/api/profiles/fetch-models',{baseURL,profileId:'ua-fixture',userAgent:'injected\n'});assert.equal(discovery.status,400);assert.equal(calls.length,count);
});
test('actual editor restores custom UA, new profiles are blank, and rejected saves remain open',async t=>{
 const dom=new JSDOM(fs.readFileSync('src/renderer/index.html','utf8'),{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,source=fs.readFileSync('src/renderer/app.js','utf8');const fn=name=>{const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}',start)+2;return source.slice(source.slice(start-6,start)==='async '?start-6:start,end);};
 w.eval(`const API_BASE='';function updateEditorPlaceholders(){}function hideProfileEditor(){window.hiddenEditor=true;}function renderProfileList(){}function loadVisionProfileSetting(){}function refreshModelSelector(){};${fn('showProfileEditor')};${fn('saveProfile')};window.fixture={showProfileEditor,saveProfile};`);
 w.fixture.showProfileEditor({...profile(),userAgent:'EditorClient/2'});assert.equal(w.document.getElementById('profileEditorUserAgent').value,'EditorClient/2');
 let body;w.fetch=async(_url,options)=>{body=JSON.parse(options.body);return {ok:false,json:async()=>({error:'UA error'})};};w.IexaDialogs={alert:async text=>{w.errorText=text;}};await w.fixture.saveProfile();assert.equal(body.userAgent,'EditorClient/2');assert.equal(w.errorText,'UA error');assert.equal(w.hiddenEditor,undefined);
 w.fixture.showProfileEditor();assert.equal(w.document.getElementById('profileEditorUserAgent').value,'');
});
