const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
const mode=process.argv[2],journal=process.argv[3];
if(!['fail','recover'].includes(mode)||!journal)throw new Error('Usage: desktop-recovery-process.cjs <fail|recover> <journal-root>');
let token=0;const calls=[];
const agent=new DesktopAgent(process.cwd(),false,journal);
agent.executeNative=async args=>{
 calls.push(args.action);let data={};
 if(args.action==='observe')data={session:{handle:10,foreground:true,observationToken:`process-${++token}`},elements:[{id:'save',role:'button',text:'Save',enabled:true,selector:{automationId:'saveButton'}}],frame:{hash:`frame-${token}`,trust:'foreground'}};
 if(args.action==='session_state')data={handle:10,foreground:true,observationToken:`process-${token}`,geometryChanged:false};
 if(mode==='fail'&&args.action==='click_element')return {success:false,output:'Injected worker loss after dispatch intent.'};
 return {success:true,output:JSON.stringify({ok:true,action:args.action,data})};
};
(async()=>{
 const owner='persistent-os-process-session';
 if(mode==='fail'){
  await agent.execute({action:'observe'},undefined,{owner});
  const result=await agent.execute({action:'click',target:{automationId:'saveButton'}},undefined,{owner});
  if(result.success||result.metadata?.desktop?.dispatchedActions!==1)throw new Error('Expected one uncertain failed dispatch.');
  console.log(JSON.stringify({mode,success:false,dispatched:result.metadata.desktop.dispatchedActions,calls}));
 }else{
  const result=await agent.execute({action:'observe'},undefined,{owner});
  if(!result.success||!result.output.includes('恢复警告：1 项历史操作可能已执行但结果未确认'))throw new Error('Recovery warning not surfaced after OS process restart.');
  if(calls.includes('click_element'))throw new Error('Old input was replayed during recovery.');
  console.log(JSON.stringify({mode,success:true,warning:result.output.includes('不要重复提交'),calls,output:result.output}));
 }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(()=>agent.close());
