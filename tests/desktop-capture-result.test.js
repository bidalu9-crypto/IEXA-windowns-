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

test('compact window discovery retains hidden, shell-cloaked and unknown states instead of implying absence',()=>{
 const windows=[
  {handle:10,title:'Content',process:'application',pid:7,isVisible:true,cloakedMask:2},
  {handle:11,title:'Host',process:'host',pid:8,isVisible:true,cloakedMask:0},
  {handle:12,title:'Hidden',process:'application',pid:7,isVisible:false,cloakedMask:null},
 ];
 const listed=formatDesktopResult({ok:true,action:'list_windows',data:{windows}});
 for(const window of windows){
  const line=listed.split('\n').find(line=>line.includes(`handle=${window.handle} |`));assert.ok(line,'Every existing window remains represented');
  const state=JSON.parse(line.split('windowState=')[1]);assert.equal(state.isVisible,window.isVisible);assert.equal(state.cloakedMask,window.cloakedMask);
 }
 const observed=formatDesktopResult({ok:true,action:'observe',data:{foreground:windows[0],frame:{trust:'background-unverified',diagnostic:'DWM mask=0x2; shell hiding reported; virtual-desktop membership unverified.'}}});
 assert.match(observed,/"cloakedMask":2/);assert.match(observed,/membership unverified/);assert.match(observed,/没有发送输入/);
});
