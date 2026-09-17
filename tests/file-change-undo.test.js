const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FileTools}=require('../dist/main/tools/ToolExecutors');
const {undoFileChanges,undoUnavailable,groupFileChanges}=require('../dist/main/session/FileChangeUndo');
const {diff}=require('../src/renderer/services/FileChangeSummary');
function fixture(t){const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'iexa-undo-')));t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));assert.ok(path.basename(root).startsWith('iexa-undo-'));fs.rmSync(root,{recursive:true,force:true});});return root;}
async function write(tools,root,name,text){const result=await tools.writeFile(name,text,root);assert.equal(result.success,true,result.output);return result.fileChange;}
test('diff excludes unchanged middle lines and empty-file phantom lines',()=>{
 assert.equal(diff('','').added,0);assert.equal(diff('','one\n').added,1);
 const d=diff('a\nkeep\nb\n','A\nkeep\nB\n');assert.equal(d.added,2);assert.equal(d.removed,2);assert.equal(d.ops.filter(x=>x.type==='context').length,1);
});
test('repeated edits group first-before to last-after, undo restores byte-exact original',async t=>{
 const root=fixture(t),tools=new FileTools();const original=Buffer.from([0xef,0xbb,0xbf,65,13,10,0xff]);fs.writeFileSync(path.join(root,'a.txt'),original);
 const a=await write(tools,root,'a.txt','middle\n');const b=await write(tools,root,'a.txt','final\n');
 assert.equal(groupFileChanges([a,b]).length,1);assert.equal(groupFileChanges([a,b])[0].before,a.before);assert.equal(groupFileChanges([a,b])[0].after,b.after);
 await undoFileChanges(JSON.parse(JSON.stringify([a,b])),[root]);assert.deepEqual(fs.readFileSync(path.join(root,'a.txt')),original);
});
test('new files are removed, existing empty files remain, idempotent progress is honored',async t=>{
 const root=fixture(t),tools=new FileTools();fs.writeFileSync(path.join(root,'empty.txt'),'');
 const changes=[await write(tools,root,'new.txt','new'),await write(tools,root,'empty.txt','content')],restored=[];
 await undoFileChanges(changes,[root],[],async p=>restored.push(p));assert.equal(fs.existsSync(path.join(root,'new.txt')),false);assert.equal(fs.readFileSync(path.join(root,'empty.txt'),'utf8'),'');
 assert.deepEqual(await undoFileChanges(changes,[root],restored),[]);
});
test('whole-turn preflight rejects later edits without touching earlier files',async t=>{
 const root=fixture(t),tools=new FileTools();const a=await write(tools,root,'a.txt','A'),b=await write(tools,root,'b.txt','B');fs.writeFileSync(path.join(root,'b.txt'),'USER EDIT');
 await assert.rejects(undoFileChanges([a,b],[root]),/后续修改/);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'A');assert.equal(fs.readFileSync(path.join(root,'b.txt'),'utf8'),'USER EDIT');
});
test('interleaved external edits, legacy records, large snapshots and changed scope fail closed',async t=>{
 const root=fixture(t),tools=new FileTools();const a=await write(tools,root,'a.txt','A');fs.writeFileSync(path.join(root,'a.txt'),'external');const b=await write(tools,root,'a.txt','B');
 assert.match(undoUnavailable([a,b]),/其他写入/);await assert.rejects(undoFileChanges([a,b],[root]));
 const legacy={...b};delete legacy.rollback;assert.match(undoUnavailable([legacy]),/旧记录/);
 const big=await write(tools,root,'large.txt','z'.repeat(600000));assert.equal(big.previewTruncated,true);assert.equal(big.rollback,undefined);assert.match(undoUnavailable([big]),/512/);
 const other=path.join(root,'other');fs.mkdirSync(other);await assert.rejects(undoFileChanges([b],[other]));assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'B');
});
test('independent conversations serialize read-modify-write on the same file',async t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'a.txt'),'base\n');
 const results=await Promise.all(Array.from({length:12},(_,i)=>new FileTools().writeFile('a.txt',`${i}\n`,root,{append:true})));
 assert.equal(results.every(r=>r.success),true);const content=fs.readFileSync(path.join(root,'a.txt'),'utf8');assert.equal(content.trim().split('\n').length,13);
 await undoFileChanges(results.map(r=>r.fileChange),[root]);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'base\n');
});
test('truncated preview is never used as rollback content',async t=>{
 const root=fixture(t),tools=new FileTools(),original='original\r\n'.repeat(15000);fs.writeFileSync(path.join(root,'a.txt'),original);
 const change=await write(tools,root,'a.txt','changed\n');assert.equal(change.previewTruncated,true);assert.ok(change.rollback);await undoFileChanges([change],[root]);assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),original);
});
test('replaced directory junction cannot redirect undo into a different file',async t=>{
 const root=fixture(t),tools=new FileTools();fs.mkdirSync(path.join(root,'dir'));fs.mkdirSync(path.join(root,'other'));fs.writeFileSync(path.join(root,'other','a.txt'),'A');
 const change=await write(tools,root,'dir/a.txt','A');fs.renameSync(path.join(root,'dir'),path.join(root,'original'));fs.symlinkSync(path.join(root,'other'),path.join(root,'dir'),'junction');
 await assert.rejects(undoFileChanges([change],[root]),/路径已改变/);assert.equal(fs.readFileSync(path.join(root,'other','a.txt'),'utf8'),'A');
});

test('large multi-hunk diff counts only the four edited lines, preserving the unchanged middle',()=>{
 const before=Array.from({length:5000},(_,i)=>`line-${i}`);const after=[...before];after[0]='changed-first';after[2000]='changed-middle';after[4999]='changed-last';after.splice(3000,0,'inserted');
 const d=diff(before.join('\n'),after.join('\n'));assert.equal(d.exact,true);assert.equal(d.added,4);assert.equal(d.removed,3);
 assert.deepEqual(d.ops.filter(op=>op.type!=='added').map(op=>op.text),before);assert.deepEqual(d.ops.filter(op=>op.type!=='removed').map(op=>op.text),after);
});
