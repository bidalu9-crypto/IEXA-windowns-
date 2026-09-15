const fs=require('node:fs');
const {createPlatformSecretCodec}=require('../../dist/main/security/SecretStore');
// Read-only selected profile hydration: never invokes migrating settings writers,
// exports a vault, clones user data or logs credentials. Only the selected API key
// enters provider memory; test artifacts contain provider/model identifiers only.
function selectedProfile(file){
 const settings=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 const profiles=settings.profiles||[];
 const index=profiles.findIndex(p=>p.id===settings.activeProfileId);
 if(index<0)throw Error('No active configured model profile.');
 const profile={...profiles[index]};
 if(profile.apiKey&&typeof profile.apiKey==='object'){
  const ref=profile.apiKey.$secretRef;
  const envelope=JSON.parse(fs.readFileSync(file+'.vault','utf8'));
  const codec=createPlatformSecretCodec();
  if(envelope.version!==1||envelope.codec!==codec.id||typeof ref!=='string')throw Error('Selected credential envelope mismatch.');
  const bytes=codec.decrypt(Buffer.from(envelope.data,'base64'));
  try {
   const vault=JSON.parse(bytes.toString('utf8'));
   if(!ref.startsWith(vault.id+':'))throw Error('Selected credential reference mismatch.');
   const entry=vault.entries[ref.slice(vault.id.length+1)];
   if(entry?.scope!==`/profiles/${index}/apiKey`||typeof entry.value!=='string')throw Error('Selected credential scope mismatch.');
   profile.apiKey=entry.value;
  } finally {bytes.fill(0);}
 }
 if(typeof profile.apiKey!=='string'||!profile.apiKey)throw Error('Selected profile has no API credential.');
 return {...profile,thinkingLevel:settings.thinkingLevel||'medium'};
}
module.exports={selectedProfile};
