const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const fs=require('node:fs');
const {DesktopAgent}=require('../dist/main/tools/DesktopAgent');
const lifetime=require('../dist/main/tools/desktop/DesktopHelperLifetime');
test('constructing an agent is lazy; no desktop process starts',()=>{
 const agent=new DesktopAgent(process.cwd());assert.equal(agent.healthyUntil,0);agent.close();
});
test('concurrent native startup for the same endpoint is shared across agents',async()=>{
 const a=new DesktopAgent(process.cwd()),b=new DesktopAgent(process.cwd());let count=0,release;
 const ready=new Promise(r=>release=r);
 for(const agent of [a,b]){agent.healthy=async()=>false;agent.start=async()=>{count++;await ready;};}
 const tasks=[a.ensureStarted(),b.ensureStarted()];await new Promise(r=>setImmediate(r));assert.equal(count,1);release();await Promise.all(tasks);a.close();b.close();
});
test('Electron before-quit releases helper ownership independently of HTTP close',()=>{
 const source=fs.readFileSync('electron-entry.js','utf8');
 const handler=source.slice(source.indexOf("app.on('before-quit'"));
 assert.ok(handler.indexOf('closeDesktopHelpers()')<handler.indexOf('server.close()'));
});
test('owner shutdown closes only held pipes, is idempotent, rejects new starts and covers startup races',()=>{
 const make=()=>{const c=new EventEmitter();c.stdin=new PassThrough();c.unref=()=>{};c.kill=()=>{throw Error('must not kill by PID');};return c;};
 const c=make();lifetime.trackDesktopHelper(c);assert.equal(c.stdin.destroyed,false);
 lifetime.closeDesktopHelpers();lifetime.closeDesktopHelpers();assert.equal(c.stdin.destroyed,true);
 assert.throws(()=>lifetime.assertDesktopHelpersOpen(),/closing/);
 const late=make();lifetime.trackDesktopHelper(late);assert.equal(late.stdin.destroyed,true);
});
