'use strict';
// Independent, read-only business oracle; does not trust the model's final claim.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function verify(directory){
 directory=path.resolve(directory);const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8').replace(/^\uFEFF/,''));
 const report=read('report.json'),cleanup=read('process-cleanup.json'),state=report.modelState;
 const file=path.join(report.fixture.directory,report.fixture.finalname),bytes=fs.existsSync(file)?fs.readFileSync(file):Buffer.alloc(0),content=bytes.toString('utf8');
 const calls=state?.calls||[],successful=calls.filter(call=>call.success===true);
 const normalized=value=>String(value||'').toLowerCase().replace(/\//g,'\\');
 const saves=successful.filter(call=>call.args.action==='hotkey'&&Array.isArray(call.args.keys)&&call.args.keys.map(k=>k.toUpperCase()).join('+')==='CTRL+S');
 const reopened=successful.find(call=>call.args.action==='launch'&&/wps\.exe$/i.test(call.args.app||call.args.executable||'')&&normalized(call.args.arguments).includes(normalized(file))&&saves.some(save=>save.resultAt<call.completedAt));
 const imageEvents=(state?.events||[]).filter(event=>event.event==='tool_result'&&event.data.imageMimeType==='image/png');
 const imageIndex=report.imageIndex||imageEvents.map((event,index)=>({toolCallId:event.data.id,path:path.join(directory,`model-frame-${index}.png`)}));
 const readbackImage=reopened&&imageIndex.find(image=>image.toolCallId===reopened.id||successful.some(call=>call.id===image.toolCallId&&call.completedAt>=reopened.resultAt&&['observe','frame'].includes(call.args.action)));
 const checks={
  modelCompleted:state?.status==='completed'&&state.done===true,
  desktopToolsOnly:calls.length>0&&calls.every(call=>call.name==='desktop_control'),
  downloadServed:Number(report.downloads)>0,
  exactFilename:bytes.length>0&&!fs.existsSync(file+'.rtf'),
  receiptPreserved:content.includes(report.fixture.receipt),
  editedStatusSaved:content.includes(report.fixture.marker)&&!content.includes('STATUS PENDING'),
  savedThroughUI:saves.length>0,
  reopenedExactPathAfterSave:!!reopened,
  readbackScreenshotSaved:!!readbackImage&&fs.existsSync(readbackImage.path),
  noResourceStop:!cleanup.stopReason&&cleanup.peakRss<=1.2*1024**3,
  noSurvivors:cleanup.survivorsAfterCleanup.length===0&&(cleanup.unprovenLateDescendants||[]).length===0&&(cleanup.newObservedSurvivors||[]).length===0,
  noCleanupErrors:cleanup.cleanupErrors.length===0,
  runPassed:report.status==='passed',
 };
 const result={status:Object.values(checks).every(Boolean)?'passed':'failed',checkedAt:new Date().toISOString(),checks,file,sha256:bytes.length?createHash('sha256').update(bytes).digest('hex'):null,toolCalls:calls.length,model:state?.model,readbackImage,readbackCallId:reopened?.id,peakRss:cleanup.peakRss,cleanupWarnings:cleanup.cleanupWarnings||[],imageIndex,scope:'Independent exact output and successful save/reopen call ordering; screenshot still requires visual inspection. This does not claim all-app or full Electron UI memory parity.'};
 fs.writeFileSync(path.join(directory,'independent-verification.json'),JSON.stringify(result,null,2));return result;
}
if(require.main===module){const result=verify(process.argv[2]);console.log(JSON.stringify(result));process.exitCode=result.status==='passed'?0:1;}
module.exports={verify};
