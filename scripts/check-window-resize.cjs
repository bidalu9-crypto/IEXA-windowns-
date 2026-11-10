/* Exercise production Electron window resizing through its actual preload IPC. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow, screen, dialog } = require('electron');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-window-resize-'));
const output = process.env.IEXA_RESIZE_ARTIFACT_DIR || path.join(root, '.iexa-artifacts/ide-workbench-20261108/window-resize');
fs.mkdirSync(output, { recursive: true });
process.env.IEXA_WORKSPACE = scratch;
process.env.IEXA_HEADLESS = '1';
const checks = [];
let win, finished = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, label) { const deadline = Date.now() + 18000; while (Date.now() < deadline) { try { if (await fn()) return; } catch {} await pause(60); } throw Error('Timeout: ' + label); }
const save = result => fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ checks, ...result }, null, 2));
require('../electron-entry.js');
app.whenReady().then(async () => {
  await wait(() => BrowserWindow.getAllWindows().some(item => !item.isDestroyed() && item.getTitle() === 'IEXA-WIN'), 'production main window');
  win = BrowserWindow.getAllWindows().find(item => item.getTitle() === 'IEXA-WIN');
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  await wait(() => evaluate("!!window.iexaDesktop?.initialWindowState?.custom && document.querySelectorAll('.window-resize-handle').length===8"), 'eight renderer resize handles');
  const base = { x: 120, y: 100, width: 1200, height: 820 };
  win.setBounds(base); await pause(120);
  const originalCursor = screen.getCursorScreenPoint; let cursor = { x: 500, y: 400 };
  screen.getCursorScreenPoint = () => ({ ...cursor });
  try {
    const geometry = await evaluate("[...document.querySelectorAll('.window-resize-handle')].map(el=>{const r=el.getBoundingClientRect();return {edge:el.dataset.edge,width:r.width,height:r.height,cursor:getComputedStyle(el).cursor,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.dataset.edge}})");
    assert.equal(geometry.length, 8);
    for (const item of geometry) { assert.ok(item.width >= 5 && item.height >= 5, item.edge); assert.equal(item.hit, item.edge); assert.equal(item.cursor, item.edge + '-resize'); }
    checks.push({ name: 'all eight edges and corners are visible and hit their own drag handles', geometry });
    for (const edge of ['e', 'w', 'n', 's', 'ne', 'nw', 'se', 'sw']) {
      win.setBounds(base); cursor = { x: 500, y: 400 };
      await evaluate(`iexaDesktop.windowResize({phase:'start',edge:${JSON.stringify(edge)}})`);
      cursor = { x: 500 + (edge.includes('w') ? -90 : 90), y: 400 + (edge.includes('n') ? -70 : 70) };
      await evaluate("iexaDesktop.windowResize({phase:'update'})");
      await evaluate("iexaDesktop.windowResize({phase:'end'})");
      const actual = win.getBounds(); const expected = { ...base };
      if (/[ew]/.test(edge)) expected.width += 90;
      if (/[ns]/.test(edge)) expected.height += 70;
      if (edge.includes('w')) expected.x -= 90;
      if (edge.includes('n')) expected.y -= 70;
      assert.deepEqual(actual, expected, edge);
      checks.push({ name: 'real BrowserWindow resized from ' + edge, before: base, after: actual });
    }
    win.setBounds(base); cursor = { x: 500, y: 400 };
    await evaluate("iexaDesktop.windowResize({phase:'start',edge:'nw'})"); cursor = { x: 10500, y: 10400 };
    await evaluate("iexaDesktop.windowResize({phase:'update'})"); await evaluate("iexaDesktop.windowResize({phase:'end'})");
    assert.deepEqual(win.getBounds(), { x: base.x + base.width - 800, y: base.y + base.height - 600, width: 800, height: 600 });
    checks.push({ name: 'minimum 800 by 600 clamps both axes while keeping opposite edges fixed', bounds: win.getBounds() });
    win.setBounds(base); win.maximize(); await wait(() => win.isMaximized(), 'maximize');
    await evaluate("iexaDesktop.windowResize({phase:'start',edge:'e'})"); const maximized = win.getBounds(); cursor.x += 300;
    await evaluate("iexaDesktop.windowResize({phase:'update'})"); assert.deepEqual(win.getBounds(), maximized);
    win.unmaximize(); await wait(() => !win.isMaximized(), 'restore'); await pause(250);
    checks.push({ name: 'maximized windows ignore manual edge resize' });

    // Exercise the production close handler with a dirty IDE buffer and cancel.
    await evaluate("window.__resizeSavedIDE=window.IexaIDE; window.IexaIDE={...window.IexaIDE,hasUnsavedChanges:()=>true,allowClose:()=>{throw Error('must not allow a cancelled close')}};true");
    let prompts = 0; const originalDialog = dialog.showMessageBox;
    dialog.showMessageBox = async () => { prompts++; return { response: 2 }; };
    win.close(); await wait(() => prompts === 1, 'cancel dirty close prompt'); await pause(120);
    assert.equal(win.isDestroyed(), false);
    assert.equal(await evaluate("fetch('/api/health').then(r=>r.status)"), 200);
    win.setBounds(base); cursor = { x: 500, y: 400 }; await evaluate("iexaDesktop.windowResize({phase:'start',edge:'e'})"); cursor.x += 60;
    await evaluate("iexaDesktop.windowResize({phase:'update'})"); await evaluate("iexaDesktop.windowResize({phase:'end'})"); assert.equal(win.getBounds().width, base.width + 60);
    await evaluate('window.IexaIDE=window.__resizeSavedIDE;true'); dialog.showMessageBox = originalDialog;
    checks.push({ name: 'cancelling a dirty window close preserves backend and all resize IPC', bounds: win.getBounds() });
  } finally { screen.getCursorScreenPoint = originalCursor; }
  save({ completed: true, platform: process.platform, electron: process.versions.electron, input: 'controlled system cursor coordinates; actual production preload IPC and real BrowserWindow bounds' });
  finished = true; console.log('PASS window resize ' + checks.length + ' checks');
  app.quit();
}).catch(error => { save({ completed: false, error: error.stack || String(error) }); console.error(error); app.exit(1); });
process.on('exit', () => { if (!finished) console.error('Resize acceptance ended before completion'); });
