'use strict';
// Real packaged-controller pointer regression. Run serially; never alongside
// another GUI harness. Helper restart coverage can be added separately.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createSupervisor } = require('./helpers/acceptance-supervisor.cjs');
const root = path.resolve(__dirname, '..');
const workerScript = path.join(__dirname, 'check-desktop-keyboard-regression.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Standard Win32 menus are untitled thread windows. Production list_windows
// intentionally omits untitled windows unless their exact HWND is known.
// Read only: discover this test process's menu through exact GUI-thread owner
// evidence; all observation/capture/input remains in the production controller.
async function discoverOwnedMenu(window, executable) {
  assert.ok(Number.isSafeInteger(window.pid) && window.pid > 0);
  assert.ok(Number.isSafeInteger(window.handle) && window.handle > 0);
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class IexaMenuDiscovery {
  public delegate bool EnumProc(IntPtr h,IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUI { public int size; public uint flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public RECT caretRect; }
  [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread,EnumProc callback,IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder text,int max);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GUI info);
  public static object Read(int pid,long main) {
    using(var process=Process.GetProcessById(pid)) {
      uint mainPid; GetWindowThreadProcessId(new IntPtr(main),out mainPid);
      if(mainPid!=pid) throw new InvalidOperationException("Original HWND/PID no longer matches");
      var result=new List<object>();
      foreach(ProcessThread thread in process.Threads) {
        var info=new GUI { size=Marshal.SizeOf(typeof(GUI)) };
        bool got=GetGUIThreadInfo((uint)thread.Id,ref info);
        long menuOwner=got?info.menuOwner.ToInt64():0;
        EnumThreadWindows((uint)thread.Id,(h,data)=>{
          uint actualPid; uint actualThread=GetWindowThreadProcessId(h,out actualPid);
          var name=new StringBuilder(256); GetClassName(h,name,name.Capacity);
          if(actualPid==pid && actualThread==(uint)thread.Id && IsWindowVisible(h) && name.ToString()=="#32768") {
            long owner=GetWindow(h,4).ToInt64();
            if(owner==main || menuOwner==main) result.Add(new { handle=h.ToInt64(),pid,threadId=thread.Id,className=name.ToString(),ownerHandle=owner,menuOwnerHandle=menuOwner });
          }
          return true;
        },IntPtr.Zero);
      }
      return new { pid, mainHandle=main, executable=process.MainModule.FileName, createdUtc=process.StartTime.ToUniversalTime().ToString("O"), windows=result };
    }
  }
}
'@
[IexaMenuDiscovery]::Read(${window.pid},${window.handle}) | ConvertTo-Json -Depth 6 -Compress`;
  const output = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 12000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const result = JSON.parse(output.replace(/^\uFEFF/, ''));
  assert.equal(path.resolve(result.executable).toLowerCase(), path.resolve(executable).toLowerCase(), 'Discovered menu belongs to exact launched executable');
  assert.equal(result.pid, window.pid); assert.equal(result.mainHandle, window.handle);
  assert.ok(Array.isArray(result.windows), 'Read-only thread enumeration returned menu list');
  return result;
}

function rpc(child) {
  let next = 0, resolveReady, rejectReady;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const dispose = error => {
    rejectReady(error);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.once('error', dispose);
  child.once('exit', code => dispose(Error('Controller exited ' + code)));
  child.on('message', message => {
    if (message.ready) return resolveReady();
    const p = pending.get(message.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(message.id);
    message.error ? p.reject(Error(message.error)) : p.resolve(message);
  });
  return { ready, dispose: () => dispose(Error('RPC disposed')), request(args) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id); if (child.connected) child.send({ cancel: true });
        reject(Error('Desktop action timed out'));
      }, 25000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
  } };
}

async function main() {
  const deferredReview = process.env.IEXA_POINTER_VISUAL_REVIEW === 'deferred';
  const visualReview = deferredReview || process.env.IEXA_POINTER_VISUAL_REVIEW === '1';
  const packageRoot = path.resolve(process.env.IEXA_TEST_PACKAGE || path.join(root, 'release/IEXA-preview-20261109'));
  const appRoot = path.join(packageRoot, 'resources/app');
  const sevenZip = process.env.IEXA_7ZIP_PATH || 'C:\\Program Files\\7-Zip\\7zFM.exe';
  assert.ok(fs.existsSync(sevenZip), '7-Zip File Manager executable exists');
  const out = path.join(root, '.iexa-artifacts/desktop-comparison-20261110', 'regression-pointer-' + Date.now());
  const directory = path.join(out, 'task-files'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'tiny.txt'); fs.writeFileSync(file, 'IEXA pointer fixture\r\n', { flag: 'wx' });
  const report = { status: 'running', startedAt: new Date().toISOString(), packageRoot,
    scope: visualReview ? 'Fixed GUI regression with direct visual oracle; not model autonomous pass' : 'Real semantic right click through packaged DesktopAgent; no model or file edits after fixture creation',
    oracleMode: deferredReview ? 'deferred-root-visual' : visualReview ? 'root-direct-visual-review' : 'automatic-menu-elements',
    fixture: { directory, file, originalSHA256: hash(file) }, actions: [], checks: [], helperRestartTested: false };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); save();
  const supervisor = createSupervisor({ output: out, maximumDurationMs: 360000, allowFixtureCleanup: true,
    observeProcess: row => /^(7zFM|7zG)\.exe$/i.test(row.Name || '') });
  let child, client, run, ownedWindow, menuHandle;
  let menuDismissed = false;
  const awaitReview = async (kind, required) => {
    const frame = report.actions.at(-1).image;
    assert.ok(frame, 'Direct visual review requires a saved production screenshot');
    const imagePath = path.join(out, frame), imageSHA256 = hash(imagePath);
    const reviewFile = path.join(out, 'review-' + kind + '.json');
    if (deferredReview) {
      const evidence = { kind, frame, imagePath, imageSHA256, required, reviewStatus: 'pending' };
      report.pendingVisualEvidence ??= [];
      report.pendingVisualEvidence.push(evidence);
      report.phase = 'running'; save();
      return evidence;
    }
    const startedAt = Date.now(), deadline = startedAt + 120000;
    report.phase = kind === 'context' ? 'awaiting-context-menu-review' : 'awaiting-dismissal-review';
    report.pendingReview = { reviewFile, imagePath, imageSHA256, reviewedBy: 'root', required, deadline }; save();
    console.log(JSON.stringify({ phase: report.phase, out, ...report.pendingReview }));
    while (!fs.existsSync(reviewFile) && Date.now() < deadline) await Promise.race([pause(250), supervisor.failure]);
    assert.ok(fs.existsSync(reviewFile), 'Direct visual review received within 120 seconds');
    const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    assert.equal(review.reviewedBy, 'root', 'Root agent performed direct visual review');
    assert.equal(review.imageSHA256, imageSHA256, 'Review binds exact captured screenshot SHA256');
    assert.equal(hash(imagePath), imageSHA256, 'Captured screenshot unchanged during review');
    for (const field of required) assert.equal(review[field], true, 'Direct visual confirmation: ' + field);
    report.visualReviews ??= [];
    report.visualReviews.push({ kind, imagePath, imageSHA256, reviewFile, review, receivedAt: Date.now() });
    delete report.pendingReview; report.phase = 'running'; save();
    return { frame, imageSHA256, review };
  };
  try {
    await supervisor.begin();
    report.packageManifestSHA256 = hash(path.join(packageRoot, 'build-manifest.json'));
    report.controllerSHA256 = hash(path.join(appRoot, 'dist/main/tools/DesktopAgent.js'));
    const port = await new Promise(resolve => {
      const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
        const port = server.address().port; server.close(() => resolve(port));
      });
    });
    const fd = fs.openSync(path.join(out, 'controller.log'), 'w'), started = Date.now();
    child = spawn(path.join(packageRoot, 'IEXA.exe'), ['--max-old-space-size=384', workerScript, '__worker', appRoot, path.join(out, 'journal'), 'http://127.0.0.1:' + port],
      { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', fd, fd, 'ipc'] });
    fs.closeSync(fd); client = rpc(child);
    await supervisor.claimSpawn(child, workerScript, started);
    let readyTimer;
    try { await Promise.race([client.ready, supervisor.failure, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(Error('Controller readiness timed out')), 15000); })]); }
    finally { clearTimeout(readyTimer); }
    run = async (args, { allowFailure = false, cleanup = false } = {}) => {
      assert.ok(report.actions.length < 45, 'Bounded desktop action count');
      const payload = { backend: 'native', controlMode: 'foreground', focusPolicy: 'stop', ...args, detail: 'raw' };
      const startedAt = Date.now(), work = client.request(payload);
      const response = await (cleanup ? work : Promise.race([work, supervisor.failure]));
      const result = response.result, entry = { args: payload, startedAt, completedAt: Date.now(), ...result };
      if (response.imageBase64) {
        entry.image = 'frame-' + (report.actions.length + 1) + '.png';
        fs.writeFileSync(path.join(out, entry.image), Buffer.from(response.imageBase64, 'base64'));
      }
      report.actions.push(entry); save();
      if (!result.success) { if (allowFailure) return null; throw Error(result.output); }
      return JSON.parse(result.output).data;
    };
    const baseline = await run({ action: 'list_windows', process: '7zFM', includeHidden: true, limit: 100 });
    assert.ok(Array.isArray(baseline.windows));
    assert.equal(baseline.windows.length, 0, 'Existing 7-Zip windows prevent this isolated regression; leave them untouched');
    const launched = await run({ action: 'launch', app: sevenZip, arguments: '"' + directory + '"', waitForWindowMs: 15000 });
    assert.ok(launched.window?.handle && launched.window?.pid, 'Launched app has exact HWND and PID');
    assert.match(launched.window.process || '', /^7zFM(?:\.exe)?$/i);
    ownedWindow = { handle: launched.window.handle, pid: launched.window.pid };
    report.ownedWindow = ownedWindow;
    const observed = await run({ action: 'observe', handle: ownedWindow.handle, limit: 160, captureFrame: true });
    const matches = (observed.elements || []).filter(e => e.role === 'listitem' && (e.selector?.name === 'tiny.txt' || e.text === 'tiny.txt'));
    assert.equal(matches.length, 1, 'Exactly one observed tiny.txt listitem in the new fixture directory');
    report.target = matches[0]; save();
    const previousNonce = report.actions.at(-1).metadata?.nativeInstanceNonce;
    assert.ok(typeof previousNonce === 'string' && previousNonce.length >= 16, 'Stable observation records native helper instance nonce');
    assert.equal(observed.session.foreground, true, 'Fixture window starts in foreground');
    const idleActionCount = report.actions.length, idleStartedAt = Date.now();
    report.idleRecovery = { previousNonce, idleStartedAt, quietDurationMs: 35000, actionCountBeforeIdle: idleActionCount }; save();
    // Deliberately no health, execute, observe or helper transport during idle.
    // The supervisor only samples OS process/resource state independently.
    await pause(35000);
    assert.equal(report.actions.length, idleActionCount, 'No desktop requests during idle interval');
    report.idleRecovery.idleEndedAt = Date.now();
    const selected = await run({ action: 'click_element', target: { name: 'tiny.txt', role: 'listitem' }, count: 1 });
    const recoveredEntry = report.actions.at(-1), recovery = recoveredEntry.metadata?.desktop?.helperRecovery;
    const nextNonce = recoveredEntry.metadata?.nativeInstanceNonce;
    assert.equal(recovery?.refreshedBeforeFirstDispatch, true, 'Production controller refreshed binding before the first new input');
    assert.equal(recovery?.identityVerified, true, 'Original window identity independently verified after restart');
    assert.equal(recovery?.inputReplayed, false, 'Restart recovery did not replay prior input');
    assert.ok(typeof nextNonce === 'string' && nextNonce.length >= 16 && nextNonce !== previousNonce, 'Helper actually restarted with a new nonce');
    assert.equal(recoveredEntry.metadata.desktop.dispatchedActions, 1, 'Exactly one fresh semantic input dispatched');
    assert.equal(recoveredEntry.metadata.desktop.acknowledgedActions, 1, 'Exactly one new input acknowledged');
    assert.equal(selected.foregroundVerified, true, 'The recovered click retained foreground');
    assert.equal(selected.postObservation?.handle, ownedWindow.handle, 'Same exact file manager HWND after helper restart');
    assert.equal(selected.postObservation?.window?.pid, ownedWindow.pid, 'Same exact file manager PID after helper restart');
    assert.equal(hash(file), report.fixture.originalSHA256, 'Idle recovery and single selection leave file unchanged');
    report.idleRecovery = { ...report.idleRecovery, nextNonce, recovery, inputActionIndex: report.actions.length };
    report.helperRestartTested = true;
    report.checks.push({ name: '35-second transport silence causes new helper nonce; fresh semantic click recovers before first dispatch with no input replay', passed: true }); save();
    // One dispatch only: a post-action focus transition must never cause replay.
    const clicked = await run({ action: 'click_element', target: { name: 'tiny.txt', role: 'listitem' }, button: 'right', count: 1 }, { allowFailure: true });
    report.rightClickReceipt = clicked;
    let current = await run({ action: 'observe', handle: ownedWindow.handle, limit: 200, includeOcr: true, captureFrame: true });
    const text = e => String(e.selector?.name || e.text || '').replace(/[&\u200b]/g, '').trim();
    if (visualReview) {
      report.contextMenu = { observedHandle: current.session.handle, ...(await awaitReview('context', ['copyVisible', 'propertiesVisible'])) };
    } else {
    const actual = current.session?.actualForeground;
    let popup = (current.relatedWindows || []).find(w => w.handle !== ownedWindow.handle && Number(w.pid) === ownedWindow.pid
      && Number(w.ownerHandle) === ownedWindow.handle && (w.handle === actual?.handle || w.className === '#32768'))
      || (actual?.handle !== ownedWindow.handle && Number(actual?.pid) === ownedWindow.pid && actual?.className === '#32768' ? actual : null);
    if (!popup) {
      const listed = await run({ action: 'list_windows', pid: ownedWindow.pid, includeHidden: false, limit: 100 });
      assert.ok(Array.isArray(listed.windows));
      const menus = listed.windows.filter(w => w.className === '#32768' && w.pid === ownedWindow.pid && w.ownerHandle === ownedWindow.handle);
      assert.ok(menus.length <= 1, 'Native menu discovery is unambiguous'); popup = menus[0];
    }
    if (!popup) {
      const discovery = await Promise.race([discoverOwnedMenu(ownedWindow, sevenZip), supervisor.failure]);
      report.readOnlyMenuDiscovery = discovery; save();
      assert.equal(discovery.windows.length, 1, 'Exactly one visible menu belongs to the new file manager GUI thread and owner');
      popup = discovery.windows[0];
      const exact = await run({ action: 'list_windows', handle: popup.handle, includeHidden: false, limit: 1 });
      assert.ok(Array.isArray(exact.windows) && exact.windows.length === 1);
      assert.equal(exact.windows[0].handle, popup.handle); assert.equal(exact.windows[0].pid, ownedWindow.pid);
      assert.equal(exact.windows[0].className, '#32768', 'Production controller independently confirms exact menu HWND');
    }
    if (popup) {
      menuHandle = popup.handle; report.menuWindow = popup;
      current = await run({ action: 'observe', handle: menuHandle, limit: 200, includeOcr: true, captureFrame: true });
    }
    const menuItems = (current.elements || []).filter(e => e.role === 'menuitem' || menuHandle && String(e.source).toLowerCase().includes('ocr'));
    const copy = menuItems.find(e => /^(复制(?:到)?|Copy(?: to)?)(?:\s|\(|\.|…|$)/i.test(text(e)));
    const properties = menuItems.find(e => /^(属性|Properties)(?:\s|\(|\.|…|$)/i.test(text(e)));
    assert.ok(copy && properties, 'Actual context menu exposes both Copy and Properties; toolbar text is not proof');
    report.contextMenu = { copy, properties, observedHandle: current.session.handle, frame: report.actions.at(-1).image };
    assert.ok(report.contextMenu.frame, 'Context-menu screenshot was saved');
    }
    // Win32 menus can retain the owner as the foreground HWND. Explicitly
    // observe that owned HWND before ESC; never activate or click the menu.
    if (visualReview || current.session?.foreground !== true) {
      current = await run({ action: 'observe', handle: ownedWindow.handle, limit: 160, captureFrame: true });
      assert.equal(current.session.foreground, true, 'Menu owner is still foreground before ESC');
    }
    await run({ action: 'key', key: 'ESC' }, { allowFailure: true });
    current = await run({ action: 'observe', handle: ownedWindow.handle, limit: 160, captureFrame: true });
    assert.equal(current.session.handle, ownedWindow.handle);
    assert.equal(current.session.foreground, true, 'ESC returns to owned file manager');
    if (visualReview) report.dismissal = await awaitReview('dismissal', ['menuAbsent']);
    else assert.ok(!(current.elements || []).some(e => e.role === 'menuitem' && /^(属性|Properties)/i.test(text(e))), 'Context menu dismissed');
    if (!visualReview && menuHandle) {
      const menu = await run({ action: 'list_windows', handle: menuHandle, includeHidden: false, limit: 1 });
      assert.ok(Array.isArray(menu.windows) && menu.windows.length === 0, 'Menu HWND disappeared or became hidden after ESC');
    }
    // Deferred mode records a screenshot for later review; it does not claim
    // menu dismissal from the screenshot before the root has viewed it.
    menuDismissed = !deferredReview;
    assert.equal(hash(file), report.fixture.originalSHA256, 'Right click and ESC leave fixture unchanged');
    assert.deepEqual(fs.readdirSync(directory), ['tiny.txt'], 'No other file created by the GUI operation');
    if (visualReview) {
      await run({ action: 'observe', handle: ownedWindow.handle, limit: 160, captureFrame: true });
      // The review can span helper idle retirement. This read grants a fresh
      // capability for closing, without altering the verified dismissal image.
    }
    const closed = await run({ action: 'hotkey', keys: ['ALT', 'F4'], allowClose: true, expectWindowClosed: true });
    assert.equal(closed.windowClosed, true, 'Production close oracle confirms exact owned HWND');
    const absent = await run({ action: 'list_windows', handle: ownedWindow.handle, includeHidden: true, limit: 1 });
    assert.ok(Array.isArray(absent.windows) && absent.windows.length === 0, 'Owned window absent including hidden windows');
    report.checks.push({ name: deferredReview
      ? 'Right click and ESC dispatched; original foreground retained; file unchanged; exact owned app HWND closed'
      : 'Semantic right click opens real Copy/Properties menu; ESC dismisses only menu; file unchanged; owned app closed', passed: true });
    report.guiClosed = true;
    report.hardChecksPassed = true;
    report.status = deferredReview ? 'pending-visual-review' : 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; }
  finally {
    // No guessed foreground cleanup. Close only a verified original HWND/PID;
    // if its menu was not proven dismissed, supervisor handles owned descendants.
    if (run && ownedWindow && !report.guiClosed && menuDismissed) try {
      const exact = await run({ action: 'list_windows', handle: ownedWindow.handle, includeHidden: true, limit: 1 }, { cleanup: true });
      if (exact.windows?.length === 1 && exact.windows[0].handle === ownedWindow.handle && exact.windows[0].pid === ownedWindow.pid) {
        await run({ action: 'observe', handle: ownedWindow.handle }, { cleanup: true });
        await run({ action: 'hotkey', keys: ['ALT', 'F4'], allowClose: true, expectWindowClosed: true }, { allowFailure: true, cleanup: true });
      }
    } catch (error) { report.failureCleanupError = error.message; }
    report.fixture.finalSHA256 = hash(file);
    if (report.fixture.finalSHA256 !== report.fixture.originalSHA256) { report.status = 'failed'; report.fixtureChanged = true; }
    if (child?.connected) child.send({ quit: true });
    if (child) {
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) await pause(100);
      if (child.exitCode === null) { report.status = 'failed'; report.controllerCloseError = 'Controller did not exit'; }
    }
    client?.dispose();
    try {
      report.resources = await supervisor.finish();
      assert.deepEqual(report.resources.survivorsAfterCleanup, []);
      assert.deepEqual(report.resources.newObservedSurvivors, []);
      // Forced cleanup never upgrades a failed GUI close to passed.
      if (['passed', 'pending-visual-review'].includes(report.status)) assert.deepEqual(report.resources.survivorsBeforeCleanup, [], 'No owned process required forced cleanup');
    } catch (error) { report.status = 'failed'; report.resourceError = error.message; }
    report.completedAt = new Date().toISOString(); report.phase = 'finished'; save();
    if (deferredReview) {
      report.hardChecksPassed = report.status === 'pending-visual-review';
      report.supplementalReviewRequired = {
        reportMustRemainUnmodified: true, reviewedBy: 'root',
        evidence: report.pendingVisualEvidence || [],
        passCondition: 'Separate supplemental report may pass only when source report status is pending-visual-review, hardChecksPassed is true, context screenshot shows Copy and Properties, dismissal screenshot shows menu absent, and both exact image hashes and source report hash are bound to the root visual review.'
      };
      save();
    }
    console.log(JSON.stringify({ status: report.status, out, reportSHA256: hash(path.join(out, 'report.json')), pendingVisualEvidence: report.pendingVisualEvidence, error: report.error, resourceError: report.resourceError }));
    // 2 denotes completed hard checks awaiting independent visual evidence.
    process.exitCode = report.status === 'passed' ? 0 : report.status === 'pending-visual-review' ? 2 : 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
