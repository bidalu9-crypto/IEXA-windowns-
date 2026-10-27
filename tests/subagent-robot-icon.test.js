const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../src/renderer');
const names=['spawn_agent','send_input','wait_agent','close_agent','resume_agent'];
// Each sub-agent operation is a different action, so each gets its own glyph.
const expected={spawn_agent:'robot',send_input:'send',wait_agent:'clock',close_agent:'close',resume_agent:'play'};

function iconContext(){
 const source=ts.createSourceFile('app.js',require('./helpers/renderer-bundle').source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const pick=(predicate)=>source.statements.find(predicate);
 const mapping=pick(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(source)==='TOOL_ICONS'));
 const aliases=pick(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(source)==='TOOL_ALIASES'));
 const canonical=pick(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='canonicalToolName');
 const fn=pick(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='toolIcon');
 const context={uiIcon:name=>name};
 vm.createContext(context);
 vm.runInContext([mapping,aliases,canonical,fn].map(n=>n.getText(source)).join('\n'),context);
 return context;
}

test('each sub-agent operation has its own icon; ordinary tools keep their identity',()=>{
 const context=iconContext();
 for(const name of names)assert.equal(context.toolIcon(name),expected[name],`${name} has a distinct icon`);
 assert.equal(new Set(names.map(n=>context.toolIcon(n))).size,names.length,'no two sub-agent operations share a glyph');
 assert.equal(context.toolIcon('shell_execute'),'terminal');
 assert.equal(context.toolIcon('file_read'),'file');
 assert.equal(context.toolIcon('file_write'),'file-plus','writing is not the same action as editing');
 assert.equal(context.toolIcon('edit'),'edit','an alias resolves to the real tool');
 assert.equal(context.toolIcon('unrecognized'),'box','unknown tools get a neutral glyph, never the settings gear');
});

test('robot is a single valid vector symbol and history rows follow the tool mapping',t=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;require('./helpers/install-i18n')(w);
 w.toolIcon=(name)=>'<svg class="ui-icon" aria-hidden="true"><use href="#ui-'+((expected[name])||'box')+'"/></svg>';
 w.eval(fs.readFileSync(path.join(root,'services/ChatActivityView.js'),'utf8'));
 const symbol=d.querySelector('#ui-robot');assert.equal(d.querySelectorAll('#ui-robot').length,1);assert.equal(symbol.getAttribute('viewBox'),'0 0 24 24');assert.ok(symbol.querySelector('rect'));assert.ok(symbol.querySelector('circle'));assert.equal(symbol.querySelector('image,foreignObject,script'),null);
 for(const name of names)for(const existing of [false,true]){
  const block=d.createElement('div');block.className='tool-block';block.dataset.executionStatus='completed';block.innerHTML='<div class="tool-header">'+(existing?'<span class="tool-icon"><svg class="ui-icon"><use href="#ui-settings"/></svg></span>':'')+'<span class="tool-heading"><span class="tool-name"></span><span class="tool-meta"></span></span><span class="tool-status">完成</span><span class="tool-chevron"></span></div><div class="tool-body"><pre class="tool-args"></pre><pre class="tool-result">保留工具结果</pre></div>';d.body.append(block);
  w.IexaChatActivity.updateTool(block,name,{message:'测试子代理'},{success:true});w.IexaChatActivity.updateTool(block,name,undefined,{success:true});
  const icon=block.querySelector('.tool-icon svg');
  w.IexaChatActivity.updateTool(block,name,undefined,{success:true});
  assert.equal(block.querySelectorAll('.tool-icon').length,1);assert.equal(block.querySelector('.tool-icon svg'),icon,'a repeat update keeps the same node');assert.equal(icon.querySelector('use').getAttribute('href'),'#ui-'+expected[name]);assert.equal(icon.getAttribute('aria-hidden'),'true');assert.equal(block.dataset.executionStatus,'completed');assert.equal(block.querySelector('.tool-result').textContent,'保留工具结果');
 }
});
