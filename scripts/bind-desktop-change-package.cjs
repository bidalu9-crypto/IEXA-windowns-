'use strict';
// Read-only source/package comparison; only supplemental evidence is written.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts/desktop-comparison-20261110'),packageRoot=path.join(root,'release/IEXA-preview-20261109');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
function verifyExactClose(original){
 const {evidenceParts,resultObservationOutput}=require('./fixtures/desktop-comparison-tasks.cjs').auditHelpers;
 const {calls,results}=evidenceParts(original),receipts=new Map(results.map(event=>[event.data.id,event]));
 const objects=event=>{
  const output=resultObservationOutput(event).output,values=[];
  function collect(value){if(!value||typeof value!=='object'||value.ok===false||value.success===false)return;if(Array.isArray(value)){value.forEach(collect);return;}values.push(value);for(const k of ['data','result','results'])collect(value[k]);}
  try{collect(JSON.parse(output));}catch{}
  for(const line of output.split(/\r?\n/)){const text=line.replace(/^\s*\d+\.\s+[a-z_]+:\s*/i,'').trim();if(text.startsWith('{'))try{collect(JSON.parse(text));}catch{}}
  return{output,values};
 };
 // Require an explicit model close action with successful receipt, not a
 // supervisor cleanup or a later disappearance used to upgrade failed input.
 const closeCandidates=calls.filter(c=>c.args?.expectWindowClosed===true&&['hotkey','key','click','click_element'].includes(c.args?.action));
 const close=closeCandidates.at(-1),event=close&&receipts.get(close.id);
 if(!event)throw Error('Async-close acceptance requires the final explicit close action to have a successful matched receipt');
 const proof=objects(event).values.find(v=>v.windowClosed===true&&v.verified===true&&v.verificationMethod==='window_closed'&&Number.isSafeInteger(v.closedHandle)&&v.closedHandle>0&&(v.inputCompleted===true||v.foregroundVerified===true));
 if(!proof)throw Error('Async-close receipt must include completed input, windowClosed:true, verified:true, verificationMethod:window_closed and exact closedHandle');
 const handle=proof.closedHandle,index=calls.indexOf(close);
 const observedBefore=calls.slice(0,index).reverse().find(c=>receipts.has(c.id)&&['observe','launch','activate'].includes(c.args?.action));
 if(!observedBefore)throw Error('Async-close original window needs prior successful observation');
 const prior=objects(receipts.get(observedBefore.id));
 const known=Number(observedBefore.args?.handle)===handle||prior.values.some(v=>Number(v.window?.handle||v.session?.handle||v.handle)===handle)||new RegExp('(?:窗口[：:]|目标[：:])[^\\n]*handle='+handle+'(?:\\s|$)').test(prior.output);
 if(!known)throw Error('Closed handle does not match the original observed window');
 const absence=calls.slice(index+1).find(c=>c.args?.action==='list_windows'&&Number(c.args.handle)===handle&&c.args.includeHidden===true&&!c.args.pid&&!c.args.process&&!c.args.title&&receipts.has(c.id)&&c.completedAt>=close.resultAt&&objects(receipts.get(c.id)).values.some(v=>
  Array.isArray(v.windows)?v.windows.length===0&&(!('count'in v)||v.count===0):v.count===0&&!/窗口[：:]/.test(objects(receipts.get(c.id)).output)));
 if(!absence)throw Error('Async-close acceptance requires a later successful exact original HWND list_windows(includeHidden:true) proving zero windows');
 return{status:'passed',closedHandle:handle,closeToolCallId:close.id,observedBeforeToolCallId:observedBefore.id,absenceToolCallId:absence.id,receipt:{inputCompleted:proof.inputCompleted,foregroundVerified:proof.foregroundVerified,windowClosed:proof.windowClosed,verificationMethod:proof.verificationMethod},scope:'Successful model close ACK plus subsequent exact original HWND absence; no cleanup failure promoted to success.'};
}
const file=path.join(out,'change-manifest.json'),m=read(file),buildPath=path.join(packageRoot,'build-manifest.json'),build=read(buildPath);
const binding={boundAt:new Date().toISOString(),status:'candidate-bound-model-validation-incomplete',packageRoot,manifestSHA256:hash(buildPath),sourceChecks:[],packagedFiles:[],validation:[],limitations:['Package manifest contains file hashes but no signed source hashes. Source-to-binary relationship relies on preserved source snapshot, existing successful build records, and byte equality with local compiled outputs; no rebuild was performed by this audit.','Only task-related compiled files and native helper outputs are rehashed here, not every dependency in the full application package.','Real model Paint, Calculator and 7-Zip verification remains separate; package binding is not universal app-control acceptance.']};
for(const s of m.sources){const actual=hash(path.join(root,s.path));binding.sourceChecks.push({path:s.path,snapshotSHA256:s.sha256,currentSHA256:actual,matched:actual===s.sha256});}
const production=['dist/main/agent/SystemPrompt.js','dist/main/tools/ToolDefinitions.js','dist/main/tools/DesktopAgent.js','dist/main/tools/desktop/DesktopControlSession.js','desktop-agent/publish/Iexa.DesktopAgent.dll','desktop-agent/publish/Iexa.DesktopAgent.exe','desktop-agent/publish/Iexa.DesktopAgent.pdb','desktop-agent/publish/isolated-desktop-capability.json'];
for(const local of production){const packaged='resources/app/'+local,actual=hash(path.join(packageRoot,packaged)),localHash=hash(path.join(root,local));binding.packagedFiles.push({local,packaged,manifestSHA256:build.files[packaged],actualSHA256:actual,localSHA256:localHash,matchesManifest:actual===build.files[packaged],matchesLocalBuild:actual===localHash});}
for(const name of ['restart-check-2/result.json','native-pointer-check/result.json','native-pointer-publish/result.json','package-restart-pointer/result.json']){
 const f=path.join(out,name),r=read(f),log=path.posix.join(path.posix.dirname(name),'workload.log');
 binding.validation.push({path:name,sha256:hash(f),status:r.status,exitCode:r.exit?.code,completedAt:r.completedAt,logs:[{path:log,sha256:hash(path.join(out,log))}]});
}
for(const [name,expected] of [['restart-tests.log',{tests:108,pass:107,fail:0,skipped:1}]]){
 const f=path.join(out,name),content=fs.readFileSync(f,'utf8'),counts={};
 for(const key of Object.keys(expected)){const matches=[...content.matchAll(new RegExp('(?:^|\\n)[^\\n\\w]*'+key+'\\s+(\\d+)\\s*(?:\\r?\\n|$)','g'))];counts[key]=matches.length?Number(matches.at(-1)[1]):null;}
 binding.validation.push({path:name,sha256:hash(f),...counts,expected,tailConfirms:Object.keys(expected).every(key=>counts[key]===expected[key])});
}
// The pointer wrapper reused this filename during later edit-focus checks.
// Never relabel its new bytes as the earlier 93-test log. Retain archived
// binding hashes and the immutable old result record as historical evidence.
binding.supersededLogs=[{path:'native-pointer-tests.log',status:'superseded-by-later-wrapper-run',originalResult:'native-pointer-check/result.json',expectedHistoricalCounts:{tests:93,pass:93,fail:0},currentFileNotParsedAsHistorical:true}];
binding.previousBindingArchives=fs.readdirSync(out,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name.startsWith('binding-archive-')).flatMap(e=>{
 const f=path.join(out,e.name,'package-binding.json');return fs.existsSync(f)?[{path:e.name+'/package-binding.json',sha256:hash(f)}]:[];
});
binding.validationLogs=['restart-compile.log','native-publish.log'].map(name=>({path:name,sha256:hash(path.join(out,name)),scope:'Log content at binding time; not proof all historical checks reran for the current candidate.'}));
const laterNames=['cloaking-check/result.json','cloaking-publish/result.json','package-cloaking/result.json'];
const laterExisting=laterNames.filter(name=>fs.existsSync(path.join(out,name)));
if(laterExisting.length){
 binding.regressionHistory=binding.validation.map(v=>({...v,scope:'Earlier restart/pointer regression evidence; not rerun by this binding and not represented as all rerun on the cloaking candidate.'}));
 binding.validation=[];binding.validationStage='cloaking';binding.pendingValidation=laterNames.filter(name=>!laterExisting.includes(name));
 for(const name of laterExisting){const f=path.join(out,name),r=read(f),log=path.posix.join(path.posix.dirname(name),'workload.log');binding.validation.push({path:name,sha256:hash(f),status:r.status,exitCode:r.exit?.code,completedAt:r.completedAt,logs:fs.existsSync(path.join(out,log))?[{path:log,sha256:hash(path.join(out,log))}]:[]});}
 for(const name of ['cloaking-compile.log','cloaking-tests.log'])if(fs.existsSync(path.join(out,name)))binding.validationLogs.push({path:name,sha256:hash(path.join(out,name)),scope:'Cloaking stage log'});
 if(binding.pendingValidation.length)binding.status='candidate-bound-latest-validation-incomplete';
}else binding.validationStage='restart-pointer';
const editNames=['edit-focus-check/result.json','edit-focus-publish/result.json','package-edit-focus/result.json'];
const editExisting=editNames.filter(name=>fs.existsSync(path.join(out,name)));
if(editExisting.length){
 binding.regressionHistory=[...(binding.regressionHistory||[]),...binding.validation.map(v=>({...v,scope:'Earlier-stage result retained as regression history; not claimed rerun on edit-focus candidate.'}))];
 binding.validation=[];binding.validationStage='edit-focus';binding.pendingValidation=editNames.filter(name=>!editExisting.includes(name));
 for(const name of editExisting){const f=path.join(out,name),r=read(f),log=path.posix.join(path.posix.dirname(name),'workload.log');binding.validation.push({path:name,sha256:hash(f),status:r.status,exitCode:r.exit?.code,completedAt:r.completedAt,logs:fs.existsSync(path.join(out,log))?[{path:log,sha256:hash(path.join(out,log))}]:[]});}
 const name='edit-focus-tests.log',f=path.join(out,name);
 if(fs.existsSync(f)){const content=fs.readFileSync(f,'utf8'),counts={};for(const key of ['tests','pass','fail','skipped']){const found=[...content.matchAll(new RegExp('(?:^|\\n)[^\\n\\w]*'+key+'\\s+(\\d+)\\s*(?:\\r?\\n|$)','g'))];counts[key]=found.length?Number(found.at(-1)[1]):null;}binding.validation.push({path:name,sha256:hash(f),...counts,tailConfirms:counts.tests>0&&counts.pass>0&&counts.fail===0&&counts.pass+(counts.skipped||0)===counts.tests});}
 else binding.pendingValidation.push(name);
 binding.status=binding.pendingValidation.length?'candidate-bound-latest-validation-incomplete':'candidate-bound-model-validation-incomplete';
}
const asyncNames=['async-close-check/result.json','async-close-publish/result.json','package-async-close/result.json'];
const asyncExisting=asyncNames.filter(name=>fs.existsSync(path.join(out,name)));
if(asyncExisting.length){
 binding.regressionHistory=[...(binding.regressionHistory||[]),...binding.validation.map(v=>({...v,scope:'Earlier candidate validation; not rerun on async-close package.'}))];
 binding.validation=[];binding.validationStage='async-close';binding.pendingValidation=asyncNames.filter(name=>!asyncExisting.includes(name));
 for(const name of asyncExisting){const f=path.join(out,name),r=read(f),log=path.posix.join(path.posix.dirname(name),'workload.log');binding.validation.push({path:name,sha256:hash(f),status:r.status,exitCode:r.exit?.code,completedAt:r.completedAt,logs:fs.existsSync(path.join(out,log))?[{path:log,sha256:hash(path.join(out,log))}]:[]});}
 const name='async-close-tests.log',f=path.join(out,name);
 if(fs.existsSync(f)){const content=fs.readFileSync(f,'utf8'),counts={};for(const key of ['tests','pass','fail','skipped']){const found=[...content.matchAll(new RegExp('(?:^|\\n)[^\\n\\w]*'+key+'\\s+(\\d+)\\s*(?:\\r?\\n|$)','g'))];counts[key]=found.length?Number(found.at(-1)[1]):null;}binding.validation.push({path:name,sha256:hash(f),...counts,tailConfirms:counts.tests>0&&counts.pass>0&&counts.fail===0&&counts.pass+(counts.skipped||0)===counts.tests});}
 else binding.pendingValidation.push(name);
}
for(const stage of ['ribbon-popup','perception-return']){
 const names=[stage+'-check/result.json',stage+'-publish/result.json','package-'+stage+'/result.json'],existing=names.filter(name=>fs.existsSync(path.join(out,name)));
 if(!existing.length)continue;
 binding.regressionHistory=[...(binding.regressionHistory||[]),...binding.validation.map(v=>({...v,scope:'Earlier stage validation; not rerun on '+stage+' candidate.'}))];
 binding.validation=[];binding.validationStage=stage;binding.pendingValidation=names.filter(name=>!existing.includes(name));
 for(const name of existing){const f=path.join(out,name),r=read(f),log=path.posix.join(path.posix.dirname(name),'workload.log');binding.validation.push({path:name,sha256:hash(f),status:r.status,exitCode:r.exit?.code,completedAt:r.completedAt,logs:fs.existsSync(path.join(out,log))?[{path:log,sha256:hash(path.join(out,log))}]:[]});}
 const name=stage+'-tests.log',f=path.join(out,name);
 if(fs.existsSync(f)){const counts={},content=fs.readFileSync(f,'utf8');for(const key of ['tests','pass','fail','skipped']){const matches=[...content.matchAll(new RegExp('(?:^|\\n)[^\\n\\w]*'+key+'\\s+(\\d+)\\s*(?:\\r?\\n|$)','g'))];counts[key]=matches.length?Number(matches.at(-1)[1]):null;}binding.validation.push({path:name,sha256:hash(f),...counts,tailConfirms:counts.tests>0&&counts.pass>0&&counts.fail===0&&counts.pass+(counts.skipped||0)===counts.tests});}else binding.pendingValidation.push(name);
}
const hasPendingUwpStage=['async-close','ribbon-popup','perception-return'].includes(binding.validationStage);
binding.targetedAcceptance=[];binding.historicalTargetedAcceptance=[];
for(const [relative,kind] of [['iexa-calculator-1794285372238/supplemental-audit.json','calculator-real-model'],['regression-pointer-1794285693865/supplemental-visual-audit.json','fixed-gui-idle-pointer'],['../desktop-autonomy-20261110/sevenzip-1794285982430/report.json','sevenzip-real-model']]){
 const f=path.resolve(out,relative),record=read(f),entry={path:relative,kind,sha256:hash(f),status:record.strictStatus||record.status,packageManifestSHA256:record.packageManifestSHA256};
 (entry.packageManifestSHA256===binding.manifestSHA256?binding.targetedAcceptance:binding.historicalTargetedAcceptance).push(entry);
}
if(hasPendingUwpStage){
 const run=process.env.IEXA_ASYNC_CLOSE_CALCULATOR_RUN;
 if(run){
  if(!/^iexa-calculator-\d+$/.test(run))throw Error('IEXA_ASYNC_CLOSE_CALCULATOR_RUN must be an exact calculator run directory name');
  const relative=run+'/supplemental-audit.json',f=path.join(out,relative),record=read(f),original=read(path.join(out,run,'report.json'));
  if(original.phase!=='finished'||original.modelCompleted!==true||record.packageManifestSHA256!==binding.manifestSHA256)throw Error('Async-close Calculator must be completed and use the exact current package');
  if(record.originalReport?.sha256!==hash(path.join(out,run,'report.json'))||original.packageManifestSHA256!==binding.manifestSHA256)throw Error('Async-close supplemental audit must match the preserved original report bytes and package');
  const closeVerification=verifyExactClose(original);
  binding.targetedAcceptance.push({path:relative,kind:'calculator-real-model-async-close',sha256:hash(f),status:record.strictStatus,packageManifestSHA256:record.packageManifestSHA256,closeVerification});
 }
 binding.pendingTargetedAcceptance=binding.targetedAcceptance.some(r=>r.kind==='calculator-real-model-async-close'&&r.status==='passed')?[]:['Set IEXA_ASYNC_CLOSE_CALCULATOR_RUN after the new-package Calculator run and supplemental audit finish.'];
}
const targetedPassed=binding.targetedAcceptance.length>0&&!binding.pendingTargetedAcceptance?.length&&binding.targetedAcceptance.every(r=>r.status==='passed'&&r.packageManifestSHA256===binding.manifestSHA256);
if(targetedPassed&&!binding.pendingValidation?.length)binding.status='candidate-bound-targeted-acceptance-passed';
if(hasPendingUwpStage){
 const paint=process.env.IEXA_ASYNC_CLOSE_PAINT_RUN;
 if(paint){
  if(!/^iexa-paint-\d+$/.test(paint))throw Error('IEXA_ASYNC_CLOSE_PAINT_RUN must name an exact Paint run');
  const relative=paint+'/supplemental-audit.json',f=path.join(out,relative),record=read(f),originalPath=path.join(out,paint,'report.json'),original=read(originalPath);
  if(original.phase!=='finished'||original.modelCompleted!==true||original.packageManifestSHA256!==binding.manifestSHA256||record.packageManifestSHA256!==binding.manifestSHA256||record.originalReport?.sha256!==hash(originalPath)||record.strictStatus!=='passed'||record.visualReview?.reviewedReopen!==true)
   throw Error('Current Paint acceptance requires completed same-package model, unchanged original report, passed supplemental audit and reviewed reopen');
  binding.targetedAcceptance.push({path:relative,kind:'paint-real-model-current-package',sha256:hash(f),status:record.strictStatus,packageManifestSHA256:record.packageManifestSHA256,scope:'Paint task only; does not certify UWP asynchronous close.'});
 }
 binding.uwpValidation={status:binding.pendingTargetedAcceptance?.length?'pending':'passed',reason:binding.pendingTargetedAcceptance?.length?'User instructed preserving unresponsive baseline Calculator PID 90704 and continuing other apps; no further close or termination.':'New-package Calculator met business and exact original HWND close proof.',preservedBaselinePid:90704};
 if(binding.pendingTargetedAcceptance?.length&&!binding.pendingValidation?.length)binding.status='candidate-bound-uwp-validation-pending';
}
 const wordpad=process.env.IEXA_FINAL_WORDPAD_RUN;
 if(wordpad){
  if(!/^iexa-wordpad-\d+$/.test(wordpad))throw Error('IEXA_FINAL_WORDPAD_RUN must name an exact WordPad run');
  const relative=wordpad+'/supplemental-audit.json',f=path.join(out,relative),record=read(f),originalPath=path.join(out,wordpad,'report.json'),original=read(originalPath);
  if(original.phase!=='finished'||original.modelCompleted!==true||original.packageManifestSHA256!==binding.manifestSHA256||record.packageManifestSHA256!==binding.manifestSHA256||record.originalReport?.sha256!==hash(originalPath)||record.strictStatus!=='passed'||record.visualReview?.reviewedReopen!==true)
   throw Error('Current WordPad acceptance requires completed same-package model, unchanged original report, passed supplemental audit and reviewed reopen');
  binding.targetedAcceptance.push({path:relative,kind:'wordpad-real-model-current-package',sha256:hash(f),status:record.strictStatus,packageManifestSHA256:record.packageManifestSHA256,scope:'WordPad text, formatting, save and reopen task only; does not certify UWP asynchronous close.'});
 }
 const ribbonRun=process.env.IEXA_FIXED_RIBBON_RUN;
if(ribbonRun){
 if(!/^ribbon-popup-\d+$/.test(ribbonRun))throw Error('IEXA_FIXED_RIBBON_RUN must name an exact fixed ribbon run');
 const relative=ribbonRun+'/report.json',f=path.join(out,relative),r=read(f),resources=r.resources;
 const clean=resources&&!resources.stopReason&&['survivorsBeforeCleanup','survivorsAfterCleanup','newObservedSurvivors','cleanupErrors'].every(key=>Array.isArray(resources[key])&&resources[key].length===0);
 if(r.packageManifestSHA256!==binding.manifestSHA256||r.status!=='passed'||r.guiClosed!==true||!r.completedAt||!Array.isArray(r.checks)||r.checks.length<3||!r.checks.every(c=>c.passed===true)||!clean)throw Error('Fixed ribbon acceptance requires exact current package, passed structured checks, GUI closure and clean resources');
 binding.targetedAcceptance.push({path:relative,kind:'fixed-gui-ribbon-popup-current-package',sha256:hash(f),status:r.status,packageManifestSHA256:r.packageManifestSHA256,scope:'Native structured popup/owner/close evidence; no menu screenshot review is claimed.'});
}
binding.limitations.push('Only targetedAcceptance entries matching the current package certify current-package runs. HistoricalTargetedAcceptance includes earlier Calculator/7-Zip/pointer results and does not imply reruns. Earlier WordPad/Paint passes also belong to recorded earlier packages; universal application parity is not established.');
// Binding source/build provenance may succeed while explicitly preserving a
// pending UWP live test. It must never promote a Paint pass into UWP evidence.
const pendingUwpAllowed=hasPendingUwpStage&&binding.uwpValidation?.status==='pending';
const passed=(targetedPassed||pendingUwpAllowed)&&!binding.pendingValidation?.length&&binding.sourceChecks.every(x=>x.matched)&&binding.packagedFiles.every(x=>x.matchesManifest&&x.matchesLocalBuild)&&binding.validation.every(x=>x.status?x.status==='passed'&&x.exitCode===0:x.tailConfirms);
if(!passed){fs.writeFileSync(path.join(out,'package-binding-failure.json'),JSON.stringify(binding,null,2));throw Error('Source/package binding mismatch; see package-binding-failure.json');}
m.status='source-and-candidate-package-bound';m.finalPackage=binding;
// Preserve the prior binding before replacing convenience pointers. Earlier
// candidate evidence must remain inspectable after later GUI/doc updates.
const archive=path.join(out,'binding-archive-'+Date.now());fs.mkdirSync(archive,{recursive:true});const archived=[];
for(const name of ['change-manifest.json','package-binding.json']){const prior=path.join(out,name);if(fs.existsSync(prior)){fs.copyFileSync(prior,path.join(archive,name));archived.push({file:name,sha256:hash(prior)});}}
fs.writeFileSync(path.join(archive,'sha256.json'),JSON.stringify(archived,null,2)+'\n');
fs.writeFileSync(file,JSON.stringify(m,null,2)+'\n');
fs.writeFileSync(path.join(out,'package-binding.json'),JSON.stringify(binding,null,2)+'\n');
console.log(JSON.stringify({manifestSHA256:binding.manifestSHA256,sourceChecks:binding.sourceChecks.length,packagedFiles:binding.packagedFiles.length,matched:passed,status:binding.status}));
