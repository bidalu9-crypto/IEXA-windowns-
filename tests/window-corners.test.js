const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {roundedWindowRects,installWindowCorners}=require('../resources/window-corners.cjs');
function fake(){const win=new EventEmitter();win.size=[1200,800];win.maximized=false;win.fullscreen=false;win.destroyed=false;win.calls=[];win.getSize=()=>win.size;win.isMaximized=()=>win.maximized;win.isFullScreen=()=>win.fullscreen;win.isDestroyed=()=>win.destroyed;win.setShape=shape=>win.calls.push(shape);return win;}
const windows10={platform:'win32',release:'10.0.19045'};
function contains(rects,x,y){return rects.some(r=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height);}
test('12 DIP outer corners clip all four tips, preserving centre and native resize edges',()=>{
 const rects=roundedWindowRects(1200,800);for(const [x,y] of [[0,0],[1199,0],[0,799],[1199,799]])assert.equal(contains(rects,x,y),false);
 for(const [x,y] of [[600,0],[600,799],[0,400],[1199,400],[600,400]])assert.equal(contains(rects,x,y),true);
 assert.equal(contains(rects,0,12),true);assert.equal(contains(rects,12,0),true);
 for(const r of rects){assert.ok(r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x+r.width<=1200&&r.y+r.height<=800);}
});
test('resize tracks bounds; maximize/fullscreen are rectangular, restoring returns to rounded',()=>{
 const win=fake();installWindowCorners(win,windows10);assert.equal(win.calls.length,1);
 win.emit('show');assert.equal(win.calls.length,1);
 win.size=[1000,700];win.emit('resize');assert.equal(Math.max(...win.calls.at(-1).map(r=>r.x+r.width)),1000);
 win.maximized=true;win.emit('maximize');assert.deepEqual(win.calls.at(-1),[]);
 win.maximized=false;win.emit('unmaximize');assert.ok(win.calls.at(-1).length>0);
 win.fullscreen=true;win.emit('enter-full-screen');assert.deepEqual(win.calls.at(-1),[]);
 win.fullscreen=false;win.emit('leave-full-screen');assert.ok(win.calls.at(-1).length>0);
 win.emit('closed');assert.equal(win.listenerCount('resize'),0);const count=win.calls.length;win.emit('show');assert.equal(win.calls.length,count);
});
test('Windows 11, macOS and Linux keep native window decoration untouched',()=>{
 for(const config of [{platform:'win32',release:'10.0.22631'},{platform:'darwin',release:'24.0.0'},{platform:'linux',release:'6.8.0'}]){const win=fake();installWindowCorners(win,config);assert.equal(win.calls.length,0);assert.equal(win.listenerCount('resize'),0);}
});
test('shape failures retain a usable rectangular frame instead of breaking launch',()=>{
 const win=fake(),errors=[];win.setShape=shape=>{if(shape.length)throw Error('fixture driver failure');win.calls.push(shape);};installWindowCorners(win,{...windows10,onError:(...args)=>errors.push(args)});assert.deepEqual(win.calls,[[]]);assert.equal(errors.length,1);
});
test('corner helper ships in both package formats and entry retains native frame',()=>{
 const fs=require('node:fs'),path=require('node:path');const root=path.join(__dirname,'..');const entry=fs.readFileSync(path.join(root,'electron-entry.js'),'utf8');assert.match(entry,/installWindowCorners\(mainWindow,/);assert.match(entry,/require\('\.\/resources\/window-corners\.cjs'\)/);
 const body=entry.slice(entry.indexOf('function createWindow()'),entry.indexOf('// Remove default menu'));assert.doesNotMatch(body,/frame:\s*false|transparent:\s*true/);
 assert.ok(require('../package.json').build.files.includes('resources/**/*'));assert.match(fs.readFileSync(path.join(root,'build-dist.js'),'utf8'),/'resources'/);
});

test('moving across displays refreshes the physical region when DPI changes without resizing',()=>{
 const win=fake();let scale=1;installWindowCorners(win,{...windows10,getScaleFactor:()=>scale});win.emit('move');assert.equal(win.calls.length,1);scale=1.5;win.emit('move');assert.equal(win.calls.length,2);
});
