'use strict';

// Actual main-window controls, OS geometry and reversible layout interaction.
// All changes use production DesktopAgent actions. DOM/native reads are oracles;
// no BrowserWindow methods, synthetic system cursor or direct IPC is evaluated.
const assert = require('node:assert/strict');

async function runWindow(h) {
  const q = JSON.stringify, handle = Number(h.report.window.handle), pid = h.report.application.pid;
  const read = expression => h.read(expression);
  const click = selector => h.clickSelector(selector);
  const visible = selector => read(`(()=>{const e=document.querySelector(${q(selector)});if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'})()`);
  const shown = selector => h.until(() => visible(selector), 'Actual window/layout control visible: ' + selector, 10000);
  const expanded = () => read("document.documentElement.dataset.windowExpanded");
  const geometry = async () => {
    const windows = (await h.nativeRun({ action: 'list_windows', backend: 'native', includeHidden: true, limit: 100 })).windows;
    const own = windows.filter(window => Number(window.handle) === handle);
    assert.equal(own.length, 1, 'Exact main HWND remains in owned application tree');
    assert.equal(Number(own[0].pid), pid, 'Exact main HWND still belongs to original application PID');
    return own[0];
  };
  const sameBounds = (a, b) => ['left', 'top', 'width', 'height'].every(key => a[key] === b[key]);
  const waitBounds = (expected, label) => h.until(async () => { const actual = await geometry(); return sameBounds(actual.bounds, expected) && actual; }, label, 10000);
  async function activate() {
    const actual = await h.nativeRun({ action: 'activate', backend: 'native', controlMode: 'foreground', focusPolicy: 'stop', handle, pid });
    assert.equal(actual.verified, true); assert.equal(Number(actual.session.handle), handle); assert.equal(actual.session.foreground, true);
    await h.until(() => read("document.visibilityState==='visible'&&document.hasFocus()"), 'Restored main renderer is visible and focused', 10000);
    return actual;
  }
  async function nativeObservation() {
    await activate();
    const seen = await h.nativeRun({ action: 'observe', backend: 'native', controlMode: 'foreground', focusPolicy: 'stop', handle, pid, includeElements: true, limit: 100 });
    assert.equal(Number(seen.session.handle), handle); assert.equal(seen.session.foreground, true);
    return seen;
  }
  function independentIssue(action, error, evidence) {
    h.report.knownToolIssues ||= [];
    h.report.knownToolIssues.push({ action, issue: error.message, independentlyVerified: evidence }); h.save();
  }
  async function actualClick(selector, verify, label) {
    let error;
    try { await click(selector); }
    catch (failure) { if (!failure.desktopResult?.metadata?.desktop?.dispatchedActions) throw failure; error = failure; }
    const receipt = await h.until(verify, label, 10000);
    if (error) independentIssue('window-control-' + selector, error, label + '; input was not replayed');
    return receipt;
  }
  async function setExpanded(value) {
    if ((await expanded()) !== String(value)) {
      await actualClick('#windowMaximize', async () => (await expanded()) === String(value), 'Actual window expanded state becomes ' + value);
    }
  }

  await h.check('Window / actual Maximize and Restore update OS bounds and chrome state', async () => {
    await shown('#windowMaximize'); await activate();
    const original = await geometry(), initialExpanded = await expanded();
    assert.ok(['true', 'false'].includes(initialExpanded));
    try {
      await setExpanded(false); const normal = await geometry();
      const labels = { normal: await read("document.querySelector('#windowMaximize').getAttribute('aria-label')") };
      await actualClick('#windowMaximize', async () => {
        const state = await expanded(), actual = await geometry();
        return state === 'true' && actual.bounds.width >= normal.bounds.width && actual.bounds.height >= normal.bounds.height
          && !sameBounds(actual.bounds, normal.bounds) && actual;
      }, 'Maximize changes actual main native bounds and dataset.windowExpanded');
      const maximized = await geometry(); labels.maximized = await read("document.querySelector('#windowMaximize').getAttribute('aria-label')");
      assert.notEqual(labels.maximized, labels.normal, 'Maximize control changes to actual restore label');
      await h.screenshot('window-actually-maximized');
      await actualClick('#windowMaximize', async () => (await expanded()) === 'false' && sameBounds((await geometry()).bounds, normal.bounds), 'Restore returns exact actual main native bounds');
      assert.equal(await read("document.querySelector('#windowMaximize').getAttribute('aria-label')"), labels.normal);
      await h.screenshot('window-actually-restored');
      return { handle, initialExpanded, normal: normal.bounds, maximized: maximized.bounds, restored: (await geometry()).bounds, labels, oracle: 'Real OS window list plus renderer dataset and displayed chrome labels' };
    } finally {
      await activate(); await setExpanded(initialExpanded === 'true');
      await waitBounds(original.bounds, 'Original native main geometry restored after maximize scenario');
    }
  });

  await h.check('Window / actual Minimize hides main surface and explicit native activation restores it', async () => {
    await shown('#windowMinimize'); await activate();
    const before = await geometry(), initialExpanded = await expanded(), requests = h.report.providerRequests.length;
    try {
      const minimized = await actualClick('#windowMinimize', async () => {
        const dom = await read("({visibility:document.visibilityState,focused:document.hasFocus(),expanded:document.documentElement.dataset.windowExpanded})");
        if (dom.visibility !== 'hidden' || dom.focused) return false;
        const native = await geometry(), session = await h.nativeRun({ action: 'session_state' });
        return !session.foreground && { dom, native, session };
      }, 'Actual minimized document is hidden/unfocused and native owner is no longer foreground');
      assert.equal(Number(minimized.native.handle), handle, 'Minimize preserves the main window');
      assert.equal(h.report.providerRequests.length, requests);
      const activated = await activate(); await setExpanded(initialExpanded === 'true');
      const restored = await waitBounds(before.bounds, 'Explicit native activate restores original main native bounds');
      assert.equal(await read('document.visibilityState'), 'visible');
      assert.equal(await read('document.hasFocus()'), true); await shown('#windowMaximize'); await h.screenshot('window-restored-after-minimize');
      return { before: before.bounds, minimized, explicitActivation: { verified: activated.verified, session: activated.session }, restored: restored.bounds, mainWindowClosed: false, sentToModel: false };
    } finally { await activate(); await setExpanded(initialExpanded === 'true'); await waitBounds(before.bounds, 'Main window remains restored after minimize scenario'); }
  });

  const layout = () => read("(()=>{const root=document.body,rect=id=>{const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,display:s.display,visible:r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'}};return {leftHidden:root.classList.contains('left-panel-hidden'),rightHidden:root.classList.contains('right-panel-hidden'),focused:root.classList.contains('chat-focus-mode'),leftExpanded:document.querySelector('#leftPanelToggle').getAttribute('aria-expanded'),rightExpanded:document.querySelector('#rightPanelToggle').getAttribute('aria-expanded'),focusPressed:document.querySelector('#shellFocusBtn').getAttribute('aria-pressed'),chatFocusPressed:document.querySelector('#chatFocusToggle').getAttribute('aria-pressed'),sidebar:rect('sidebar'),files:rect('filesPanel'),chat:rect('chatMessages'),tab:document.querySelector('.workbench-tab.active')?.dataset.workbenchView||'files'};})()");
  async function normalLayout() {
    if ((await layout()).focused) await click('#shellFocusBtn');
    if ((await layout()).leftHidden) await click('#leftPanelToggle');
    if ((await layout()).rightHidden) await click('#rightPanelToggle');
    await shown('#sidebar'); await shown('#filesPanel');
  }
  async function restoreLayout(saved) {
    if ((await layout()).focused) await click('#shellFocusBtn');
    if ((await layout()).leftHidden !== saved.leftHidden) await click('#leftPanelToggle');
    if ((await layout()).rightHidden !== saved.rightHidden) await click('#rightPanelToggle');
    if ((await layout()).focused !== saved.focused) await click('#shellFocusBtn');
    await h.until(async () => {
      const actual = await layout(); return actual.leftHidden === saved.leftHidden && actual.rightHidden === saved.rightHidden && actual.focused === saved.focused;
    }, 'Original shell panel visibility restored');
  }
  async function chat() {
    await h.nav('chat');
    if (await visible('[data-chat-view="conversation"]')) await click('[data-chat-view="conversation"]');
    await shown('#chatInput');
  }

  await h.check('Window / actual left and right shell visibility toggles preserve the other pane', async () => {
    const saved = await layout();
    try {
      await normalLayout(); await chat(); const before = await layout(); assert.ok(before.sidebar.visible && before.files.visible);
      await click('#leftPanelToggle');
      const left = await h.until(async () => { const state = await layout(); return state.leftHidden && !state.sidebar.visible && state.files.visible && state.leftExpanded === 'false' && state.rightExpanded === 'true' && state; }, 'Left shell toggle hides actual left panel only');
      assert.ok(left.chat.width >= before.chat.width, 'Hiding left panel gives space to chat');
      await click('#leftPanelToggle'); await shown('#sidebar');
      await click('#rightPanelToggle');
      const right = await h.until(async () => { const state = await layout(); return state.rightHidden && !state.files.visible && state.sidebar.visible && state.rightExpanded === 'false' && state.leftExpanded === 'true' && state; }, 'Right shell toggle hides actual right panel only');
      await click('#rightPanelToggle'); await shown('#filesPanel');
      const restored = await layout(); assert.ok(restored.sidebar.visible && restored.files.visible); await h.screenshot('window-independent-shell-panels');
      return { before, leftHidden: left, rightHidden: right, restored, actions: ['left hide', 'left show', 'right hide', 'right show'] };
    } finally { await restoreLayout(saved); }
  });

  await h.check('Window / actual shell focus toggle hides both panels and restores chat layout', async () => {
    const saved = await layout();
    try {
      await normalLayout(); await chat(); const before = await layout();
      await click('#shellFocusBtn');
      const focused = await h.until(async () => { const state = await layout(); return state.focused && !state.sidebar.visible && !state.files.visible && state.focusPressed === 'true' && state.chatFocusPressed === 'true' && state.leftExpanded === 'false' && state.rightExpanded === 'false' && state; }, 'Shell focus command hides both actual panes');
      assert.ok(focused.chat.width > before.chat.width, 'Focus mode expands actual chat width'); await h.screenshot('window-actual-focus-layout');
      await click('#shellFocusBtn');
      const restored = await h.until(async () => { const state = await layout(); return !state.focused && state.sidebar.visible && state.files.visible && state.focusPressed === 'false' && state.chatFocusPressed === 'false' && state; }, 'Shell focus command restores actual side panes');
      return { before, focused, restored, forwardedControl: 'shellFocusBtn -> actual chatFocusToggle click handler' };
    } finally { await restoreLayout(saved); }
  });

  await h.check('Window / actual Files pane tabs switch exclusive rendered panels and restore selection', async () => {
    const saved = await layout();
    const selectors = { files: '#filesList', git: '#gitPanel', search: '#searchPanel', terminal: '#terminalPanel', ide: '#idePanel' }, receipts = [];
    try {
      await normalLayout(); await chat();
      for (const tab of Object.keys(selectors)) {
        await click('[data-workbench-view=' + q(tab) + ']'); await shown(selectors[tab]);
        const actual = await read("({active:Array.from(document.querySelectorAll('.workbench-tab.active')).map(e=>e.dataset.workbenchView),panels:Object.fromEntries(['filesList','gitPanel','searchPanel','terminalPanel','idePanel'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return [id,{visible:r.width>1&&r.height>1&&getComputedStyle(e).display!=='none',width:r.width,height:r.height}]}))})");
        assert.deepEqual(actual.active, [tab]);
        for (const [key, selector] of Object.entries(selectors)) assert.equal(actual.panels[selector.slice(1)].visible, key === tab, tab + ' has exactly its own actual rendered panel');
        if (tab === 'search') await h.until(() => read("document.activeElement?.id==='workspaceSearchInput'"), 'Search tab focuses actual workspace search input');
        if (tab === 'ide') await h.until(() => read("document.body.classList.contains('ide-active')"), 'IDE tab activates actual IDE layout');
        receipts.push({ tab, ...actual });
      }
      await h.screenshot('window-actual-files-tabs');
      return { receipts, restoredTab: saved.tab, scope: 'Actual tab selection/rendering; no terminal command, Git mutation or IDE task is started' };
    } finally { await click('[data-workbench-view=' + q(saved.tab) + ']'); await shown(selectors[saved.tab]); await restoreLayout(saved); }
  });

  async function edgeDrag(edge, delta) {
    const seen = await nativeObservation();
    const ui = await read(`(()=>{const e=document.querySelector('.window-resize-handle[data-edge=${q(edge)}]'),r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,w:innerWidth,h:innerHeight,expanded:document.documentElement.dataset.windowExpanded}})()`);
    assert.equal(ui.expanded, 'false'); assert.ok(ui.width >= 5 && ui.height >= 5);
    const sx = seen.frame.width / ui.w, sy = seen.frame.height / ui.h, horizontal = edge === 'e';
    const fromX = horizontal ? Math.ceil(ui.left * sx) + 1 : Math.round((ui.left + ui.width / 2) * sx);
    const fromY = horizontal ? Math.round((ui.top + ui.height / 2) * sy) : Math.ceil(ui.top * sy) + 1;
    const toX = fromX + (horizontal ? delta : 0), toY = fromY + (horizontal ? 0 : delta);
    assert.ok(toX >= 0 && toY >= 0 && toX < seen.frame.width && toY < seen.frame.height, 'Actual native drag remains inside its observed HWND; no coordinate bypass');
    let error, result;
    try { result = await h.nativeRun({ action: 'drag', backend: 'native', controlMode: 'foreground', focusPolicy: 'stop', relativeX: fromX, relativeY: fromY, toRelativeX: toX, toRelativeY: toY, durationMs: 480, settleMs: 180 }); }
    catch (failure) { if (!failure.desktopResult?.metadata?.desktop?.dispatchedActions) throw failure; error = failure; }
    const after = await geometry();
    if (error) {
      if (sameBounds(after.bounds, seen.session.bounds)) throw error;
      independentIssue('physical-window-edge-drag-' + edge, error, 'Fresh owned native bounds independently changed after dispatched input; next action observes new geometry');
    }
    return { edge, requestedDelta: delta, before: seen.session.bounds, after: after.bounds, uiHandle: ui, physicalCoordinates: { fromX, fromY, toX, toY }, result };
  }

  for (const edge of ['e', 's']) await h.check('Window / actual native ' + edge + ' edge drag changes OS size and returns to original geometry', async () => {
    await shown('#windowMaximize'); await activate(); const initiallyExpanded = await expanded(); await setExpanded(false);
    const baseline = await geometry(), dimension = edge === 'e' ? 'width' : 'height', opposite = edge === 'e' ? 'height' : 'width';
    const drags = [];
    try {
      // Native Drag deliberately limits its destination to the observed window.
      // A three-physical-pixel resize stays reversible inside the 5 CSS-pixel
      // handle; larger outward restoration would violate that input boundary.
      const shrunk = await edgeDrag(edge, -3); drags.push(shrunk);
      assert.equal(shrunk.after.left, baseline.bounds.left); assert.equal(shrunk.after.top, baseline.bounds.top);
      assert.equal(shrunk.after[opposite], baseline.bounds[opposite]);
      assert.ok(shrunk.after[dimension] < baseline.bounds[dimension], 'Physical cursor movement actually shrinks the native window; no synthetic-cursor pass');
      await h.screenshot('window-actual-edge-' + edge + '-resized');
    } finally {
      // Each correction is chosen from new native geometry. Never blindly replay
      // a potentially executed drag after a post-observation geometry error.
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await geometry(), correction = baseline.bounds[dimension] - current.bounds[dimension];
        if (!correction) break;
        assert.ok(Math.abs(correction) <= 3, 'Restore uses only a measured reversible native edge delta');
        drags.push(await edgeDrag(edge, correction));
      }
      await waitBounds(baseline.bounds, 'Actual edge drag restores exact original OS window bounds');
      await setExpanded(initiallyExpanded === 'true');
    }
    const restored = await geometry(); await h.screenshot('window-actual-edge-' + edge + '-restored');
    return { edge, baseline: baseline.bounds, drags, restored: restored.bounds, initialExpanded: initiallyExpanded, physicalInput: true, syntheticCursor: false, scope: 'Small real reversible edge drag; bounds verified through native OS window enumeration' };
  });
}

module.exports = { runWindow };
