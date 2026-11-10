'use strict';

// Candidate acceptance: run only after publishing the matching native helper.
// All business GUI operations use production DesktopAgent. Filesystem access
// creates an isolated fixture and independently verifies that it was not edited.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { createSupervisor } = require('./helpers/acceptance-supervisor.cjs');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function until(read, label, timeout = 10000) {
  const end = Date.now() + timeout;
  do { const result = await read(); if (result) return result; await wait(200); } while (Date.now() < end);
  throw Error(label);
}

async function main() {
  const out = path.join(root, '.iexa-artifacts/desktop-autonomy-20261110', 'wps-focus-' + Date.now());
  const token = randomUUID().slice(0, 8), filename = 'focus-' + token + '.rtf', file = path.join(out, filename);
  const expectedText = 'FOCUS_' + token + '_' + randomUUID().slice(0, 8);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(file, '{\\rtf1\\ansi IEXA_FOCUS_FIXTURE ' + token + '\\par STATUS PENDING}');
  const report = { status: 'running', scope: 'Candidate editable ComboBox keyboard focus and readback; real WPS through production DesktopAgent',
    fixture: { file, expectedText, sha256Before: hash(file) }, actions: [], checks: [] };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  save();
  const wps = process.env.IEXA_TEST_WPS_EXE || 'D:\\MyStudio\\WPS Office\\12.1.0.28505\\office6\\wps.exe';
  const wpsDirectory = path.dirname(wps).toLowerCase();
  const supervisor = createSupervisor({ output: out, maximumDurationMs: 150000, allowFixtureCleanup: true,
    observeProcess: row => String(row.CommandLine || '').toLowerCase().includes(wpsDirectory) });
  let helper, endpoint, agent, documentHandle, dialogHandle, run;
  const ownedWindowHandles = new Set();
  try {
    await supervisor.begin();
    assert.ok(fs.existsSync(wps), 'WPS executable exists');
    const port = await new Promise(resolve => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
    endpoint = 'http://127.0.0.1:' + port;
    const fd = fs.openSync(path.join(out, 'native.log'), 'w'), started = Date.now();
    helper = spawn(path.join(root, 'desktop-agent/publish/Iexa.DesktopAgent.exe'), [], {
      cwd: root, env: { ...process.env, IEXA_DESKTOP_PORT: String(port) }, windowsHide: true, stdio: ['ignore', fd, fd],
    });
    fs.closeSync(fd);
    await supervisor.claimSpawn(helper, 'Iexa.DesktopAgent.exe', started);
    await until(async () => {
      try { const response = await fetch(endpoint + '/health'); return (await response.json()).pid === helper.pid; }
      catch { return false; }
    }, 'native helper readiness');
    const { DesktopAgent } = require('../dist/main/tools/DesktopAgent');
    agent = new DesktopAgent(root, false, path.join(out, 'journal'), endpoint);
    run = async (args, allowPartial = false, cleanup = false) => {
      const work = agent.execute({ backend: 'native', controlMode: 'foreground', ...args, detail: 'raw' }, undefined,
        { owner: 'wps-focus', operationId: randomUUID() });
      const result = await (cleanup ? work : Promise.race([work, supervisor.failure]));
      const entry = { args, success: result.success, output: result.output };
      if (result.imageData) {
        entry.image = 'frame-' + (report.actions.length + 1) + '.png';
        fs.writeFileSync(path.join(out, entry.image), result.imageData);
      }
      report.actions.push(entry); save();
      if (!result.success) {
        if (allowPartial) return null;
        throw Error(result.output);
      }
      return JSON.parse(result.output).data;
    };
    const baseline = await run({ action: 'list_windows' });
    const baselineHandles = new Set((baseline.windows || []).map(w => w.handle));
    const existingWps = (baseline.windows || []).filter(w => /^(wps|et|wpp)(\.exe)?$/i.test(w.process || ''));
    assert.equal(existingWps.length, 0, 'Visible WPS windows prevent exclusive fixture acceptance; leave them untouched');
    report.baselineWindowHandles = [...baselineHandles]; save();
    const launched = await run({ action: 'launch', app: wps, arguments: '"' + file + '"', focusPolicy: 'activate', captureFrame: true });
    assert.ok(launched.window?.handle, 'launch returns the document window');
    assert.ok(String(launched.window.title).includes(filename), 'launch binds the exact test document');
    assert.ok(!baselineHandles.has(launched.window.handle), 'document HWND is new to this test');
    documentHandle = launched.window.handle; ownedWindowHandles.add(documentHandle);
    await run({ action: 'observe', handle: documentHandle, captureFrame: true, limit: 80 });
    // Opening a modal can report partial success when foreground changes; inspect
    // once and bind the actual new dialog instead of replaying Ctrl+H.
    await run({ action: 'hotkey', keys: ['CTRL', 'H'], captureFrame: true, settleMs: 700 }, true);
    const dialog = await until(async () => {
      const state = await run({ action: 'list_windows' });
      return (state.windows || []).find(w => !baselineHandles.has(w.handle) && w.handle !== documentHandle
        && /^(wps)(\.exe)?$/i.test(w.process || '') && /查找.*替换|Find.*Replace/i.test(w.title || ''));
    }, 'new WPS find and replace dialog');
    dialogHandle = dialog.handle; ownedWindowHandles.add(dialogHandle);
    const observation = await run({ action: 'observe', handle: dialogHandle, captureFrame: true, limit: 100 });
    const combos = (observation.elements || []).filter(e => e.role === 'combobox');
    const find = combos.find(e => /查找内容|Find what/i.test(e.selector?.name || e.text));
    const replacement = combos.find(e => /替换为|Replace with/i.test(e.selector?.name || e.text));
    assert.ok(find && replacement, 'both find and replacement ComboBoxes are observed');
    assert.notEqual(find.id, replacement.id);
    assert.ok(replacement.selector?.runtimeId?.length, 'replacement target has a native runtime identity');
    report.target = { find, replacement }; save();
    const clicked = await run({ action: 'click_element', elementId: replacement.id, count: 1, captureFrame: true });
    assert.equal(clicked.method, 'pointer', 'editable ComboBox preselects a physical foreground click without provider mutation');
    const focused = await run({ action: 'read_focused' });
    assert.equal(focused.selector?.processId, replacement.selector.processId);
    assert.equal(focused.selector?.backend, replacement.selector.backend);
    assert.deepEqual(focused.selector?.runtimeId, replacement.selector.runtimeId,
      'keyboard focus belongs to the replacement ComboBox, not the find input or dropdown');
    report.checks.push({ name: 'Single foreground element click focuses the observed replacement ComboBox', passed: true }); save();
    // Find/replace history may pre-populate the field. Clear it through verified
    // keyboard focus before inserting a fresh, unpredictable marker.
    await run({ action: 'hotkey', keys: ['CTRL', 'A'] });
    await run({ action: 'type', text: expectedText, captureFrame: true });
    const readback = await run({ action: 'read_focused', captureFrame: true });
    assert.deepEqual(readback.selector?.runtimeId, replacement.selector.runtimeId);
    assert.equal(readback.text, expectedText, 'actual focused editable field contains the exact marker');
    assert.equal(readback.method, 'uia_value');
    report.readback = readback;
    report.checks.push({ name: 'Subsequent keyboard input reaches the replacement field and reads back exactly', passed: true });
    report.status = 'passed'; save();
  } catch (error) { report.status = 'failed'; report.error = error.stack; }
  finally {
    if (agent && run) {
      try {
        let state = await run({ action: 'list_windows' }, false, true);
        if (dialogHandle && ownedWindowHandles.has(dialogHandle) && (state.windows || []).some(w => w.handle === dialogHandle)) {
          await run({ action: 'observe', handle: dialogHandle, focusPolicy: 'activate' }, false, true);
          await run({ action: 'key', key: 'ESC', expectWindowClosed: true }, true, true);
          state = await run({ action: 'list_windows' }, false, true);
          assert.ok(!(state.windows || []).some(w => w.handle === dialogHandle), 'test dialog closed');
        }
        const document = (state.windows || []).find(w => w.handle === documentHandle);
        if (document && ownedWindowHandles.has(document.handle)) {
          assert.ok(String(document.title).includes(filename), 'only the exact fixture document may be closed');
          await run({ action: 'observe', handle: documentHandle, focusPolicy: 'activate' }, false, true);
          await run({ action: 'hotkey', keys: ['ALT', 'F4'], allowClose: true, expectWindowClosed: true }, true, true);
        }
        state = await run({ action: 'list_windows' }, false, true);
        report.windowsClosed = !(state.windows || []).some(w => ownedWindowHandles.has(w.handle));
        assert.equal(report.windowsClosed, true, 'all exact test HWNDs closed');
      } catch (error) { report.closeError = error.stack; report.status = 'failed'; }
    }
    report.fixture.sha256After = hash(file);
    if (report.fixture.sha256After !== report.fixture.sha256Before) {
      report.status = 'failed'; report.fileError = 'Focus-only acceptance unexpectedly changed the fixture document';
    }
    agent?.close();
    if (helper) {
      try {
        await fetch(endpoint + '/shutdown', { method: 'POST' });
        await until(() => helper.exitCode !== null, 'helper shutdown');
      } catch (error) { report.helperCloseError = error.message; report.status = 'failed'; }
    }
    try { report.resources = await supervisor.finish(); }
    catch (error) { report.resourceError = error.message; report.status = 'failed'; }
    report.completedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: report.status, out, error: report.error, closeError: report.closeError,
      resourceError: report.resourceError }));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
