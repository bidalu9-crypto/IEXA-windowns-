const {test}=require('node:test');
const assert=require('node:assert/strict');
const {formatDesktopResult}=require('../dist/main/tools/DesktopAgent');
test('unverified capture retains bounded diagnostics and never claims observation sent input',()=>{
 const output=formatDesktopResult({ok:true,action:'observe',data:{frame:{trust:'background-unverified',diagnostic:'Target is hidden; no activation attempted.'}}});
 assert.match(output,/Target is hidden/);assert.match(output,/后台画面未验证/);assert.match(output,/没有发送输入/);assert.doesNotMatch(output,/输入已执行/);
});
test('compositor success is evidence of observation, not evidence of business success',()=>{
 const output=formatDesktopResult({ok:true,action:'observe',data:{frame:{trust:'background-compositor'}}});
 assert.match(output,/background-compositor/);assert.match(output,/业务结果需独立核验/);assert.doesNotMatch(output,/后台画面未验证/);
});
test('capture diagnostics do not inflate model output without bound',()=>{
 const output=formatDesktopResult({ok:true,action:'observe',data:{frame:{trust:'background-unverified',diagnostic:'x'.repeat(10000)}}});
 assert.ok(output.length<2000);
});
