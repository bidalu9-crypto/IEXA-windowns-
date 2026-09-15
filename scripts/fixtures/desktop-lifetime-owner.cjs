const {spawn}=require('node:child_process');
const {trackDesktopHelper,closeDesktopHelpers}=require('../../dist/main/tools/desktop/DesktopHelperLifetime');
const [exe,port,idle]=process.argv.slice(2);
const child=spawn(exe,[],{windowsHide:true,stdio:['pipe','ignore','ignore'],env:{...process.env,IEXA_DESKTOP_PORT:port,IEXA_DESKTOP_OWNER_PIPE:'stdin-v1',...(idle?{IEXA_DESKTOP_IDLE_MS:idle}:{})}});
trackDesktopHelper(child);
child.once('spawn',()=>process.send({pid:child.pid}));
child.once('error',e=>{process.send({error:e.message});process.exit(1);});
process.on('message',message=>{if(message==='close')closeDesktopHelpers();if(message==='exit')process.exit(0);});
