'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DesktopControlSession}=require('../dist/main/tools/desktop/DesktopControlSession');
const {DesktopControlScheduler}=require('../dist/main/tools/desktop/DesktopControlScheduler');
const {formatDesktopResult}=require('../dist/main/tools/DesktopAgent');

function fixture(afterElements, trust='foreground') {
  let observes=0;
  const calls=[],initial=[{id:'initial-button',role:'button',text:'Open',enabled:true,selector:{automationId:'open'}}];
  const transport=async args=>{
    calls.push(args);let data={};
    if(args.action==='observe') {
      observes++;
      data={session:{handle:10,foreground:true,observationToken:`snapshot-${observes}`},
        foreground:{handle:10,pid:7,title:observes===1?'Initial':'Current folder',process:'fixture'},
        frame:{hash:`frame-${observes}`,trust},elements:observes===1?initial:afterElements};
    }
    if(args.action==='session_state')data={handle:10,foreground:true,observationToken:`snapshot-${observes}`,geometryChanged:false};
    if(args.action==='list_windows')data={windows:[{handle:10,pid:7,title:'fixture',process:'fixture'}]};
    if(args.action==='click_element')data={method:'uia_select_focus',foregroundVerified:true,effectObserved:true};
    return {success:true,output:JSON.stringify({ok:true,action:args.action,data})};
  };
  const session=new DesktopControlSession(transport,new DesktopControlScheduler());
  return {calls,run:args=>session.execute(args,undefined,{owner:'post-observation'})};
}

test('input returns fresh actionable controls and token without another observation or false verification',async()=>{
  const menu={id:'win32-menu-exact-id',role:'menuitem',text:'Rename',enabled:true,source:'win32-menu',
    selector:{backend:'win32-menu',automationId:'menu-28706',controlType:'MenuItem',name:'Rename',menuCommandId:28706,menuFingerprint:'fixture'},
    bounds:{left:100,top:200,width:80,height:20}};
  const f=fixture([menu]);
  assert.equal((await f.run({action:'observe'})).success,true);
  const clicked=await f.run({action:'click_element',elementId:'initial-button'});
  assert.equal(clicked.success,true,clicked.output);
  const body=JSON.parse(clicked.output),summary=body.data.postObservation;
  assert.equal(summary.observationToken,'snapshot-2');
  assert.equal(summary.frameHash,'frame-2');
  assert.equal(summary.window.title,'Current folder');
  assert.deepEqual(summary.elements.map(e=>e.id),[menu.id]);
  assert.equal(summary.elements[0].selector.automationId,'menu-28706');
  assert.equal(summary.elements[0].source,'win32-menu');
  assert.deepEqual(summary.elements[0].bounds,{...menu.bounds,centerX:140,centerY:210});
  assert.equal(summary.totalElements,1);assert.equal(summary.truncated,false);
  assert.equal(body.data.verified,false);assert.equal(clicked.metadata.desktop.verified,false);
  assert.equal(f.calls.filter(c=>c.action==='observe').length,2,'reuse existing initial and post-input observations');
  assert.equal(f.calls.filter(c=>c.action==='read_focused').length,0);
  const followup=await f.run({action:'click_element',elementId:summary.elements[0].id,observationToken:summary.observationToken});
  assert.equal(followup.success,true,followup.output);
  assert.equal(f.calls.filter(c=>c.action==='click_element')[1].elementId,menu.id);
  const formatted=formatDesktopResult(body);
  assert.match(formatted,/win32-menu-exact-id/);assert.match(formatted,/snapshot-2/);assert.match(formatted,/业务成功需核对/);
});

test('post-input summary prioritizes focused edits and file items, bounds output, and leaves full selectors cached',async()=>{
  const controls=Array.from({length:50},(_,i)=>({id:`button-${i}`,role:'button',text:`Button ${i}`,selector:{automationId:`button-${i}`}}));
  const long='X'.repeat(300),longId='exact-id-'+long;
  controls.push({id:'item',role:'listitem',text:'target folder'},
    {id:'edit',role:'edit',text:'rename text'},
    {id:longId,role:'combobox',text:long,focused:true,selector:{name:long,automationId:'exact-selector-'+long,controlType:'ComboBox'}});
  const f=fixture(controls);await f.run({action:'observe'});
  const result=await f.run({action:'click_element',elementId:'initial-button'});
  assert.equal(result.success,true,result.output);
  const summary=JSON.parse(result.output).data.postObservation;
  assert.equal(summary.totalElements,53);assert.equal(summary.returnedElements,40);assert.equal(summary.elements.length,40);assert.equal(summary.truncated,true);
  assert.deepEqual(summary.elements.slice(0,3).map(e=>e.id),[longId,'edit','item']);
  assert.equal(summary.elements[0].text.length,160);assert.equal(summary.elements[0].textTruncated,true);
  assert.equal(summary.elements[0].selector.name.length,160);assert.equal(summary.elements[0].selector.nameTruncated,true);
  assert.equal(summary.elements[0].selector.automationId,'exact-selector-'+long);
  assert.match(summary.guidance,/observe\/read_focused/);
  assert.equal(controls[52].text,long,'summary does not mutate the actual snapshot');
  const subsequent=await f.run({action:'click',target:{name:long},observationToken:summary.observationToken});
  assert.equal(subsequent.success,true,subsequent.output);
  assert.equal(f.calls.filter(c=>c.action==='click_element')[1].elementId,longId,'target resolution still uses the complete selector');
});

test('post-input summary retains trusted snapshot filtering instead of reintroducing unverified OCR targets',async()=>{
  const f=fixture([{id:'ocr-untrusted',role:'edit',text:'misleading',source:'ocr'},
    {id:'native',role:'edit',text:'actual',source:'uia3',selector:{automationId:'actual'}}],'background-unverified');
  await f.run({action:'observe'});
  const result=await f.run({action:'click_element',elementId:'initial-button'});
  assert.equal(result.success,true,result.output);
  const summary=JSON.parse(result.output).data.postObservation;
  assert.deepEqual(summary.elements.map(e=>e.id),['native']);assert.equal(summary.totalElements,1);
  assert.equal(summary.captureTrust,'background-unverified');
});

function budgetFixture() {
  const calls=[];
  let token=0,removed=false;
  const controls=Array.from({length:160},(_,i)=>({id:`control-${i}`,role:'button',text:`Control ${i}`,selector:{automationId:`control-${i}`}}));
  const transport=async args=>{
    calls.push(args);let data={};
    if(args.action==='observe')data={session:{handle:10,observationToken:`t${++token}`},frame:{trust:'foreground'},
      elements:controls.filter(c=>!removed||c.id!=='control-8').slice(0,args.limit??50)};
    if(args.action==='session_state')data={handle:10,foreground:true,observationToken:`t${token}`};
    if(args.action==='list_windows')data={windows:[{handle:10,pid:7,title:'fixture',process:'fixture'}]};
    if(args.action==='click_element')data={foregroundVerified:true};
    return {success:true,output:JSON.stringify({ok:true,data})};
  };
  const session=new DesktopControlSession(transport,new DesktopControlScheduler());
  return {calls,remove:()=>removed=true,run:(args,owner='a')=>session.execute(args,undefined,{owner})};
}

test('automatic native observations retain bounded owner collection budgets independently of the 40-control summary',async()=>{
  for(const explicitLimit of [80,150,500]){
    const f=budgetFixture();await f.run({action:'observe',limit:explicitLimit});
    const first=await f.run({action:'click',target:{automationId:'control-8'}});
    assert.equal(first.success,true,first.output);
    const expected=Math.max(100,Math.min(200,explicitLimit));
    assert.equal(f.calls.filter(c=>c.action==='observe').at(-1).limit,expected);
    const summary=JSON.parse(first.output).data.postObservation;
    assert.equal(summary.returnedElements,40);assert.equal(summary.totalElements,Math.min(160,expected));
    const second=await f.run({action:'click',target:{automationId:`control-${Math.min(expected,160)-1}`}});
    assert.equal(second.success,true,second.output);
    await f.run({action:'observe'},'other');
    assert.equal(f.calls.filter(c=>c.action==='observe').at(-1).limit,100,'new owner has independent default budget');
  }
});

test('larger observation budgets replace current controls without merging stale controls',async()=>{
  const f=budgetFixture();await f.run({action:'observe',limit:150});f.remove();
  const first=await f.run({action:'click',target:{automationId:'control-9'}});assert.equal(first.success,true,first.output);
  const stale=await f.run({action:'click',target:{automationId:'control-8'}});
  assert.equal(stale.success,false);assert.match(stale.output,/not found/);assert.equal(stale.metadata.desktop.dispatchedActions,0);
  assert.equal(f.calls.filter(c=>c.action==='click_element').length,1);
});
