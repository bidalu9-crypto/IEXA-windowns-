'use strict';
// Node/JSDOM only. Run the production classic modules together; Monaco here
// supplies model plumbing and never starts a browser or an editor process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const renderer = path.resolve(__dirname, '../src/renderer');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function functions(file, names) { const source=fs.readFileSync(path.join(renderer,'services',file+'.js'),'utf8'),tree=ts.createSourceFile(file+'.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);return tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map(node=>node.getText(tree)).join('\n'); }
function fixture(t,options={}) {
  const dom=new JSDOM(fs.readFileSync(path.join(renderer,'index.html'),'utf8'),{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,context=dom.getInternalVMContext(),run=code=>vm.runInContext(code,context);
  const projects=[{id:'project-a',root:'C:/projects/a',name:'A'},{id:'project-b',root:'C:/projects/b',name:'B'}],requests=[],errors=[],models=[],writes=[],contexts=[],sessions=[{id:'session-a',projectRoot:projects[0].root,updated:1},{id:'session-b',projectRoot:projects[1].root,updated:2},{id:'unbound',projectRoot:null,updated:3}];
  let main=options.initial===null?null:projects[options.initial??0];
  const disk=new Map(projects.map((project,index)=>[project.id+':main.py',{path:'main.py',content:`print(${index})\n`,revision:'revision-'+index,encoding:'utf8'}]));
  const editor={model:null,setModel(value){this.model=value;},getModel(){return this.model;},saveViewState:()=>({}),restoreViewState(){},addCommand(){},layout(){},focus(){},dispose(){},onDidChangeCursorPosition(){},onDidChangeCursorSelection(){},getPosition:()=>({lineNumber:1,column:1}),getSelection:()=>null};
  w.ResizeObserver=class{observe(){}disconnect(){}};w.IexaI18n={t:key=>key,getLocale:()=> 'zh-CN',onLocaleChange(){}};w.IexaDialogs={confirm:async()=>true,prompt:async()=>null};w.escapeHtml=value=>String(value);w.uiIcon=()=>'';w.API_BASE='';w.sessionsCache=sessions;w.renderSessionList=()=>{};w.addError=value=>errors.push(value);w.syncHeroWorkspace=()=>{};w.loadTerminalSessions=async()=>{};w.selectTerminalSession=()=>{};
  w.console={...console,error:(...args)=>errors.push(args.join(' '))};
  w.monaco={Uri:{parse:value=>value},KeyMod:{CtrlCmd:1},KeyCode:{KeyS:2},editor:{create:()=>editor,setTheme(){},createModel(content,language,uri){let value=content;const listeners=new Set(),model={uri,language,disposed:false,getLineCount:()=>value.split(/\r\n|\r|\n/).length,getValue:()=>value,setValue(text){value=text;listeners.forEach(listener=>listener());},onDidChangeContent(listener){listeners.add(listener);return{dispose:()=>listeners.delete(listener)};},dispose(){this.disposed=true;listeners.clear();}};models.push(model);return model;}}};
  const bridge={
    async currentProject(){requests.push({route:'currentProject',main:main?.id});return options.currentProject?options.currentProject(main):main?{...main}:null;},
    async projects(){return{projects:projects.map(value=>({...value}))};},chooseFolder:async()=>projects[1],
    async list(input){requests.push({route:'ide-list',...input});if(options.list)await options.list(input);return{entries:[...disk.entries()].filter(([key])=>key.startsWith(input.workspaceId+':')).map(([,value])=>({name:value.path,path:value.path,directory:false,size:value.content.length}))};},
    async read(input){const record=disk.get(input.workspaceId+':'+input.path);if(!record)throw Error('ENOENT');return{...record};},
    async write(input){writes.push(input);const key=input.workspaceId+':'+input.path,old=disk.get(key),next={...old,content:input.content,revision:old.revision+'+'};disk.set(key,next);return{...next};},
    inspect:async()=>({type:'none',scripts:[]}),status:async()=>({status:'stopped',logs:[],url:''}),context:async input=>{contexts.push(plain(input));return{ok:true};},preview:async()=>({visible:false}),onEvent:()=>()=>{}
  };w.iexaDesktop={ide:bridge,pickFolder:async()=>projects[1].root};
  const response=data=>({ok:true,json:async()=>data});
  w.fetch=async(route,init)=>{
    requests.push({route,init});
    if(route==='/api/project'&&init?.method==='POST'){const root=JSON.parse(init.body).root;if(options.post)await options.post(root);main=projects.find(project=>project.root===root)||null;return response({root:main?.root||null,name:main?.name||null,recent:projects.map(project=>({root:project.root,name:project.name}))});}
    if(route==='/api/project/clear'){main=null;return response({ok:true});}
    if(route==='/api/project')return response({root:main?.root||null,name:main?.name||null,recent:[]});
    if(route.startsWith('/api/fs/list')){const captured=main;if(options.filesList)await options.filesList(captured);return response({root:captured?.root||null,name:captured?.name||null,path:'.',entries:[],empty:!captured});}
    const activate=route.match(/^\/api\/sessions\/([^/]+)\/activate$/);if(activate){main=projects.find(project=>project.root===sessions.find(session=>session.id===activate[1])?.projectRoot)||null;return response({project:{root:main?.root||null,name:main?.name||null,recent:[]}});}
    throw Error('Unexpected fixture request '+route);
  };
  w.currentSessionId='session-a';w.visibleSessionId='session-a';w.activatedSessionId='session-a';w.sessionViewEpoch=0;w.sessionActivationQueue=Promise.resolve();w.sessionRuntimes=new Map(sessions.map(session=>[session.id,{historyReady:true,isProcessing:false,promptQueue:[]} ]));w.pendingStreamUpdates=new Map();
  for(const name of ['snapshotActiveSessionRuntime','mountSessionRuntime','scrollHistoryToLatest','syncActiveSessionUI','syncSubAgentView','setProcessing','showWelcome'])w[name]=()=>{};
  w.refreshGoalBanner=async()=>{};w.refreshModelSelector=async()=>{};w.runtimeForSession=id=>w.sessionRuntimes.get(id);w.createSession=async()=>{};
  run(fs.readFileSync(path.join(renderer,'services/FilesPanel.js'),'utf8'));
  run(functions('SessionList',['applySessionProject','activateCachedSession','switchSession']));
  if(options.saved)w.localStorage.setItem('iexa-ide-layout',JSON.stringify(options.saved));
  run(fs.readFileSync(path.join(renderer,'services/IDEWorkspace.js'),'utf8'));
  t.after(()=>{w.dispatchEvent(new w.Event('pagehide'));w.close();});
  async function settle(){await tick();await tick();await run('sessionActivationQueue');await tick();await run('syncIDEProject()');await w.IexaIDE.ready();}
  return{w,run,api:w.IexaIDE,projects,requests,errors,models,editor,disk,writes,contexts,bridge,sessions,settle,getMain:()=>main,setMain:value=>{main=value;},mainRoot:()=>run('projectRoot')};
}

test('initial main project wins over saved IDE project; binding browses without a second folder picker or Monaco instance',async t=>{
  const f=fixture(t,{initial:1,saved:{projectId:'project-a'}});await f.run('loadProjectState()');await f.settle();assert.equal(f.mainRoot(),f.projects[1].root);assert.equal(f.api.snapshot().project.root,f.projects[1].root);assert.equal(f.api.snapshot().workspaceId,'project-b');assert.equal(f.models.length,0);assert.equal(f.requests.some(request=>request.route==='chooseFolder'),false);assert.equal(f.errors.length,0,f.errors.join('\n'));
});

test('opening the main project and switching cached conversations bind the same IDE root while preserving both dirty models and the composer draft',async t=>{
  const f=fixture(t);await f.run('loadProjectState()');await f.settle();await f.api.openFile('main.py');const a=f.editor.model;a.setValue('A_UNSAVED\n');f.w.document.getElementById('chatInput').value='KEEP_COMPOSER_DRAFT';
  await f.run('openProjectPath("C:/projects/b")');await f.settle();assert.equal(f.getMain().id,'project-b');assert.equal(f.api.snapshot().project.root,f.mainRoot());await f.api.openFile('main.py');const b=f.editor.model;b.setValue('B_UNSAVED\n');assert.notEqual(a,b);assert.equal(f.models.length,2);
  await f.run('switchSession("session-a")');await f.settle();assert.equal(f.api.snapshot().project.root,f.projects[0].root);await f.api.openFile('main.py');assert.equal(f.editor.model,a);assert.equal(a.getValue(),'A_UNSAVED\n');assert.equal(a.disposed,false);assert.equal(b.disposed,false);assert.equal(f.api.snapshot().files[0].dirty,true);
  await f.run('switchSession("session-b")');await f.settle();await f.api.openFile('main.py');assert.equal(f.editor.model,b);assert.equal(b.getValue(),'B_UNSAVED\n');assert.equal(f.w.document.getElementById('chatInput').value,'KEEP_COMPOSER_DRAFT');assert.equal(f.writes.length,0);assert.equal(f.models.length,2);assert.equal(f.errors.length,0,f.errors.join('\n'));
});

test('closing the main project detaches the IDE and keeps unsaved project models for later rebinding',async t=>{
  const f=fixture(t);await f.run('loadProjectState()');await f.settle();await f.api.openFile('main.py');const model=f.editor.model;model.setValue('PRESERVE_WHEN_CLOSED\n');await f.run('closeProject()');await f.settle();assert.equal(f.mainRoot(),null);assert.equal(f.api.snapshot().project,null);assert.equal(f.editor.model,null);assert.equal(model.disposed,false);assert.equal(f.api.hasUnsavedChanges(),true);await f.run('openProjectPath("C:/projects/a")');await f.settle();await f.api.openFile('main.py');assert.equal(f.editor.model,model);assert.equal(model.getValue(),'PRESERVE_WHEN_CLOSED\n');
});

test('an older authorization response cannot overwrite the newer main-project binding',async t=>{
  const wait=deferred();let delayed=false;const f=fixture(t,{currentProject:async main=>{if(delayed&&main?.id==='project-a'){const saved={...main};await wait.promise;return saved;}return main?{...main}:null;}});await f.run('loadProjectState()');await f.settle();delayed=true;const older=f.run('syncIDEProject()');await tick();f.setMain(f.projects[1]);f.run('projectRoot="C:/projects/b";projectName="B"');await f.run('syncIDEProject()');wait.resolve();await older;assert.equal(f.api.snapshot().workspaceId,'project-b');assert.equal(f.api.snapshot().project.root,f.mainRoot());
});

test('a late IDE directory read for project A cannot replace project B after binding changes',async t=>{
  const wait=deferred();let delayed=false;const f=fixture(t,{list:input=>delayed&&input.workspaceId==='project-a'?wait.promise:undefined});await f.run('loadProjectState()');await f.settle();delayed=true;const a=f.api.bindProject(f.projects[0]);await tick();f.setMain(f.projects[1]);f.run('projectRoot="C:/projects/b";projectName="B"');await f.run('syncIDEProject()');wait.resolve();await a;assert.equal(f.api.snapshot().workspaceId,'project-b');assert.equal(f.api.snapshot().project.root,f.mainRoot());assert.equal(f.editor.model,null);
});

test('a late main file-list response cannot restore project A after project B becomes current',async t=>{
  const wait=deferred();let delayed=false;const f=fixture(t,{filesList:main=>delayed&&main?.id==='project-a'?wait.promise:undefined});await f.run('loadProjectState()');await f.settle();delayed=true;const older=f.run('loadFilesList(".",true)');await tick();await f.run('openProjectPath("C:/projects/b")');await f.settle();wait.resolve();await older;await f.settle();assert.equal(f.getMain().id,'project-b');assert.equal(f.mainRoot(),f.projects[1].root);assert.equal(f.api.snapshot().project.root,f.mainRoot());
});

test('IDE project picker follows the main project/session flow instead of independently retargeting the editor',async t=>{
  const f=fixture(t);await f.run('loadProjectState()');await f.settle();const select=f.w.document.getElementById('ideProjectSelect');select.value='project-b';select.dispatchEvent(new f.w.Event('change',{bubbles:true}));await f.settle();assert.equal(f.getMain().id,'project-b');assert.equal(f.mainRoot(),f.projects[1].root);assert.equal(f.api.snapshot().project.root,f.projects[1].root);assert.ok(f.requests.some(request=>request.route==='/api/project'&&request.init?.method==='POST'));
});

test('run confirmation cannot launch an old project after the main IDE root changes',async t=>{
  const f=fixture(t);await f.run('loadProjectState()');await f.settle();await f.api.openFile('main.py');const confirmation=deferred(),requests=[];f.w.IexaDialogs.confirm=()=>confirmation.promise;f.bridge.runPlan=async()=>({label:'Run A',command:'python main.py',cwd:f.projects[0].root,shell:'powershell',exitMarker:'IEXA_IDE_EXIT_CODE'});f.w.fetch=async(route,init)=>{requests.push({route,init});return{ok:true,json:async()=>route==='/api/terminal/sessions'?{session:{id:'should-not-exist'}}:{ok:true}};};f.run(fs.readFileSync(path.join(renderer,'services/IDEAgent.js'),'utf8'));const running=f.w.IexaIDEAgent.runTask(f.api.context(),'file');const rejected=assert.rejects(running,/切换|项目|运行/);await tick();f.setMain(f.projects[1]);f.run('projectRoot="C:/projects/b";projectName="B"');await f.run('syncIDEProject()');confirmation.resolve(true);await rejected;assert.equal(requests.some(request=>request.route==='/api/terminal/sessions'),false);assert.equal(requests.some(request=>request.route.includes('/execute')),false);
});
