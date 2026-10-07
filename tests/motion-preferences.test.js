const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const ts=require('typescript');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
const initial=fs.readFileSync(path.join(root,'src/renderer/services/InitialAppearance.js'),'utf8');
const app=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8').replace(/\r\n/g,'\n');
const appearance=app.slice(app.indexOf('function formatTaskElapsed('),app.indexOf('function taskSummaryForCurrentMessage()'))+'\n'+app.slice(app.indexOf('const ACCENT_PRESETS = ['),app.indexOf('// Project files panel (OpenCode-style:'));
function fixture(t){const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});t.after(()=>dom.window.close());const w=dom.window;w.API_BASE='';return w;}

test('initial paint honors saved full motion even when host preferences would reduce it',t=>{
 const w=fixture(t);w.iexaDesktop={initialAppearance:{theme:'dark',accent:'blue',motion:'full'}};
 w.localStorage.setItem('iexa-motion','reduced');w.eval(initial);
 assert.equal(w.document.documentElement.dataset.motion,'full');assert.equal(w.document.documentElement.dataset.theme,'dark');
});
test('initial paint uses browser motion fallback and validates unknown modes',t=>{
 const w=fixture(t);w.localStorage.setItem('iexa-motion','reduced');w.eval(initial);assert.equal(w.document.documentElement.dataset.motion,'reduced');
 w.localStorage.setItem('iexa-motion','unexpected');w.eval(initial);assert.equal(w.document.documentElement.dataset.motion,'system');
});
test('actual appearance controls update motion, accessibility state and saved API payload',async t=>{
 const w=fixture(t),requests=[];w.fetch=async(url,options)=>{requests.push({url,options});return {ok:true};};
 w.eval(appearance);w.initTheme();const button=w.document.querySelector('[data-motion-set="full"]');button.click();
 assert.equal(w.document.documentElement.dataset.motion,'full');assert.equal(w.localStorage.getItem('iexa-motion'),'full');assert.equal(button.getAttribute('aria-pressed'),'true');
 assert.equal(w.document.querySelector('[data-motion-set="system"]').getAttribute('aria-pressed'),'false');
 await new Promise(r=>setTimeout(r,240));assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/appearance');assert.equal(requests[0].options.method,'PUT');assert.equal(JSON.parse(requests[0].options.body).motion,'full');
});
test('actual API appearance hydration restores selected motion without resaving',async t=>{
 const w=fixture(t);let requests=0;w.fetch=async()=>{requests++;return {ok:true,json:async()=>({theme:'dark',accent:'blue',motion:'full',sidebarWidth:260,filesPanelWidth:320})};};
 w.eval(appearance);await w.loadAppearanceSettings();assert.equal(w.getMotionMode(),'full');assert.equal(w.localStorage.getItem('iexa-motion'),'full');assert.equal(requests,1);
 assert.equal(w.document.querySelector('[data-motion-set="full"]').getAttribute('aria-pressed'),'true');
});
test('motion can still change when browser storage is unavailable',t=>{
 const w=fixture(t);w.eval(appearance);Object.defineProperty(w,'localStorage',{get(){throw new Error('storage unavailable');}});
 assert.doesNotThrow(()=>w.applyMotionMode('reduced'));assert.equal(w.getMotionMode(),'reduced');
});
test('actual server normalizer preserves known modes and migrates old preferences to system',()=>{
 const server=fs.readFileSync(path.join(root,'src/main/server.ts'),'utf8').replace(/\r\n/g,'\n');
 const source=server.slice(server.indexOf('interface AppearanceSettings {'),server.indexOf('function loadAppearance()'));
 const code=ts.transpile(source+'\n globalThis.normalize = normalizeAppearance;', {target:ts.ScriptTarget.ES2022});const c={};vm.runInNewContext(code,c);
 for(const motion of ['system','full','reduced'])assert.equal(c.normalize({motion}).motion,motion);
 assert.equal(c.normalize({}).collapseConsecutiveTools,false);
 assert.equal(c.normalize({collapseConsecutiveTools:true}).collapseConsecutiveTools,true);
 assert.equal(c.normalize({collapseConsecutiveTools:'yes'}).collapseConsecutiveTools,false);
});
test('consecutive tool groups collapse only when enabled and report calls, errors, and elapsed seconds',t=>{
 const w=fixture(t);w.eval(appearance);w.document.documentElement.setAttribute('data-collapse-tools','on');
 const host=w.document.createElement('div');host.className='tool-steps';host.dataset.startedAt=String(Date.now()-2500);
 const summary=w.createTaskSummary(0);host.append(summary);w.document.body.append(host);
 for(const status of ['done','error']){const block=w.document.createElement('div');block.className='tool-block'+(status==='error'?' is-error':'');block.dataset.status=status;block.dataset.startedAt=host.dataset.startedAt;block.dataset.finishedAt=String(Number(host.dataset.startedAt)+2000);host.append(block);}
 w.refreshToolGroupSummary(host);
 assert.equal(host.classList.contains('is-collapsed'),true);
 assert.equal(summary.querySelector('.task-summary-label').textContent,'已执行工具');
 assert.equal(summary.classList.contains('is-running'),false);
 assert.equal(summary.querySelector('.task-summary-spinner').hidden,true);
 assert.equal(summary.querySelector('.task-summary-count').textContent,'2 次调用');
 assert.equal(summary.querySelector('.task-summary-errors').textContent,'1 个报错');
 assert.equal(summary.querySelector('.task-summary-time').textContent,'2 秒');
 summary.click();assert.equal(host.classList.contains('is-collapsed'),false);
 w.setConsecutiveToolFold(false);assert.equal(host.classList.contains('is-collapsed'),false);assert.equal(summary.hidden,true);
});
test('actual server normalizer rejects invalid values',()=>{
 const server=fs.readFileSync(path.join(root,'src/main/server.ts'),'utf8').replace(/\r\n/g,'\n');
 const source=server.slice(server.indexOf('interface AppearanceSettings {'),server.indexOf('function loadAppearance()'));
 const code=ts.transpile(source+'\n globalThis.normalize = normalizeAppearance;', {target:ts.ScriptTarget.ES2022});const c={};vm.runInNewContext(code,c);
 for(const value of [{},null,{motion:'unrecognized'},{motion:{}}])assert.equal(c.normalize(value).motion,'system');
 assert.equal(c.normalize({motion:'full',theme:'dark',accent:'blue',sidebarWidth:280}).sidebarWidth,280);
});
