const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const {functions}=require('./helpers/transcript-harness.cjs');
const root=path.resolve(__dirname,'../src/renderer');
function setup(t){const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{runScripts:'outside-only',url:'http://localhost/'});t.after(()=>dom.window.close());return dom.window;}

test('both project open controls are independent labelled SVG buttons, not text glyphs or nested buttons',t=>{
 const w=setup(t),d=w.document;
 for(const id of ['shellAddProject','filesOpenBtn']){const b=d.getElementById(id);assert.equal(b.tagName,'BUTTON');assert.ok(b.classList.contains('ui-icon-button'));assert.equal(b.type,'button');assert.equal(b.getAttribute('aria-label'),'打开项目文件夹');assert.equal(b.textContent.trim(),'');assert.equal(b.querySelector('use').getAttribute('href'),'#ui-plus');assert.equal(b.parentElement.closest('button'),null);}
 assert.equal(d.querySelector('#shellProjectBtn use[href="#ui-plus"]'),null);assert.ok(d.querySelector('#shellProjectBtn use[href="#ui-chevron-right"]'));
});

test('shared toolbar icon buttons have accessible names and all symbols resolve',t=>{
 const w=setup(t),d=w.document;const buttons=d.querySelectorAll('.ui-icon-button');assert.ok(buttons.length>=12);
 for(const b of buttons){assert.ok(b.getAttribute('aria-label')||b.textContent.trim(),b.id);assert.ok(b.querySelector('svg'),b.id);assert.doesNotMatch(b.textContent.trim(),/^[+×↻✕]$/,b.id);}
 for(const use of d.querySelectorAll('use'))assert.ok(d.querySelector(use.getAttribute('href')),use.getAttribute('href'));
});

test('project plus and row keep the original picker action exactly once with disabled behavior',t=>{
 const w=setup(t),d=w.document;w.eval(fs.readFileSync(path.join(root,'services/WorkbenchShell.js'),'utf8'));
 let calls=0;d.getElementById('filesOpenBtn').onclick=()=>calls++;
 for(const id of ['shellAddProject','shellProjectBtn','shellOpenProject','filesOpenBtn']){const before=calls;d.getElementById(id).click();assert.equal(calls,before+1);}
 d.getElementById('shellAddProject').disabled=true;d.getElementById('shellAddProject').click();assert.equal(calls,4);
});

test('special folder categories retain semantic labels without overlapping black-fill fallback paths',t=>{
 const w=setup(t);w.eval(functions(['fileIcon']));
 for(const name of ['src','scripts','tests','node_modules','docs','.git','workspace']){const host=w.document.createElement('div');host.innerHTML=w.fileIcon({name,type:'dir'});assert.equal(host.querySelectorAll('svg use').length,1);assert.equal(host.querySelector('use').getAttribute('href'),'#ui-folder');assert.equal(host.querySelector('path'),null);assert.ok(host.querySelector('[role="img"]').getAttribute('aria-label'));assert.equal(host.querySelector('.file-type-icon-badge'),null);}
 for(const [name,icon] of [['example.ts','code'],['hello.py','code'],['run.ps1','terminal'],['README.md','file'],['backup.zip','box']]){const host=w.document.createElement('div');host.innerHTML=w.fileIcon({name,type:'file'});assert.equal(host.querySelector('use').getAttribute('href'),'#ui-'+icon);}
});

test('dynamic action templates use vector icons, while diff +/- remains literal code content',()=>{
 const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
 assert.doesNotMatch(app,/<button[^>]*>\s*[×↻]\s*<\/button>/);
 assert.match(app,/<span>\+<\/span>\$\{escapeHtml\(line\)\}/);
 // "重置到此处" branches the conversation, so it uses the branch glyph. The
 // circular retry arrow means "regenerate the answer" and belongs to the
 // assistant-side action, not to a branch point.
 assert.match(app,/data-action="reset"[^>]*>\$\{uiIcon\('branch'\)\}/);
 assert.doesNotMatch(app,/data-action="reset"[^>]*>\$\{uiIcon\('retry'\)\}/);
 // "重新发送" replays an earlier prompt as a fresh turn.
 assert.match(app,/data-action="resend"[^>]*>\$\{uiIcon\('send'\)\}/);
});
