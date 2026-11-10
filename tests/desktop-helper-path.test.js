'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createHash}=require('node:crypto'),{createRequire}=require('node:module');
const childProcess=require('node:child_process');
const repo=path.resolve(__dirname,'..');

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iexa-helper-path-'));
 t.after(()=>{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert.match(path.basename(root),/^iexa-helper-path-/);
  fs.rmSync(root,{recursive:true,force:true});
 });
 const install=path.join(root,'installation'),resources=path.join(install,'resources'),app=path.join(resources,'app');
 const workspace=path.join(root,'unrelated-project','workspace');fs.mkdirSync(workspace,{recursive:true});
 return {root,install,resources,app,workspace,execPath:path.join(install,'IEXA.exe')};
}
function binary(root,text='packaged-helper'){
 const dir=path.join(root,'desktop-agent','publish');fs.mkdirSync(dir,{recursive:true});
 const exe=path.join(dir,'Iexa.DesktopAgent.exe'),dll=exe.replace(/\.exe$/,'.dll');
 fs.writeFileSync(exe,'inert apphost '+text);fs.writeFileSync(dll,text);
 const sha256=createHash('sha256').update(fs.readFileSync(dll)).digest('hex');
 const marker=path.join(dir,'isolated-desktop-capability.json');
 fs.writeFileSync(marker,JSON.stringify({version:1,sha256}));
 return {exe,dll,marker,sha256};
}
// Execute the built production modules at a relocated module path, with real
// filesystem layouts. No helper process or GUI is started by these tests.
function load(relative,directory,options={},overrides={}){
 const actual=path.join(repo,'dist','main',relative+'.js'),realRequire=createRequire(actual);
 const runtimeProcess=new Proxy(process,{get(target,key){
  if(key==='resourcesPath')return options.resources;
  if(key==='execPath')return options.execPath || target.execPath;
  if(key==='cwd')return ()=>options.workspace;
  if(key==='env')return {...target.env,LOCALAPPDATA:options.root};
  return Reflect.get(target,key);
 }});
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(actual,'utf8'),{
  module:mod,exports:mod.exports,__dirname:directory,__filename:path.join(directory,path.basename(actual)),
  require:id=>Object.hasOwn(overrides,id)?overrides[id]:realRequire(id),
  process:runtimeProcess,Buffer,URL,AbortSignal,AbortController,fetch,setTimeout,clearTimeout,console,
 },{filename:actual});
 return mod.exports;
}
function application(f,app=f.app,source=false){
 const helper=load('tools/desktop/DesktopHelperPath',path.join(app,source?'src':'dist','main','tools','desktop'),f);
 const isolated=load('tools/desktop/NativeIsolatedWorkspace',path.join(app,'dist','main','tools','desktop'),f,{'./DesktopHelperPath':helper});
 return {helper,isolated};
}
async function attemptedStart(f,helper,isolated){
 let attempted;
 const {DesktopAgent}=load('tools/DesktopAgent',path.join(f.app,'dist','main','tools'),f,{
  './desktop/DesktopHelperPath':helper,'./desktop/NativeIsolatedWorkspace':isolated,
  child_process:{...childProcess,spawn:(command,args)=>{attempted={command,args:Array.from(args)};throw Error('inert spawn boundary');}},
 });
 const agent=new DesktopAgent(path.dirname(f.workspace));agent.stopIncompatibleHelper=async()=>{};
 try{await assert.rejects(agent.start(),/inert spawn boundary/);return attempted;}finally{agent.close();}
}

test('unpacked packaged startup ignores an arbitrary project parent and cwd with valid helper decoys',async t=>{
 const f=fixture(t),expected=binary(f.app);
 binary(path.dirname(f.workspace),'project-parent-decoy');binary(f.workspace,'cwd-decoy');
 const {helper,isolated}=application(f);
 assert.equal(helper.desktopApplicationRoot(),f.app);
 assert.equal(helper.resolveDesktopHelper().executable,expected.exe);
 assert.deepEqual(await attemptedStart(f,helper,isolated),{command:expected.exe,args:[]});
 // Missing application files do not promote workspace copies to installation roots.
 fs.unlinkSync(expected.exe);fs.unlinkSync(expected.dll);
 assert.equal(helper.resolveDesktopHelper(),undefined);
});

test('source module root takes precedence over a different resources installation',t=>{
 const f=fixture(t),source=path.join(f.root,'checkout'),expected=binary(source,'source');
 binary(f.app,'resources-decoy');binary(f.workspace,'cwd-decoy');
 const {helper}=application(f,source,true);
 assert.equal(helper.desktopApplicationRoot(),source);
 assert.equal(helper.resolveDesktopHelper().executable,expected.exe);
});

test('asar modules choose their physical unpacked helper instead of an archive executable',t=>{
 const f=fixture(t),archive=path.join(f.resources,'app.asar');
 binary(archive,'virtual-archive');binary(f.app,'other-unpacked-layout');
 const expected=binary(archive+'.unpacked','matching-unpacked');
 const {helper,isolated}=application(f,archive);
 assert.equal(helper.resolveDesktopHelper().executable,expected.exe);
 assert.equal(helper.desktopHelperCandidates().some(file=>file.startsWith(archive+path.sep)),false);
 const host=new isolated.NativeIsolatedWorkspace(f.workspace);
 assert.equal(host.executable(),expected.exe);host.close();
});

test('already unpacked roots and ordinary asar parent directory names retain their own helper',t=>{
 const f=fixture(t);
 for(const app of [path.join(f.resources,'app.asar.unpacked'),path.join(f.root,'parent.asar','checkout')]){
  const expected=binary(app),{helper}=application(f,app);
  assert.equal(helper.desktopApplicationRoot(),app);
  assert.equal(helper.resolveDesktopHelper().executable,expected.exe);
 }
});

test('resources/app remains a fallback when the loaded module has no adjacent helper',t=>{
 const f=fixture(t),expected=binary(f.app),moduleRoot=path.join(f.root,'module-only');
 const {helper}=application(f,moduleRoot);
 assert.equal(helper.resolveDesktopHelper().executable,expected.exe);
 const preferred=binary(path.join(f.resources,'app.asar.unpacked'));
 assert.equal(helper.resolveDesktopHelper().executable,preferred.exe);
});

test('a selected DLL-only installation uses dotnet without combining another installation apphost',async t=>{
 const f=fixture(t),expected=binary(f.app,'module-dll');fs.unlinkSync(expected.exe);
 binary(path.join(f.resources,'app.asar.unpacked'),'other-apphost');
 const {helper,isolated}=application(f);
 const selected=helper.resolveDesktopHelper();assert.equal(selected.executable,undefined);assert.equal(selected.dll,expected.dll);
 assert.deepEqual(await attemptedStart(f,helper,isolated),{command:'dotnet',args:[expected.dll]});
 const host=new isolated.NativeIsolatedWorkspace(f.workspace);
 assert.throws(()=>host.executable(),/matching capability/);host.close();
});

test('default isolated capability validation stays with the selected package and refuses stale fallback',t=>{
 const f=fixture(t),expected=binary(f.app,'selected-package');
 binary(path.join(f.resources,'app.asar.unpacked'),'valid-fallback');binary(f.workspace,'valid-workspace-decoy');
 const {helper,isolated}=application(f),host=new isolated.NativeIsolatedWorkspace(f.workspace);
 assert.equal(helper.resolveDesktopHelper().executable,expected.exe);assert.equal(host.executable(),expected.exe);
 for(const invalid of [undefined,'{broken',JSON.stringify({version:2,sha256:expected.sha256}),JSON.stringify({version:1,sha256:'wrong'})]){
  if(invalid===undefined)fs.unlinkSync(expected.marker);else fs.writeFileSync(expected.marker,invalid);
  assert.throws(()=>host.executable(),/matching capability/);
 }
 fs.writeFileSync(expected.marker,'\uFEFF'+JSON.stringify({version:1,sha256:expected.sha256.toUpperCase()}));
 assert.equal(host.executable(),expected.exe);
 fs.writeFileSync(expected.dll,'replaced-after-manifest');assert.throws(()=>host.executable(),/matching capability/);
 host.close();
});

test('an explicit isolated executable override is validated without falling back to the installed helper',t=>{
 const f=fixture(t),installed=binary(f.app),override=binary(path.join(f.root,'explicit-helper'),'explicit');
 const {isolated}=application(f),host=new isolated.NativeIsolatedWorkspace(f.workspace,override.exe);
 assert.notEqual(installed.exe,override.exe);assert.equal(host.executable(),override.exe);
 fs.unlinkSync(override.marker);assert.throws(()=>host.executable(),/matching capability/);
 host.close();
});

test('ToolRuntime supplies the running application root independently of its configured workspace',t=>{
 const f=fixture(t),{helper}=application(f);let captured;
 class CapturedDesktopAgent{constructor(root){captured=root;}}
 const {ToolRuntime}=load('runtime/ToolRuntime',path.join(f.app,'dist','main','runtime'),f,{
  '../tools/DesktopAgent':{DesktopAgent:CapturedDesktopAgent},'../tools/desktop/DesktopHelperPath':helper,
 });
 new ToolRuntime({workspaceDir:f.workspace,memoryDir:path.join(f.root,'memory')});
 assert.equal(captured,f.app);assert.notEqual(captured,path.dirname(f.workspace));
});
