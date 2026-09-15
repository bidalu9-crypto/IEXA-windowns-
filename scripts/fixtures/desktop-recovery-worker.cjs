// Owned subprocess used solely to test an abrupt controller crash, not a native helper.
const {DesktopAgent}=require('../../dist/main/tools/DesktopAgent');
const [root,journal,endpoint,targetId,reference]=process.argv.slice(2);
const agent=new DesktopAgent(root,false,journal);
const context={owner:'crash-recovery-owner'};
const base={backend:'chromium-cdp',cdpEndpoint:endpoint,cdpTargetId:targetId,background:true,detail:'raw'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function run(args,operationId){
 const r=await agent.execute({...base,...args},undefined,{...context,operationId});
 process.send?.({type:'result',action:args.action,success:r.success,metadata:r.metadata,output:r.output});
 if(!r.success)throw Error(r.output);
 return JSON.parse(r.output).data;
}
async function main(){
 for(let attempt=0;;attempt++){
  try{await run({action:'observe'},'crash-initial-observe');break;}
  catch(e){if(attempt>=2||!/page changed during capture/.test(e.message))throw e;await wait(100);}
 }
 await run({action:'type',target:{name:'Reference',role:'edit'},text:reference},'crash-fill');
 await run({action:'click',target:{name:'Send',role:'button'}},'crash-submit');
 throw Error('Parent did not terminate controller during the in-flight action');
}
main().catch(e=>{process.send?.({type:'error',message:e.stack});process.exitCode=1;}).finally(()=>{agent.close();process.disconnect?.();});
