'use strict';
// Read-only business audit: writes supplemental reports only. Never creates
// fixtures, dispatches input, calls a model, or edits original report.json.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {readRtf,auditHelpers:h}=require('./fixtures/desktop-comparison-tasks.cjs');
const root=path.resolve(process.argv[2]||'.iexa-artifacts/desktop-comparison-20261110');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const hashFile=f=>f&&fs.existsSync(f)?digest(fs.readFileSync(f)):null;
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n');
function historyTexts(output){
 const values=[];
 for(const line of String(output||'').split(/\r?\n/)){
  const m=/^\s*e_\S+\s*\|\s*listitem\s*\|\s*(.*?)\s*\|/i.exec(line);if(m)values.push(m[1]);
 }
 function collect(v){if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(collect);return;}
  if(String(v.role).toLowerCase()==='listitem'&&typeof v.text==='string')values.push(v.text);
  for(const k of ['data','elements','postObservation','result','results'])collect(v[k]);
 }
 try{collect(JSON.parse(String(output)));}catch{}
 for(const line of String(output||'').split(/\r?\n/))if(line.trimStart().startsWith('{'))try{collect(JSON.parse(line));}catch{}
 return [...new Set(values.map(v=>v.replace(/[\u200e\u200f\u202a-\u202e]/g,'').trim()))];
}
function verify(r){
 const f=r.fixture,evidence=r,checks=h.sharedChecks(evidence),details={};
 if(f.input){
  details.sourceSHA256=hashFile(f.input);details.outputSHA256=hashFile(f.output);
  checks.sourceUnchanged=details.sourceSHA256===(f.originalSHA256||f.original?.sha256);
  checks.outputExists=!!details.outputSHA256;details.lifecycle=h.reopened(evidence,f.output);
  checks.reopenedExactPath=details.lifecycle.reopenedExactPath;checks.reopenScreenshotSaved=details.lifecycle.reopenScreenshotSaved;
 }
 if(r.kind==='paint'){
  let im;
  if(checks.outputExists)try{
   const py='import sys,json\nfrom PIL import Image,ImageChops\na=Image.open(sys.argv[1]).convert("RGB")\nb=Image.open(sys.argv[2])\ne=a.transpose(Image.Transpose.ROTATE_270)\nprint(json.dumps({"format":b.format,"size":list(b.size),"exactClockwiseRotation":b.size==e.size and ImageChops.difference(b.convert("RGB"),e).getbbox() is None}))';
   im=JSON.parse(execFileSync('python',['-c',py,f.input,f.output],{windowsHide:true,encoding:'utf8',timeout:10000}));
  }catch(e){details.oracleError=e.message;}
  details.image=im;checks.pngFormat=im?.format==='PNG';checks.dimensions=im?.size?.join('x')==='120x200';checks.allPixelsCorrect=im?.exactClockwiseRotation===true;
 }else if(r.kind==='wordpad'){
  const raw=checks.outputExists?fs.readFileSync(f.output,'latin1'):'',chars=readRtf(raw),text=chars.map(c=>c.ch).join(''),start=text.indexOf(f.title),titleChars=start<0?[]:chars.slice(start,start+f.title.length);
  details.text=text;checks.rtfFormat=/^\{\\rtf/.test(raw);checks.firstLineExact=text.trimStart().split('\n')[0]?.trim()===f.title;
  checks.editedStatus=text.includes('STATUS '+f.marker)&&!text.includes('STATUS PENDING');checks.titleEntirelyBold=titleChars.length===f.title.length&&titleChars.filter(c=>c.ch.trim()).every(c=>c.bold);
 }else if(r.kind==='calculator'){
  const {results,images}=h.evidenceParts(evidence),observed=results.map(event=>{const receipt=h.resultObservationOutput(event);return{event,texts:h.observedControlTexts(receipt.output),history:h.observedHistoryTexts(receipt.output),artifacts:receipt.artifacts};});
  details.outputArtifacts=observed.flatMap(o=>o.artifacts.map(a=>({...a,toolCallId:o.event.data.id})));
  details.calculations=f.calculations.map(c=>{
   const o=observed.find(o=>o.texts.some(t=>h.isObservedNumber(t,c.result))||o.history.some(t=>h.isObservedNumber(t,c.result,{expression:true}))),id=o?.event.data.id;
   return {...c,observed:!!o,toolCallId:id,image:images.find(i=>i.toolCallId===id)?.path};
  });
  checks.firstResultObserved=details.calculations[0].observed;checks.secondResultObserved=details.calculations[1].observed;
  const history=observed.find(o=>f.calculations.every(c=>o.history.some(t=>h.isObservedNumber(t,c.result,{expression:true}))));
  checks.bothResultsInHistory=!!history;details.historyToolCallId=history?.event.data.id;
  details.historyObservations=observed.filter(o=>o.history.length).map(o=>({toolCallId:o.event.data.id,items:o.history,image:images.find(i=>i.toolCallId===o.event.data.id)?.path}));
 }else throw Error('Unknown task '+r.kind);
 return {status:Object.values(checks).every(Boolean)?'passed':'failed',checks,...details};
}
function audit(directory){
 const file=path.join(directory,'report.json'),bytes=fs.readFileSync(file),r=JSON.parse(bytes);
 if(r.phase!=='finished')return {run:path.basename(directory),mode:r.mode,kind:r.kind,status:'pending',phase:r.phase};
 const cleanupFile=path.join(directory,'process-cleanup.json');
 const resources=r.resources||(fs.existsSync(cleanupFile)?read(cleanupFile):null);
 const notesFile=path.join(directory,'run-notes.json'),cleanupSupplementFile=path.join(directory,'cleanup-supplement.json');
 const runNotes=fs.existsSync(notesFile)?read(notesFile):null,cleanupSupplement=fs.existsSync(cleanupSupplementFile)?read(cleanupSupplementFile):null;
 const verification=verify(r),scopeFile=path.join(directory,'scope-deviation.json'),deviation=fs.existsSync(scopeFile)?read(scopeFile):null;
 const reviewFile=path.join(directory,'visual-review.json'),review=fs.existsSync(reviewFile)?read(reviewFile):null;
 const reviewValid=!!review&&review.frames?.length>0&&review.frames.every(frame=>hashFile(path.join(directory,frame.file))===frame.sha256);
 const reviewedReopen=reviewValid&&review.reopenConfirmed===true&&review.frames.some(frame=>path.resolve(directory,frame.file)===path.resolve(verification.lifecycle?.image||directory));
 const resourceIssues=(resources?.cleanupErrors?.length||0)+(resources?.survivorsAfterCleanup?.length||0)+(resources?.newObservedSurvivors?.length||0);
 const reasons=Object.entries(verification.checks).filter(([,v])=>!v).map(([k])=>'oracle:'+k);
 if(!r.modelCompleted)reasons.push('model_not_completed:'+String(r.modelState?.cancelReason||r.stopReason||r.modelState?.status));
 if(deviation?.scopeConstraintMet===false)reasons.push('task_directory_scope_violation');
 if(resourceIssues||resources?.stopReason||r.resourceError)reasons.push('resource_or_cleanup_failure');
 if(r.error)reasons.push('runner_error');
 const infrastructureFailures=r.modelState?.infrastructureFailures;
 if(Array.isArray(infrastructureFailures)?infrastructureFailures.length>0:Number(infrastructureFailures)>0)reasons.push('infrastructure_failure');
 const historyFrame=verification.historyObservations?.find(o=>o.toolCallId===verification.historyToolCallId)?.image;
 const reviewedFollowupFrame=r.imageIndex?.find(i=>i.toolCallId===review?.historyScreenshotToolCallId)?.path;
 const reviewedHistory=reviewValid&&review.calculationsAndHistoryConfirmed===true&&(historyFrame?review.frames.some(frame=>path.resolve(directory,frame.file)===path.resolve(historyFrame)):!!review.historyObservationToolCallId&&review.historyObservationToolCallId===verification.historyToolCallId&&!!reviewedFollowupFrame&&review.frames.some(frame=>path.resolve(directory,frame.file)===path.resolve(reviewedFollowupFrame)));
 const needsVisualReview=verification.status==='passed'&&(r.kind==='calculator'?!reviewedHistory:!reviewedReopen);
 const status=reasons.length?'failed':needsVisualReview?'pending_visual_review':'passed';
 const result={schemaVersion:1,auditedAt:new Date().toISOString(),run:path.basename(directory),mode:r.mode,kind:r.kind,
  originalReport:{path:file,sha256:digest(bytes),status:r.status,businessStatus:r.businessStatus},strictStatus:status,reasons,verification,
  calls:r.actionCount??r.calls?.length,elapsedMs:r.elapsedMs,modelCompleted:r.modelCompleted,modelStatus:r.modelState?.status,stopReason:r.modelState?.cancelReason||r.stopReason||null,
  scope:{status:deviation?.scopeConstraintMet===false?'violated':'no_recorded_violation',deviation,limitation:'No deviation file is not proof that all out-of-directory effects were excluded.'},
  visualReview:{valid:reviewValid,reviewedReopen,reviewedHistory,needsVisualReview,record:review},resources,runNotes,cleanupSupplement,
  packageManifestSHA256:r.packageManifestSHA256,controllerSHA256:r.controllerSHA256,
  originalLifecycle:r.oracle?.lifecycle,
  oracleCorrection:r.oracle?.status==='failed'&&verification.status==='passed'?{originalStatusPreserved:true,reason:'Original oracle missed numbered batch JSON/full-output attachments and sqrt history listitems without equals. Supplemental verification reads actual control roles, never current display as history.'}:null,
  comparisonLimit:'Same packaged desktop controller and task requirements; distinct randomized fixture tokens. Codex is controlled by the parent agent through the local bridge, not the entire Codex application tool stack.'};
 if(hashFile(file)!==result.originalReport.sha256)throw Error('Original report changed during audit: '+file);
 write(path.join(directory,'supplemental-audit.json'),result);return result;
}
const runs=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(path.join(root,e.name,'report.json')))
 .filter(e=>['iexa','codex'].includes(read(path.join(root,e.name,'report.json')).mode)).map(e=>audit(path.join(root,e.name)));
const summary={generatedAt:new Date().toISOString(),root,runs,limitations:['Pending runs are excluded from completed comparisons.','Original report.json files are preserved; strict status includes recorded scope violations and visual review.','Clean process state after harness cleanup does not prove the model closed its own window.','Codex elapsed time includes project analysis, reporting and tool orchestration; it is not model speed.','Codex Paint has 26 recorded calls: 2 prior Calculator cleanup calls plus 24 Paint calls. Calls include batches and are not counts of physical actions.','Later cleanup supplements never erase original timeout or cleanup failure.','No assertion of control over every application follows from these tasks.']};
write(path.join(root,'comparison-audit.json'),summary);
const rows=runs.map(r=>`| ${r.mode} | ${r.kind} | ${r.run} | ${r.strictStatus||r.status} | ${r.calls??'-'} | ${r.elapsedMs?Math.round(r.elapsedMs/1000):'-'} | ${r.resources?.peakRss?Math.round(r.resources.peakRss/1048576):'-'} | ${(r.reasons||[]).join(', ')||'-'} |`);
fs.writeFileSync(path.join(root,'comparison-audit.md'),['# Desktop comparison supplemental audit','',`Generated: ${summary.generatedAt}`,'','| Mode | App | Run | Strict status | Calls | Seconds | Peak RSS MiB | Failure reasons |','| --- | --- | --- | --- | ---: | ---: | ---: | --- |',...rows,'',...summary.limitations.map(v=>'- '+v),'','The comparison uses the same packaged desktop controller. Codex actions are selected by the parent agent through the local bridge; this does not compare the entire Codex application tool stack.',''].join('\n'));
console.log(JSON.stringify({root,runs:runs.map(r=>({run:r.run,status:r.strictStatus||r.status,calls:r.calls,reasons:r.reasons}))},null,2));
