'use strict';
// Source provenance only: copies/hash/diffs evidence. No GUI, tests or package mutation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts/desktop-comparison-20261110');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const relative=f=>path.relative(root,f).replace(/\\/g,'/');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const artifact=path.join(out,'change-evidence-'+Date.now());fs.mkdirSync(artifact,{recursive:true});
const sources=new Map(),backups=[];
function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(directory,e.name)):[path.join(directory,e.name)]);}
for(const dir of fs.readdirSync(out,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name.startsWith('before-'))){
 const directory=path.join(out,dir.name),all=files(directory),metadata=all.filter(f=>/^(manifest\.json|sha256\.json|sha256\.jsonl)$/.test(path.basename(f)));
 const group={directory:relative(directory),metadata:[],entries:[]};
 for(const file of metadata){
  group.metadata.push({path:relative(file),sha256:sha(fs.readFileSync(file))});
  const parsed=file.endsWith('.jsonl')?fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):read(file);
  for(const item of Array.isArray(parsed)?parsed:[parsed]){
   const expected=String(item.sha256||item.Hash||'').toLowerCase(),original=item.file||item.path||item.Path||(item.name?'desktop-agent/publish/'+item.name:null);
   const absolute=original?path.resolve(root,original):null;
   const matches=all.filter(f=>!metadata.includes(f)&&sha(fs.readFileSync(f))===expected);
   const backup=matches.find(f=>path.basename(f)===path.basename(original||''))||matches[0];
   const entry={source:original?relative(absolute):null,recordedSHA256:expected,backup:backup?relative(backup):null,backupHashVerified:!!backup};
   group.entries.push(entry);if(absolute&&fs.existsSync(absolute)){const s=sources.get(absolute)||{path:relative(absolute),before:[]};s.before.push(entry);sources.set(absolute,s);}
  }
 }
 group.otherFiles=all.filter(f=>!metadata.includes(f)).map(f=>({path:relative(f),sha256:sha(fs.readFileSync(f))}));backups.push(group);
}
const additions=['scripts/audit-desktop-comparison.cjs','scripts/check-desktop-keyboard-regression.cjs','scripts/check-desktop-comparison.cjs','scripts/fixtures/desktop-comparison-tasks.cjs','scripts/prepare-desktop-change-manifest.cjs','tests/desktop-comparison-oracles.test.js','tests/native-keyboard.test.js','docs/desktop-comparison-20261110.md'];
additions.push('scripts/bind-desktop-change-package.cjs','scripts/verify-desktop-rollback-packages.cjs','docs/desktop-comparison-rollback-20261110.md');
additions.push('tests/desktop-helper-restart.test.js','scripts/check-desktop-pointer-restart-regression.cjs','scripts/cleanup-desktop-comparison-calculator.cjs');
additions.push('scripts/close-authorized-calculator-90704.cjs');
additions.push('tests/native-perception-merge.test.js','scripts/check-desktop-ribbon-popup.cjs');
for(const f of additions){const absolute=path.join(root,f);if(fs.existsSync(absolute)&&!sources.has(absolute))sources.set(absolute,{path:f,before:[]});}
for(const [absolute,s] of sources){
 const bytes=fs.readFileSync(absolute),snapshot=path.join(artifact,'current',s.path);fs.mkdirSync(path.dirname(snapshot),{recursive:true});fs.writeFileSync(snapshot,bytes);s.sha256=sha(bytes);s.snapshot=relative(snapshot);s.bytes=bytes.length;
 for(let i=0;i<s.before.length;i++){
  const b=s.before[i];if(!b.backup)continue;
  b.changedFromCurrent=b.recordedSHA256!==s.sha256;
  const diff=spawnSync('git',['diff','--no-index','--no-ext-diff','--binary','--',path.join(root,b.backup),snapshot],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  if(![0,1].includes(diff.status))throw Error('Diff failed '+s.path+': '+diff.stderr);
  const target=path.join(artifact,'diffs',s.path.replace(/[\\/]/g,'__')+'.'+i+'.patch');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,diff.stdout);b.diff={path:relative(target),sha256:sha(Buffer.from(diff.stdout)),exitCode:diff.status};
 }
}
const final={schemaVersion:1,preparedAt:new Date().toISOString(),status:'source-snapshot-prepared-final-package-pending',scope:'Only files linked by this task before-* backups plus explicit new comparison artifacts. Git worktree includes earlier changes; do not attribute all dirty files to this task.',backups,sources:[...sources.values()],finalPackage:{status:'pending-parent-notification',manifestSHA256:null},limitations:['Snapshots capture source at preparation time; verify again against final package build provenance.','Diffs compare preserved before-* snapshots against this prepared source snapshot, not against a clean repository.','Missing before backup means no pre-change provenance was recorded for that new file.','No test or GUI success is implied by this manifest.']};
fs.writeFileSync(path.join(artifact,'change-manifest.json'),JSON.stringify(final,null,2)+'\n');
fs.writeFileSync(path.join(out,'change-manifest.json'),JSON.stringify(final,null,2)+'\n');
console.log(JSON.stringify({path:relative(path.join(out,'change-manifest.json')),evidence:relative(artifact),sources:final.sources.length,backupGroups:backups.length,unverified:backups.flatMap(b=>b.entries).filter(e=>!e.backupHashVerified).length}));
