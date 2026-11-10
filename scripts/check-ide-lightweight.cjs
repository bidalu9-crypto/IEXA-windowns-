/* One owned Electron instance, production renderer/preload/host, real Monaco,
 * Ruff, Git, FileTools journal and a single lazy Python language process.
 * Run only after source freeze: node scripts/check-ide-lightweight.cjs
 * IEXA_IDE_TEST_APP_ROOT=<packaged resources/app> selects the actual EXE path.
 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,execFile,execFileSync}=require('node:child_process');
const {LIMITS,readSystemSnapshot,systemBudgetError,summarizeSystem}=require('./helpers/system-budget.cjs');
const repo=path.resolve(__dirname,'..'),appRoot=path.resolve(process.env.IEXA_IDE_TEST_APP_ROOT||repo),actual=process.argv.includes('--actual-worker');
const output=path.resolve(process.env.IEXA_IDE_TEST_OUTPUT||path.join(repo,'.iexa-artifacts/ide-lightweight-20261108',process.env.IEXA_IDE_TEST_APP_ROOT?'packaged':'source'));fs.mkdirSync(output,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function processTable(){return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoLogo','-NoProfile','-Command',"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')}} | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,timeout:10000},(error,stdout)=>{if(error)return reject(error);try{const rows=JSON.parse(stdout);resolve((Array.isArray(rows)?rows:[rows]).filter(Boolean));}catch(error){reject(error);}}));}
const {processIdentity,sameProcess,descendants,terminationScript}=require('./helpers/owned-processes.cjs');
async function spawnedIdentity(child,marker,started){
  const row=(await processTable()).find(row=>row.ProcessId===child.pid&&row.ParentProcessId===process.pid&&Date.parse(row.CreationDate)>=started&&String(row.CommandLine||'').includes(marker));
  if(!row)throw Error('Spawned process identity could not be verified: '+child.pid);
  return row;
}
async function killOwned(expected,known=new Map()){
  if(!processIdentity(expected))throw Error('Cleanup requires a verified process identity');
  let targets;
  try{targets=descendants(await processTable(),expected,known);}
  catch(error){
    // Even if enumeration fails, the exact previously observed identities can
    // be checked individually by CIM before any termination is attempted.
    targets=[...new Map([expected,...known.values()].map(row=>[processIdentity(row),row])).values()];
  }
  if(!targets.length)return [];
  await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoLogo','-NoProfile','-Command',terminationScript(targets)],{windowsHide:true,timeout:15000},error=>error?reject(error):resolve()));
  const deadline=Date.now()+2500;
  for(;;){
    const remaining=(await processTable()).filter(row=>targets.some(expected=>sameProcess(row,expected)));
    if(!remaining.length||Date.now()>=deadline)return remaining;
    await pause(100);
  }
}
if(!process.versions.electron&&!actual){
  (async()=>{
    const duration=Number(process.env.IEXA_IDE_ACCEPTANCE_TIMEOUT_MS||300000);
    if(!Number.isFinite(duration)||duration<30000||duration>600000)throw Error('Acceptance timeout must be between 30000 and 600000 ms');
    const lock=path.join(path.dirname(output),'run.lock');if(fs.existsSync(lock)){const previous=Number(fs.readFileSync(lock,'utf8'));if(alive(previous))throw Error('A lightweight acceptance instance is already running: '+previous);fs.unlinkSync(lock);}fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
    const owned=new Map(),samples=[],cleanupErrors=[];
    let child,childIdentity,watchdog,stopReason='',sampleTimer,deadlineTimer,scratch='',exitCode=null,exitSignal=null,runError,sampling=false,stopping;
    let survivorsAfterAppExit=[],survivorsAfterCleanup=[];
    const save=()=>fs.writeFileSync(path.join(output,'resource-watchdog.json'),JSON.stringify({rssLimitBytes:1.2*1024**3,minimumFreeBytes:4*1024**3,systemLimits:LIMITS,maximumDurationMs:duration,stopReason,samples,owned:[...owned.values()],cleanupErrors},null,2));
    try{
      const preflight=await readSystemSnapshot();samples.push({at:Date.now(),preflight:true,system:summarizeSystem(preflight)});save();const preflightError=systemBudgetError(preflight);if(preflightError)throw Error(preflightError);
      scratch=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'iexa-lightweight-')));const project=path.join(scratch,"A Python Git 中文 & user's"),otherProject=path.join(scratch,'B other project'),data=path.join(scratch,'data');for(const directory of [project,otherProject,data])fs.mkdirSync(directory);
      const put=(name,value)=>{fs.mkdirSync(path.dirname(path.join(project,name)),{recursive:true});fs.writeFileSync(path.join(project,name),value);};
      const long='# long formatter fixture\n'+Array.from({length:800},(_,i)=>`def function_${i}( a=1,b = 2):\n    return(a+b)\n\n`).join('')+'print(function_0())\n';
      put('long.py',long);put('bad.py','def broken():\n    if True:\n    print("missing indentation")\n');put('plain.js','const JS_ONLY_NO_LSP = true;\n');put('main.py','print("HEAD_BASE")\n');put('review.py','user_owned = "KEEP_USER_EDIT"\n'+Array.from({length:70},(_,i)=>`value_${i} = ${i}\n`).join(''));put('semantic.py','class Person:\n    def greet(self) -> str:\n        return "hello"\n\nperson = Person()\nanswer: int = "TYPE_MISMATCH"\nprint(person.greet())\n');put('completion.py','class Person:\n    def greet(self) -> str:\n        return "hello"\n\nperson = Person()\nperson.\n');put('index.html','<!doctype html><h1>LIGHTWEIGHT_NATIVE_PREVIEW</h1>');put('.gitignore','__pycache__/\n');
      const git=(...args)=>execFileSync('git',['-c','core.autocrlf=false',...args],{cwd:project,encoding:'utf8',windowsHide:true});git('init','-b','main');git('config','user.name','IDE fixture');git('config','user.email','fixture@localhost');git('add','--all');git('commit','-m','baseline');put('main.py','print("INDEX_STAGED")\n');git('add','main.py');put('main.py','print("WORKTREE_CHANGED")\n');put('added.js','const ADDED = true;\n');fs.writeFileSync(path.join(otherProject,'other.js'),'const OTHER = true;\n');
      fs.writeFileSync(path.join(scratch,'fixture.json'),JSON.stringify({scratch,project,otherProject,data,long,appRoot},null,2));
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
      const started=Date.now(),log=fs.openSync(path.join(output,'electron.log'),'w');
      try{child=spawn(process.env.IEXA_IDE_TEST_APP_ROOT?process.execPath:path.join(repo,'node_modules/electron/dist/electron.exe'),[__filename,process.env.IEXA_IDE_TEST_APP_ROOT?'--actual-worker':'--worker',scratch],{cwd:repo,env,windowsHide:true,stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
      const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{exitCode=code;exitSignal=signal;resolve();});});
      // Register the rejection immediately while CIM verifies the spawned root.
      exited.catch(()=>{});
      childIdentity=await spawnedIdentity(child,__filename,started);owned.set(processIdentity(childIdentity),childIdentity);
      let rejectStopped;
      const stopped=new Promise((resolve,reject)=>{rejectStopped=reject;});stopped.catch(()=>{});
      function stop(reason){
        if(stopping)return stopping;
        stopReason=reason;save();
        stopping=(async()=>{try{const remaining=await killOwned(childIdentity,owned);if(remaining.length)cleanupErrors.push('Termination left identities: '+remaining.map(processIdentity).join(', '));}
          catch(error){cleanupErrors.push(error.message);}finally{save();rejectStopped(Error(stopReason));}})();
        return stopping;
      }
      async function sample(){
        if(sampling||stopReason)return;sampling=true;
        try{
          const snapshot=await readSystemSnapshot(),rows=snapshot.processes,tree=descendants(rows,childIdentity,owned);
          if(!tree.length&&child.exitCode!==null)return;
          const rss=tree.reduce((n,row)=>n+Number(row.WorkingSetSize||0),0),free=os.freemem();
          if(!tree.length||!Number.isFinite(rss)||rss<=0)throw Error('Owned process resource sample is empty or has zero RSS');
          samples.push({at:Date.now(),rss,free,system:summarizeSystem(snapshot),processes:tree.map(row=>({pid:row.ProcessId,parent:row.ParentProcessId,created:row.CreationDate,name:row.Name,rss:Number(row.WorkingSetSize||0),cpu100ns:Number(row.UserModeTime||0)+Number(row.KernelModeTime||0),command:row.CommandLine}))});save();
          const globalError=systemBudgetError(snapshot);
          if(globalError)await stop(globalError);
          else if(rss>1.2*1024**3)await stop('Owned RSS exceeded 1.2 GiB');
          else if(free<4*1024**3)await stop('Machine free memory fell below 4 GiB');
          else if(tree.some(row=>/codeoss[\\/].*(?:server-main|node\.exe)|codeoss.*extensionHost/i.test(row.CommandLine||'')))await stop('Unexpected full IDE kernel process');
        }catch(error){samples.push({at:Date.now(),sampleError:error.message});await stop('Resource sampling failed: '+error.message);}
        finally{sampling=false;}
      }
      deadlineTimer=setTimeout(()=>{void stop('Acceptance exceeded '+duration+' ms');},duration);
      await sample();
      if(!stopReason)sampleTimer=setInterval(()=>{if(!sampling)watchdog=sample();},2500);
      await Promise.race([exited,stopped]);clearInterval(sampleTimer);clearTimeout(deadlineTimer);if(watchdog)await watchdog;
      // Give Electron's already-exiting children a short grace period, while
      // still retaining exact identities of orphans observed by the watchdog.
      const exitDeadline=Date.now()+2500;let rows;
      do{rows=await processTable();survivorsAfterAppExit=descendants(rows,childIdentity,owned);if(!survivorsAfterAppExit.length)break;if(Date.now()<exitDeadline)await pause(150);}while(Date.now()<exitDeadline);
      if(survivorsAfterAppExit.length)await killOwned(childIdentity,owned);
      if(exitCode!==0||exitSignal)throw Error('Acceptance worker exited with code '+exitCode+' and signal '+exitSignal);
      if(!samples.some(sample=>sample.rss>0))throw Error('No nonzero process resource sample was recorded');
      if(survivorsAfterAppExit.length)throw Error('Owned processes remained after the application exited');
    }catch(error){runError=error;if(!stopReason)stopReason=error.message;}
    finally{
      clearInterval(sampleTimer);clearTimeout(deadlineTimer);if(watchdog)await watchdog;if(stopping)await stopping;
      if(childIdentity){try{const remaining=await killOwned(childIdentity,owned);survivorsAfterCleanup=remaining.map(row=>({pid:row.ProcessId,created:row.CreationDate,name:row.Name}));}catch(error){cleanupErrors.push(error.message);}}
      save();const result={exitCode,exitSignal,stopReason,scratch,output,maximumDurationMs:duration,peakRss:Math.max(0,...samples.map(sample=>sample.rss||0)),ownedPids:[...owned.values()].map(row=>row.ProcessId),ownedIdentities:[...owned.keys()],survivorsAfterAppExit:survivorsAfterAppExit.map(row=>({pid:row.ProcessId,created:row.CreationDate,name:row.Name})),survivorsAfterCleanup,cleanupErrors};
      fs.writeFileSync(path.join(output,'execution.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
      if(fs.existsSync(lock)&&fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);
      if(runError||stopReason||cleanupErrors.length||survivorsAfterCleanup.length)process.exitCode=1;
    }
    if(runError)throw runError;
  })().catch(error=>{console.error(error);process.exitCode=1;});
}else{
  const electron=actual?null:require('electron'),{app,BrowserWindow,WebContentsView,ipcMain,dialog,session,desktopCapturer}=electron||{app:{whenReady:()=>Promise.resolve(),exit:code=>process.exit(code)}};
  const fixture=JSON.parse(fs.readFileSync(path.join(process.argv[3],'fixture.json'),'utf8'));process.env.IEXA_WORKSPACE=fixture.data;if(!actual){app.setPath('userData',path.join(fixture.scratch,'profile'));app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-background-timer-throttling');}
  let win,host,server,actualChild,actualIdentity,mainConnection,pageConnection,currentAction='boot';
  const report={appRoot,scope:actual?'Actual packaged EXE, product entry/renderer/preload/host, real Monaco/Python/Git/AI review. Provider is an explicit local fixture; no online model claim.':'Source Electron with product renderer/preload/host, real Monaco/Python/Git/AI review. Provider is an explicit local fixture; no online model claim.',checks:[],diagnostics:[],sourceHashes:{},screenshots:[]};
  const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)),record=(name,evidence)=>{report.checks.push({name,passed:true,evidence});save();console.log('PASS '+name);};
  const evaluate=expression=>win.webContents.executeJavaScript(expression,true),state=()=>evaluate('IexaIDE.snapshot()'),changes=()=>evaluate('IexaIDE.changes().snapshot()'),native=expression=>ev(mainConnection,expression);
  const executeMain=expression=>actual?native(expression):eval(expression);
  async function until(fn,label,timeout=25000){let last;const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(error){last=error;}await pause(65);}throw Error(label+(last?': '+last.message:''));}
  const model=file=>`monaco.editor.getModels().find(m=>m.uri.scheme==='iexa-ide'&&m.uri.path.endsWith(${JSON.stringify('/'+file)}))`;
  async function key(keyCode,modifiers=[]){await win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});await win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await pause(120);}
  async function click(selector){currentAction='click '+selector;if(['#ideFormat','#ideSave','#ideGitChanges','#ideAIChanges'].includes(selector)&&await evaluate("document.getElementById('ideMoreMenuPopup').hidden"))await click('#ideMoreMenu');if(['#ideRun','#ideStop'].includes(selector)&&await evaluate("document.getElementById('ideRunMenuPopup').hidden"))await click('#ideRunMenu');const rect=await until(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`),'Reachable control '+selector);for(const type of ['mouseDown','mouseUp'])await win.webContents.sendInputEvent({type,button:'left',x:Math.round(rect.x),y:Math.round(rect.y),clickCount:1});await pause(100);}
  async function drag(selector,dx,dy=0){
    currentAction='drag '+selector;
    const rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();return r&&r.width&&r.height?{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}:null})()`);
    assert.ok(rect,'Visible drag handle '+selector);
    await win.webContents.sendInputEvent({type:'mouseDown',button:'left',x:rect.x,y:rect.y,clickCount:1});
    try{await pause(100);for(let step=1;step<=6;step++){await win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:Math.round(rect.x+dx*step/6),y:Math.round(rect.y+dy*step/6)});await pause(25);}}
    finally{await win.webContents.sendInputEvent({type:'mouseUp',button:'left',x:rect.x+dx,y:rect.y+dy,clickCount:1});}
    await pause(180);
  }
  async function capture(name){const sharp=require('sharp');let bytes;if(actual){bytes=Buffer.from(await native("(async()=>{const e=globalThis.__lwElectron,w=globalThis.__lwWindow,s=(await e.desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1384,height:900}})).find(s=>s.id===w.getMediaSourceId());return (s&&!s.thumbnail.isEmpty()?s.thumbnail.toPNG():(await w.webContents.capturePage()).toPNG()).toString('base64')})()"),'base64');}else{const source=(await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1384,height:900}})).find(source=>source.id===win.getMediaSourceId());bytes=source&&!source.thumbnail.isEmpty()?source.thumbnail.toPNG():(await win.webContents.capturePage()).toPNG();}fs.writeFileSync(path.join(output,name+'.png'),bytes);await sharp(bytes).resize({width:960,withoutEnlargement:true}).jpeg({quality:84}).toFile(path.join(output,name+'-review.jpg'));report.screenshots.push(name+'-review.jpg');save();}
  async function open(file){await evaluate(`IexaIDE.openFile(${JSON.stringify(file)})`);await until(async()=>(await state()).activeFile===file&&await evaluate(`!!${model(file)}`),'Open '+file);}
  async function chooseProject(root){await evaluate(`openProjectPath(${JSON.stringify(root)})`);await until(async()=>{const snapshot=await state();return snapshot.project?.root.toLowerCase()===root.toLowerCase()&&await evaluate(`String(projectRoot).toLowerCase()===${JSON.stringify(root.toLowerCase())}`);},'Main project and IDE bind '+root);}
  const languageStatus=()=>evaluate('window.iexaDesktop.ide.languageStatus({workspaceId:IexaIDE.snapshot().workspaceId})');
  async function closeOverlay(){if(await evaluate("!!document.getElementById('ideChangesOverlay')"))await click('#ideChangesOverlay .ide-changes-close');}
  async function aiWrite(file,content){const expression=`(async()=>{const {FileTools}=globalThis.__lwRequire(${JSON.stringify(path.join(appRoot,'dist/main/tools/ToolExecutors'))});return new FileTools().writeFile(${JSON.stringify(file)},${JSON.stringify(content)},${JSON.stringify(fixture.project)})})()`;const result=await executeMain(expression);assert.equal(result.success,true,result.output);await until(async()=>(await changes()).reviews.some(record=>record.path===file),'Real journal '+file);return result;}
  async function providerContext() {
    // Exercise the production HTTP route, including its project-bound context
    // injection and tool registration. Only the upstream model is a fixture.
    const upstream = await executeMain(String.raw`(async()=>{
      const http=globalThis.__lwRequire('node:http');globalThis.__lwProviderRequests=[];
      globalThis.__lwUpstream=http.createServer((request,response)=>{
        let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
          const input=JSON.parse(body||'{}');
          if(!input.stream){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'IDE fixture title'}}]}));return;}
          globalThis.__lwProviderRequests.push(input);
          response.writeHead(200,{'Content-Type':'text/event-stream'});
          response.end('data: '+JSON.stringify({choices:[{delta:{content:'LOCAL_IDE_CONTEXT_RECEIVED'},finish_reason:null}]})+'\n\n'+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
        });
      });
      await new Promise(resolve=>globalThis.__lwUpstream.listen(0,'127.0.0.1',resolve));
      return 'http://127.0.0.1:'+globalThis.__lwUpstream.address().port;
    })()`);
    try {
      const chat = await evaluate(`(async()=>{
        const api=async(route,body)=>{const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;};
        await api('/api/profiles',{id:'lightweight-local-fixture',provider:'custom',model:'fixture',apiKey:'LOCAL-FIXTURE',baseURL:${JSON.stringify(upstream)},contextWindow:200000,maxOutputTokens:512});
        const {session}=await api('/api/sessions',{ideProjectRoot:${JSON.stringify(fixture.project)}});
        await IexaIDE.flushContext();
        const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:session.id,message:'Inspect current IDE state'})});
        return {status:response.status,text:await response.text()};
      })()`);
      assert.equal(chat.status,200,chat.text);assert.match(chat.text,/LOCAL_IDE_CONTEXT_RECEIVED/);assert.match(chat.text,/event: done/);
      return await executeMain(String.raw`(()=>{
        const requests=globalThis.__lwProviderRequests.filter(request=>(request.tools||[]).some(tool=>tool.function?.name==='ide_context'));
        if(requests.length!==1)throw Error('Expected one project Agent stream with ide_context, received '+requests.length);
        const sent=requests[0],messages=sent.messages.filter(message=>message.role!=='system');
        return {context:globalThis.__lwRequire(${JSON.stringify(path.join(appRoot,'dist/main/ide/IDEContext'))}).getIDEContextForRoot(${JSON.stringify(fixture.project)}),sent:{messages,systemPrompt:sent.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n'),tools:sent.tools}};
      })()`);
    } finally {
      await executeMain("(async()=>{const upstream=globalThis.__lwUpstream;if(upstream){upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));delete globalThis.__lwUpstream;}})()");
    }
  }
  async function runAcceptance(){
    assert.equal(await evaluate("!!document.querySelector('script[src*=\"CodeOSS\"]')"),false);await chooseProject(fixture.project);const projectA=(await state()).workspaceId;await click('[data-workbench-view=ide]');await evaluate('IexaIDE.ready()');if(!(await state()).expanded)await click('#ideExpand');await open('plain.js');let ls=await languageStatus();assert.equal(ls.pid,undefined);assert.equal(ls.status,'idle');record('Main project opens the same IDE root; ordinary JavaScript creates no Python language process',{project:(await state()).project,language:ls});
    await evaluate("window.__lwProviders={};for(const [name,key] of [['registerCompletionItemProvider','completion'],['registerHoverProvider','hover']]){const original=monaco.languages[name];monaco.languages[name]=function(language,provider){if(language==='python')window.__lwProviders[key]=provider;return original.apply(this,arguments)}};true");
    // Existing service providers are captured by the normal service creation
    // on the first editor initialization. If already registered, the host API
    // below also validates the exact document/version sent by that service.
    const plainBefore=await evaluate(model('plain.js')+'.getValue()');await evaluate("document.getElementById('chatInput').value='KEEP_LIGHTWEIGHT_COMPOSER_DRAFT';true");await click('#ideMonaco .view-line');await key('End',['control']);await win.webContents.insertText('// A_UNSAVED_DRAFT\n');await until(()=>evaluate(model('plain.js')+'.getValue().includes("A_UNSAVED_DRAFT")'),'Native typing creates A draft');
    await chooseProject(fixture.otherProject);const projectB=(await state()).workspaceId;await open('other.js');await click('#ideMonaco .view-line');await key('End',['control']);await win.webContents.insertText('// B_UNSAVED_DRAFT\n');await chooseProject(fixture.project);await open('plain.js');assert.ok(await evaluate(model('plain.js')+'.getValue().includes("A_UNSAVED_DRAFT")'));assert.equal(await evaluate("document.getElementById('chatInput').value"),'KEEP_LIGHTWEIGHT_COMPOSER_DRAFT');assert.equal(fs.readFileSync(path.join(fixture.project,'plain.js'),'utf8'),plainBefore);record('Main project A/B switch preserves distinct dirty models and original chat draft',{projectA,projectB,modelCount:await evaluate('monaco.editor.getModels().filter(m=>m.uri.scheme==="iexa-ide").length')});
    await open('long.py');const original=await evaluate(model('long.py')+'.getValue()');await click('#ideMonaco .view-line');await key('F',['shift','alt']);await until(()=>evaluate(model('long.py')+'.getValue()!=='+JSON.stringify(original)),'Actual Shift+Alt+F formats long Python',30000);const formatted=await evaluate(model('long.py')+'.getValue()');assert.ok(formatted.split('\n').length>3000);assert.equal(fs.readFileSync(path.join(fixture.project,'long.py'),'utf8'),original);await key('Z',['control']);await until(()=>evaluate(model('long.py')+'.getValue()==='+JSON.stringify(original)),'Actual Ctrl+Z restores full original');await key('F',['shift','alt']);await until(()=>evaluate(model('long.py')+'.getValue()==='+JSON.stringify(formatted)),'Second format');await key('S',['control']);await until(()=>fs.readFileSync(path.join(fixture.project,'long.py'),'utf8')===formatted,'Actual Ctrl+S saves exact formatted bytes');const executed=execFileSync('python',[path.join(fixture.project,'long.py')],{encoding:'utf8',windowsHide:true}).trim();assert.equal(executed,'3');record('Actual format/undo/save shortcuts preserve full Python and the saved program executes',{originalLines:original.split('\n').length,formattedLines:formatted.split('\n').length,originalSHA256:hash(original),formattedSHA256:hash(formatted),stdout:executed});await capture('python-format');
    await open('bad.py');const invalid=await evaluate(model('bad.py')+'.getValue()');await click('#ideMonaco .view-line');await key('F',['shift','alt']);const syntax=await until(()=>evaluate(`monaco.editor.getModelMarkers({resource:${model('bad.py')}.uri,owner:'iexa-python-format'}).find(m=>m.startLineNumber===3)`),'Parser diagnostic line3');assert.equal(await evaluate(model('bad.py')+'.getValue()'),invalid);record('Invalid Python preserves editor bytes and exposes exact parser line/column',syntax);
    await open('semantic.py');ls=await until(async()=>{const status=await languageStatus();return status.status==='ready'&&status.pid?status:null;},'One actual Python language server ready',30000);report.languagePid=ls.pid;const semanticMarkers=await until(()=>evaluate(`monaco.editor.getModelMarkers({resource:${model('semantic.py')}.uri,owner:'iexa-python-lsp'}).filter(m=>m.message.includes('int')||m.message.includes('TYPE_MISMATCH'))` ).then(markers=>markers.length?markers:null),'Real versioned Python type diagnostic',30000);
    const hover=await evaluate(`window.iexaDesktop.ide.languageRequest({workspaceId:IexaIDE.snapshot().workspaceId,method:'hover',path:'semantic.py',text:${model('semantic.py')}.getValue(),version:${model('semantic.py')}.getVersionId(),position:{line:6,character:14}})`);assert.equal(hover.status,'ready');assert.ok(hover.result?.contents);await open('completion.py');const completion=await evaluate(`window.iexaDesktop.ide.languageRequest({workspaceId:IexaIDE.snapshot().workspaceId,method:'completion',path:'completion.py',text:${model('completion.py')}.getValue(),version:${model('completion.py')}.getVersionId(),position:{line:5,character:7},context:{triggerKind:1}})`);assert.equal(completion.status,'ready');assert.ok((completion.result.items||completion.result).some(item=>item.label==='greet'));assert.equal((await languageStatus()).pid,ls.pid);record('One project-scoped Python server supplies real completion, hover and versioned diagnostics',{pid:ls.pid,completion:(completion.result.items||completion.result).map(item=>item.label).slice(0,30),hover:hover.result,diagnostics:semanticMarkers});await capture('python-language-service');
    await open('semantic.py');await evaluate(`(()=>{const e=monaco.editor.getEditors().find(e=>e.getModel()===${model('semantic.py')});e.setSelection(new monaco.Range(6,1,6,30));return IexaIDE.flushContext()})()`);const provider=await providerContext();assert.match(provider.context,/semantic\.py/);assert.match(JSON.stringify(provider.sent.messages),/TYPE_MISMATCH/);assert.match(JSON.stringify(provider.sent.messages),/languageDiagnostics/);assert.doesNotMatch(provider.sent.systemPrompt,/TYPE_MISMATCH/);assert.equal(await evaluate("document.getElementById('chatInput').value"),'KEEP_LIGHTWEIGHT_COMPOSER_DRAFT');record('Actual flushContext reaches the existing AgentRuntime provider fixture with selection, dirty state and LSP diagnostics',{context:provider.context,provider:'explicit local fixture',onlineModelUsed:false});
    await chooseProject(fixture.otherProject);await until(async()=>{const status=await languageStatus();return !status.pid;},'Switching projects releases the previous Python server');await until(()=>!alive(ls.pid),'Old Python server PID disappears');record('Switching away releases the exact Python process while retaining editor drafts',{releasedPid:ls.pid});await chooseProject(fixture.project);await open('main.py');await evaluate('IexaIDE.changes().refresh()');const git=(await changes()).git;const mm=git.files.find(file=>file.path==='main.py');assert.equal(mm.index,'M');assert.equal(mm.workTree,'M');await click('#ideGitChanges');await until(()=>evaluate("!!document.querySelector('#ideChangesOverlay .ide-changes-file[data-path=\"main.py\"]')"),'Git UI changed file');await click('#ideChangesOverlay .ide-changes-file[data-path="main.py"]');await until(()=>evaluate("!!document.querySelector('#ideChangesDiff .monaco-diff-editor')"),'Rendered Git diff');record('Real Git staged/worktree state opens rendered Monaco diff',{git});await capture('git-diff');await closeOverlay();
    const before=fs.readFileSync(path.join(fixture.project,'review.py'),'utf8'),after=before.replace('value_2 = 2','value_2 = 202').replace('value_62 = 62','value_62 = 6262');await aiWrite('review.py',after);await open('review.py');await until(()=>evaluate(model('review.py')+'.getValue()==='+JSON.stringify(after)),'Live AI edit visible');await click('#ideAIChanges');await until(()=>evaluate("document.querySelectorAll('#ideChangesHunks .ide-review-hunk[data-decision=pending]').length===2"),'Two pending real AI hunks');await capture('ai-review');await click('#ideChangesHunks .ide-review-hunk[data-decision=pending] [data-review-action=accept]');await until(()=>evaluate("document.querySelectorAll('#ideChangesHunks .ide-review-hunk[data-decision=pending]').length===1"),'Accept first hunk');await click('#ideChangesHunks .ide-review-hunk[data-decision=pending] [data-review-action=reject]');await until(()=>fs.readFileSync(path.join(fixture.project,'review.py'),'utf8')===before.replace('value_2 = 2','value_2 = 202'),'Reject second hunk preserving user baseline');record('Real FileTools journal and review UI accept/reject distant hunks while preserving user edits');await closeOverlay();
    await aiWrite('ai-created.py','AI_CREATED = True\n');await evaluate('IexaIDE.refresh()');await open('ai-created.py');await click('#ideAIChanges');await until(()=>evaluate("!!document.querySelector('#ideChangesHunks [data-review-action=reject]')"),'AI created review');await click('#ideChangesHunks [data-review-action=reject]');await until(()=>!fs.existsSync(path.join(fixture.project,'ai-created.py')),'Reject new file deletes exact AI bytes');record('Rejecting an AI creation removes only the unchanged reviewed file');await closeOverlay();
    await click('#ideRun');await until(async()=>(await state()).server?.status==='running','Static preview running');await click('#ideViewSplit');
    const nativeVisible=()=>actual?native("globalThis.__lwWindow.contentView.children.some(v=>v.getVisible())"):Promise.resolve(win.contentView.children.some(view=>view.getVisible()));
    await until(nativeVisible,'Native preview side by side');await capture('chat-preview-side-by-side');
    const rectangle=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
    async function finishedDrag(label){assert.equal(await evaluate("document.querySelectorAll('.ide-drag-shield').length"),0,label+' releases its drag shield');await until(nativeVisible,label+' restores the actual native preview');}
    const explorerBefore=await rectangle('#ideExplorer');await drag('#ideExplorerResizer',32);const explorerAfter=await rectangle('#ideExplorer');assert.ok(explorerAfter.width>=explorerBefore.width+16,'Real explorer drag changes measured width');await finishedDrag('Explorer drag');
    const previewBefore=await rectangle('#idePreviewColumn');await drag('#idePreviewResizer',-40);const previewAfter=await rectangle('#idePreviewColumn');assert.ok(previewAfter.width>=previewBefore.width+20,'Real preview drag changes measured width');await finishedDrag('Preview drag');
    await click('#ideLogTab');await until(()=>evaluate("!document.getElementById('ideLogs').hidden"),'Actual output tab opens');const logsBefore=await rectangle('#ideLogs');await drag('#ideLogsResizer',0,-36);const logsAfter=await rectangle('#ideLogs');assert.ok(logsAfter.height>=logsBefore.height+18,'Real bottom output drag changes measured height');await finishedDrag('Output drag');
    const chatBefore=await rectangle('.chat-container'),chatDelta=chatBefore.width>328?-40:40;await drag('#filesResizer',chatDelta);const chatAfter=await rectangle('.chat-container');assert.ok(Math.abs(chatAfter.width-chatBefore.width)>=20,'Real chat drag changes measured width');await finishedDrag('Chat drag');
    const savedLayout=await evaluate("JSON.parse(localStorage.getItem('iexa-ide-layout'))");assert.ok(Number.parseInt(savedLayout.explorerWidth)>=explorerBefore.width+16);assert.ok(Number.parseInt(savedLayout.previewWidth)>=previewBefore.width+20);assert.ok(Number.parseInt(savedLayout.logHeight)>=logsBefore.height+18);assert.ok(Math.abs(Number.parseInt(savedLayout.chatWidth)-chatAfter.width)<=2);
    record('Four actual mouse boundaries resize measured panes, persist layout and release shields while restoring native preview',{explorer:{before:explorerBefore.width,after:explorerAfter.width},preview:{before:previewBefore.width,after:previewAfter.width},output:{before:logsBefore.height,after:logsAfter.height},chat:{before:chatBefore.width,after:chatAfter.width},savedLayout});await capture('four-boundary-drags');
    await click('#ideViewCode');const layout=await evaluate("(()=>{const a=document.querySelector('.chat-container').getBoundingClientRect(),b=document.getElementById('idePanel').getBoundingClientRect();return{chatWidth:a.width,chatRight:a.right,ideLeft:b.x,ideWidth:b.width,windowWidth:innerWidth,composer:document.getElementById('chatInput').value}})()");assert.ok(layout.chatWidth>=279&&layout.ideWidth>480);assert.ok(layout.chatRight<=layout.ideLeft+4);assert.equal(layout.composer,'KEEP_LIGHTWEIGHT_COMPOSER_DRAFT');record('Original chat composer stays beside the adjustable IDE and native preview',layout);await capture('chat-ide-drag');
    const windowErrors=await evaluate('window.__lwErrors');assert.deepEqual(windowErrors,[]);assert.equal(report.diagnostics.length,0,JSON.stringify(report.diagnostics));record('Renderer and native surfaces complete with zero console errors or window exceptions',{windowErrors,consoleErrors:report.diagnostics});
  }
  app.whenReady().then(async()=>{
    globalThis.__lwRequire=require;for(const file of ['src/renderer/services/IDEWorkspace.js','src/renderer/services/IDELanguageService.js','src/renderer/services/FilesPanel.js','src/renderer/services/IDEAgent.js','src/renderer/services/IDEChanges.js','resources/ide-host.cjs','preload.js','dist/main/ide/PythonLanguageService.js'])report.sourceHashes[file]=hash(fs.readFileSync(path.join(appRoot,file)));
    if(actual)await bootActual();else{const backend=require(path.join(appRoot,'dist/main/server'));server=await backend.startServer(0,false);const origin='http://127.0.0.1:'+server.address().port;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fixture.project]});ipcMain.on('iexa:get-initial-appearance',event=>{event.returnValue={};});ipcMain.on('iexa:get-window-state',event=>{event.returnValue={};});ipcMain.handle('iexa:window-command',()=>({}));ipcMain.handle('iexa:desktop-live-state',()=>({open:false}));ipcMain.handle('iexa:pick-folder',()=>fixture.project);win=new BrowserWindow({width:1384,height:900,useContentSize:true,show:false,skipTaskbar:true,webPreferences:{preload:path.join(appRoot,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});win.setMenuBarVisibility(false);win.showInactive();win.webContents.on('console-message',event=>{if(event?.level==='error')report.diagnostics.push({action:currentAction,message:event.message,url:event.sourceId,line:event.lineNumber});});host=require(path.join(appRoot,'resources/ide-host.cjs')).installIDEHost({ipcMain,dialog,WebContentsView,session,getWindow:()=>win,getProjectRoot:backend.getProjectRoot,appOrigin:origin,workspaceFile:name=>path.join(fixture.data,name)});await win.loadURL(origin+'/#login='+backend.getServerCredentials(server).loginCode);}
    await until(()=>evaluate("typeof IexaIDE!=='undefined'&&!!currentSessionId"),'Application ready');await evaluate("window.__lwErrors=[];addEventListener('error',event=>__lwErrors.push({message:event.message,file:event.filename,line:event.lineno}));true");await runAcceptance();
    // The project-switch check intentionally leaves A/B drafts dirty. Save via
    // the product API before closing so the native save prompt is not left
    // awaiting a real user while the test has disconnected its inspectors.
    const saved=await evaluate('IexaIDE.saveAll()');assert.equal(saved,true);assert.equal(await evaluate('IexaIDE.hasUnsavedChanges()'),false);
    record('All retained project drafts save through the product before normal application shutdown');report.status='passed';
  }).catch(async error=>{report.status='failed';report.error=error.stack;console.error(error.stack);try{report.snapshot=await state();report.changes=await changes();await capture('failure');}catch(captureError){report.captureError=captureError.message;}}).finally(async()=>{
    try{await evaluate('IexaIDE.allowClose();true');}catch{}
    try{
      if(actual){
        try{await evaluate("void window.iexaDesktop.windowCommand('close')");}catch{}
        mainConnection?.close();pageConnection?.close();
        if(actualChild){
          try{await until(()=>actualChild.exitCode!==null||actualChild.signalCode!==null,'Actual EXE exits',15000);}
          catch(error){
            report.status='failed';report.actualCleanupError=error.message;
            if(actualIdentity){const remaining=await killOwned(actualIdentity);report.actualCleanupRemaining=remaining.map(processIdentity);}
            else report.actualCleanupError+='; Actual EXE process identity was not verified';
          }
          report.actualExitCode=actualChild.exitCode;report.actualExitSignal=actualChild.signalCode;
          if(actualChild.exitCode!==0||actualChild.signalCode)report.status='failed';
        }
      }else{
        await host?.shutdown();if(win&&!win.isDestroyed())win.destroy();await host?.dispose();
        if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
      }
    }catch(error){report.status='failed';report.cleanupError=error.stack;}
    if(report.languagePid)report.languagePidAliveAfterShutdown=alive(report.languagePid);if(report.languagePidAliveAfterShutdown)report.status='failed';save();console.log('LIGHTWEIGHT_RESULT '+JSON.stringify({status:report.status,checks:report.checks.length,diagnostics:report.diagnostics.length,output}));app.exit(report.status==='passed'?0:1);
  });
  async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});let id=0;const waiting=new Map();ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id){if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')report.diagnostics.push({action:currentAction,message:message.params.args.map(arg=>arg.value||arg.description).join(' '),source:'CDP'});if(message.method==='Runtime.exceptionThrown')report.diagnostics.push({action:currentAction,exception:message.params.exceptionDetails,source:'CDP'});return;}const pending=waiting.get(message.id);if(pending){clearTimeout(pending.timer);waiting.delete(message.id);message.error?pending.reject(Error(message.error.message)):pending.resolve(message.result);}});return{close:()=>ws.close(),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{waiting.delete(n);reject(Error(method+' timeout'));},30000);waiting.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));})};}
  async function ev(connection,expression){const result=await connection.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value;}
  async function port(){return new Promise(resolve=>{const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});}
  async function bootActual(){
    const directory=path.resolve(appRoot,'../..'),exe=path.join(directory,'IEXA.exe'),apiPort=await port(),inspectPort=await port(),cdpPort=await port();
    const env={...process.env,IEXA_WORKSPACE:fixture.data,IEXA_HEADLESS:'1',IEXA_PORT:String(apiPort)};delete env.ELECTRON_RUN_AS_NODE;
    const started=Date.now(),log=fs.openSync(path.join(output,'actual-exe.log'),'w');
    actualChild=spawn(exe,[`--inspect=127.0.0.1:${inspectPort}`,`--remote-debugging-port=${cdpPort}`,'--disable-renderer-backgrounding','--disable-background-timer-throttling'],{cwd:directory,env,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
    actualChild.once('error',error=>{report.actualSpawnError=error.message;});
    actualIdentity=await spawnedIdentity(actualChild,`--remote-debugging-port=${cdpPort}`,started);report.actualIdentity={pid:actualIdentity.ProcessId,created:actualIdentity.CreationDate};
    const target=await until(async()=>(await(await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0],'Actual main inspector');mainConnection=await connect(target.webSocketDebuggerUrl);
    await native("globalThis.__lwRequire=typeof require==='function'?require:process.mainModule.require.bind(process.mainModule);globalThis.__lwElectron=globalThis.__lwRequire('electron');true");
    // The inspector starts before Electron creates its first BrowserWindow.
    await until(()=>native("(()=>{globalThis.__lwWindow=globalThis.__lwElectron.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());return !!globalThis.__lwWindow})()"),'Actual application window');
    const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(target=>target.type==='page'&&target.url.startsWith(`http://127.0.0.1:${apiPort}`)),'Actual renderer');
    pageConnection=await connect(page.webSocketDebuggerUrl);await pageConnection.send('Runtime.enable');
    report.actual=await native("(()=>{const w=globalThis.__lwWindow;w.setContentSize(1384,900);w.showInactive();return{execPath:process.execPath,appRoot:globalThis.__lwElectron.app.getAppPath()}})()");
    assert.equal(path.resolve(report.actual.execPath),exe);assert.equal(path.resolve(report.actual.appRoot),appRoot);report.actual.manifestSHA256=hash(fs.readFileSync(path.join(directory,'build-manifest.json')));
    win={webContents:{executeJavaScript:expression=>ev(pageConnection,expression),sendInputEvent:event=>native(`globalThis.__lwWindow.webContents.sendInputEvent(${JSON.stringify(event)});true`),insertText:text=>native(`globalThis.__lwWindow.webContents.insertText(${JSON.stringify(text)})`)}};
  }
}
