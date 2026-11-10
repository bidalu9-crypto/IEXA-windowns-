'use strict';
// Acceptance host for the packaged standalone server. Model credentials stay
// inside production SecretStore/provider; local API capability never leaves here.
const path=require('node:path'),vm=require('node:vm');
const appRoot=path.resolve(process.argv[2]);
const {startServer,getServerCredentials}=require(path.join(appRoot,'dist/main/server'));
let server,context;
async function main(){
 server=await startServer(0,false,'127.0.0.1');
 const base='http://127.0.0.1:'+server.address().port,auth=getServerCredentials(server);
 const localFetch=(url,options={})=>{const target=new URL(url,base);if(target.origin!==base)throw Error('Acceptance host only requests its own server');const headers=new Headers(options.headers);headers.set('authorization','Bearer '+auth.token);return fetch(target,{...options,headers});};
 const session=await(await localFetch('/api/sessions')).json();
 context=vm.createContext({window:{},fetch:localFetch,AbortController,TextDecoder,setTimeout,clearTimeout,URL,Date,console});
 process.send({ready:true,originalSessionId:session.activeSessionId,host:'packaged standalone server, no Electron renderer'});
}
process.on('message',async message=>{
 try{
  if(message.quit){server?.close();setTimeout(()=>process.exit(0),250).unref();return;}
  const value=await vm.runInContext(message.expression,context);
  process.send({id:message.id,value});
 }catch(error){process.send({id:message.id,error:error.stack});}
});
main().catch(error=>{process.send({error:error.stack});process.exitCode=1;process.disconnect();});
