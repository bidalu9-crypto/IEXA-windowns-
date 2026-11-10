'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.iexa-artifacts/desktop-comparison-20261110');
async function hash(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file,{highWaterMark:65536}))h.update(chunk);return h.digest('hex');}
async function main(){
 const packages=[];
 for(const [name,expected,stage] of [['IEXA-preview-20261109.previous-1794276576122','c204d0808b20868c7412fd90f493a3a67a1debfed0b27b5bf5586aba1ca7df5c','initial-baseline'],['IEXA-preview-20261109.previous-1794279606952','531b2acb0382a59586934bd459d7f3025dd5e4670ec260545fc6081aa3c14f4d','first-fix']]){
  const directory=path.join(root,'release',name),manifest=path.join(directory,'build-manifest.json'),data=JSON.parse(fs.readFileSync(manifest,'utf8')),actual=await hash(manifest),checks=[];
  for(const [relative,expectedHash] of Object.entries(data.files)){const file=path.resolve(directory,relative);if(!file.startsWith(directory+path.sep))throw Error('Manifest escapes package');const actualHash=fs.existsSync(file)?await hash(file):null;checks.push({path:relative,expectedSHA256:expectedHash,actualSHA256:actualHash,matched:actualHash===expectedHash});}
  const record={stage,directory,executable:path.join(directory,'IEXA.exe'),manifestSHA256:actual,expectedManifestSHA256:expected,manifestMatches:actual===expected,checkedFiles:checks.length,mismatches:checks.filter(c=>!c.matched),checks};
  record.status=record.manifestMatches&&record.mismatches.length===0?'passed':'failed';packages.push(record);console.log(JSON.stringify({stage,status:record.status,checkedFiles:record.checkedFiles,mismatches:record.mismatches}));
 }
 fs.writeFileSync(path.join(out,'rollback-package-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),scope:'Sequential streaming SHA256 of all manifest-listed files; no process launch, package modification or GUI operation.',packages},null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
