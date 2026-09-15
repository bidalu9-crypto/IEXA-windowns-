// An exact status seen in a real tool observation is valid verification, as is
// verifyText. Neither the model's final prose nor merely a dispatched click is proof.
function assessModelEvidence(report,expectedText){
 const calls=new Map(report.actions.map(call=>[call.id,call]));
 return report.results.flatMap(result=>{
  if(!result.success)return [];
  const call=calls.get(result.id);if(!call)return [];
  if(result.desktop?.verified===true&&call.args?.verifyText===expectedText)return [{id:result.id,method:'verifyText'}];
  if(call.args?.action!=='observe')return [];
  try{
   const data=JSON.parse(result.output).data;
   if(data?.elements?.some(e=>e.role==='status'&&e.text===expectedText))return [{id:result.id,method:'observed_status'}];
  }catch{}
  if(result.output.split('\n').some(line=>line.includes(` | status | ${expectedText} | `)))return [{id:result.id,method:'observed_status'}];
  return [];
 });
}
module.exports={assessModelEvidence};
