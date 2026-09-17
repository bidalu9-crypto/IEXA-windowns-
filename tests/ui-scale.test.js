const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'..'),service=fs.readFileSync(path.join(root,'src/renderer/services/UiScale.js'),'utf8'),initial=fs.readFileSync(path.join(root,'src/renderer/services/InitialAppearance.js'),'utf8');
function fixture(t){const dom=new JSDOM('<!doctype html><input id="uiFontScale"><output id="uiFontScaleValue"></output><input id="uiIconScale"><output id="uiIconScaleValue"></output>',{url:'http://localhost/',runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(service);return dom.window;}
test('font/icon preferences independently clamp invalid values and survive storage exceptions',t=>{
 const w=fixture(t);w.IexaUiScale.apply({fontScale:140,iconScale:160});assert.equal(w.document.documentElement.style.getPropertyValue('--ui-font-scale'),'1.4');assert.equal(w.localStorage.getItem('iexa-icon-scale'),'160');
 w.IexaUiScale.apply({fontScale:100,iconScale:140});assert.equal(w.IexaUiScale.current().fontScale,100);assert.equal(w.IexaUiScale.current().iconScale,140);
 for(const value of [{fontScale:'invalid',iconScale:{}},{fontScale:null,iconScale:null},{fontScale:-50,iconScale:0}]){w.IexaUiScale.apply(value);assert.equal(w.IexaUiScale.current().fontScale,100);assert.equal(w.IexaUiScale.current().iconScale,100);}
 Object.defineProperty(w,'localStorage',{get(){throw Error('blocked')}});assert.doesNotThrow(()=>w.IexaUiScale.apply({fontScale:180,iconScale:160}));w.IexaUiScale.sync();assert.equal(w.document.getElementById('uiFontScale').getAttribute('aria-valuetext'),'180%');
});
test('prepaint uses persisted desktop size, browser fallback and defaults without a size flash',t=>{
 const w=fixture(t);w.localStorage.setItem('iexa-font-scale','150');w.localStorage.setItem('iexa-icon-scale','130');w.eval(initial);assert.equal(w.IexaUiScale.current().fontScale,150);assert.equal(w.IexaUiScale.current().iconScale,130);
 w.iexaDesktop={initialAppearance:{fontScale:120,iconScale:160}};w.eval(initial);assert.equal(w.IexaUiScale.current().fontScale,120);assert.equal(w.IexaUiScale.current().iconScale,160);
 w.iexaDesktop.initialAppearance={fontScale:100,iconScale:100};w.eval(initial);assert.equal(w.document.documentElement.dataset.uiScaled,'false');
});
test('server migrates old preferences to 100 percent and independently bounds both settings',()=>{
 const s=fs.readFileSync(path.join(root,'src/main/server.ts'),'utf8');const part=s.slice(s.indexOf('interface AppearanceSettings {'),s.indexOf('function loadAppearance()'));const c={};vm.runInNewContext(ts.transpile(part+'\nglobalThis.normalize=normalizeAppearance;', {target:ts.ScriptTarget.ES2022}),c);
 assert.equal(c.normalize({}).fontScale,100);assert.equal(c.normalize({}).iconScale,100);
 assert.equal(c.normalize({fontScale:1000,iconScale:999}).fontScale,180);assert.equal(c.normalize({fontScale:1000,iconScale:999}).iconScale,160);
 assert.equal(c.normalize({fontScale:'bad',iconScale:'bad'}).fontScale,100);assert.equal(c.normalize({fontScale:130,iconScale:140}).iconScale,140);
});
