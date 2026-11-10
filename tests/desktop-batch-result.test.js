const {test}=require('node:test'),assert=require('node:assert/strict');
const {formatDesktopResult}=require('../dist/main/tools/DesktopAgent');
test('managed batch preserves receipts for completed inputs without claiming business verification',()=>{
 const output=formatDesktopResult({ok:true,action:'batch',data:{results:[{ok:true,action:'type',data:{characters:11,method:'unicode',foregroundVerified:true}},{ok:true,action:'key',data:{key:'ENTER'}}]}});
 assert.match(output,/1\. type:.*"characters":11/);assert.match(output,/2\. key:.*"key":"ENTER"/);assert.doesNotMatch(output,/undefined/);assert.match(output,/业务成功需核对/);
});
test('legacy native wrapper retains its receipt and does not serialize undefined',()=>{
 const output=formatDesktopResult({ok:true,action:'batch',data:{results:[{action:'click',result:{method:'invoke',effectObserved:false}},{action:'type',result:null}]}});
 assert.match(output,/"effectObserved":false/);assert.doesNotMatch(output,/undefined/);
});
