// Test-only native helper: current-source build, isolated endpoint, exact PID/path/hash.
// Never falls back to desktop-agent/publish or replaces a production helper.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
async function startNativeTestHelper(root,endpoint,out) {
 try { await fetch(endpoint+'/health',{signal:AbortSignal.timeout(300)}); throw new Error('Native test endpoint occupied'); }
 catch(e) {if(e.message==='Native test endpoint occupied')throw e;}
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'native-build.log'),execFileSync('dotnet',['build','desktop-agent/Iexa.DesktopAgent.csproj','--no-restore'],{cwd:root,encoding:'utf8',windowsHide:true}));
 const exe=path.join(root,'desktop-agent/bin/Debug/net8.0-windows10.0.19041.0/Iexa.DesktopAgent.exe');
 const hash=createHash('sha256').update(fs.readFileSync(exe.replace(/\.exe$/,'.dll'))).digest('hex');
 const log=fs.openSync(path.join(out,'native-run.log'),'a');
 const child=spawn(exe,[],{env:{...process.env,IEXA_DESKTOP_PORT:new URL(endpoint).port},windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
 let launchError;child.on('error',e=>{launchError=e;});
 try {
  for(let i=0;i<80;i++) {
   if(launchError)throw launchError;
   if(child.exitCode!==null)throw new Error('Fresh native helper exited before readiness');
   let health;try {const r=await fetch(endpoint+'/health',{signal:AbortSignal.timeout(300)});if(r.ok)health=await r.json();}catch{}
   if(health) {
    assert.equal(health.pid,child.pid);assert.equal(health.protocolVersion,6);
    assert.equal(path.normalize(health.executablePath).toLowerCase(),path.normalize(exe).toLowerCase());
    fs.writeFileSync(path.join(out,'native-binary.json'),JSON.stringify({exe,dllSha256:hash,health},null,2));
    return child;
   }
   await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Fresh native helper readiness timeout');
 }catch(e){child.kill();throw e;}
}
module.exports={startNativeTestHelper};
