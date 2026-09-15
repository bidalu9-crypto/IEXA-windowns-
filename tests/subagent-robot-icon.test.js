const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../src/renderer'),names=['spawn_agent','send_input','wait_agent','close_agent','resume_agent'];
test('all five sub-agent operations map to the robot; ordinary tool icons keep their identity',()=>{
 const source=ts.createSourceFile('app.js',fs.readFileSync(path.join(root,'app.js'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const mapping=source.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(source)==='TOOL_ICONS'));
 const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='toolIcon');const context={uiIcon:name=>name};vm.createContext(context);vm.runInContext(mapping.getText(source)+'\n'+fn.getText(source),context);
 for(const name of names)assert.equal(context.toolIcon(name),'robot');assert.equal(context.toolIcon('shell_execute'),'terminal');assert.equal(context.toolIcon('file_read'),'file');assert.equal(context.toolIcon('unrecognized'),'settings');
});
test('robot is a single valid vector symbol, shared updates handle history and missing icons without duplicates',t=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;w.eval(fs.readFileSync(path.join(root,'services/ChatActivityView.js'),'utf8'));
 const symbol=d.querySelector('#ui-robot');assert.equal(d.querySelectorAll('#ui-robot').length,1);assert.equal(symbol.getAttribute('viewBox'),'0 0 24 24');assert.ok(symbol.querySelector('rect'));assert.ok(symbol.querySelector('circle'));assert.equal(symbol.querySelector('image,foreignObject,script'),null);
 for(const name of names)for(const existing of [false,true]){
  const block=d.createElement('div');block.className='tool-block';block.dataset.executionStatus='completed';block.innerHTML='<div class="tool-header">'+(existing?'<span class="tool-icon"><svg class="ui-icon"><use href="#ui-settings"/></svg></span>':'')+'<span class="tool-heading"><span class="tool-name"></span><span class="tool-meta"></span></span><span class="tool-status">完成</span><span class="tool-chevron"></span></div><div class="tool-body"><pre class="tool-args"></pre><pre class="tool-result">保留工具结果</pre></div>';d.body.append(block);
  w.IexaChatActivity.updateTool(block,name,{message:'测试子代理'},{success:true});const icon=block.querySelector('.tool-icon svg');w.IexaChatActivity.updateTool(block,name,undefined,{success:true});
  assert.equal(block.querySelectorAll('.tool-icon').length,1);assert.equal(block.querySelector('.tool-icon svg'),icon);assert.equal(icon.querySelector('use').getAttribute('href'),'#ui-robot');assert.equal(icon.getAttribute('aria-hidden'),'true');assert.equal(block.dataset.executionStatus,'completed');assert.equal(block.querySelector('.tool-result').textContent,'保留工具结果');
 }
});
