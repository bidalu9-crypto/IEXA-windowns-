// Real Electron: the handler must react to the keys a user actually presses and
// must stop at both ends. sendInputEvent reaches before-input-event, so this is a
// deterministic check of the same code path the app installs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const HARNESS = `
const { app, BrowserWindow, Menu } = require('electron');
const zoom = require(${JSON.stringify(path.join(root, 'resources', 'zoom-controls.cjs'))});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 480 });
  await win.loadURL('data:text/html,<body style="font:16px sans-serif">zoom harness</body>');

  // The menu path is what made Ctrl+= dead, so strip it exactly like the app does.
  const stripped = zoom.stripZoomAccelerators(Menu);
  const viewRoles = {};
  if (stripped) {
    for (const item of stripped.items) {
      if (!item.submenu) continue;
      for (const child of item.submenu.items) {
        if (child.role && /zoom/i.test(child.role)) viewRoles[child.role] = child.accelerator || null;
      }
    }
  }

  const controls = zoom.installZoomControls(win.webContents);
  const send = (keyCode, modifiers) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const factor = () => win.webContents.getZoomFactor();
  // Fixed sleeps are unreliable when the suite runs many windows at once: poll
  // until the value stops moving (or reaches the expected one) instead.
  const settle = async (expected) => {
    const deadline = Date.now() + 8000;
    let last = null;
    while (Date.now() < deadline) {
      const current = factor();
      if (expected !== undefined) {
        if (Math.abs(current - expected) < 1e-6) return current;
      } else if (current === last) {
        return current;
      }
      last = current;
      await new Promise((r) => setTimeout(r, 25));
    }
    return factor();
  };
  const out = {};

  // A synthetic key event can be dropped while the renderer is still spinning up,
  // and that is far more likely when several suites run at once. Retry the press
  // until the expected factor lands: the handler is what is under test, not the
  // reliability of the event transport.
  const press = async (keyCode, modifiers, expected) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      send(keyCode, modifiers);
      const value = await settle(expected);
      if (expected === undefined || Math.abs(value - expected) < 1e-6) return value;
    }
    return factor();
  };

  out.start = factor();

  out.plusEquals = await press('=', ['control'], 1.1);
  out.plusTwice = await press('=', ['control'], 1.2);
  out.plusShift = await press('+', ['control', 'shift'], 1.3);
  out.minus = await press('-', ['control'], 1.2);

  // Keep pressing until the floor is reached: one dropped event would otherwise
  // leave the value a step short.
  for (let i = 0; i < 60 && Math.abs(factor() - zoom.DEFAULTS.min) > 1e-6; i += 1) send('-', ['control']);
  out.floor = await settle(zoom.DEFAULTS.min);

  out.reset = await press('0', ['control'], 1);

  for (let i = 0; i < 80 && Math.abs(factor() - zoom.DEFAULTS.max) > 1e-6; i += 1) send('=', ['control']);
  out.ceiling = await settle(zoom.DEFAULTS.max);

  out.resetAgain = await press('0', ['control'], 1);

  // Alt must be left alone (AltGr arrives as ctrl+alt on several layouts).
  send('=', ['control', 'alt']);    await new Promise((r) => setTimeout(r, 400));
  out.altIgnored = factor();

  out.menuZoomAccelerators = viewRoles;
  out.hasMenu = Boolean(stripped);
  out.menuRoles = [];
  if (stripped) {
    for (const item of stripped.items) {
      if (!item.submenu) continue;
      for (const child of item.submenu.items) if (child.role) out.menuRoles.push(child.role);
    }
  }

  // Rebuilding the menu must not cost the editing shortcuts. Ctrl+A is the
  // observable one here: the headless session has no clipboard owner, so reading
  // the clipboard back is not a reliable signal in this harness.
  await win.webContents.executeJavaScript(
    "(() => { const i = document.createElement('input'); i.id='probe'; document.body.appendChild(i); i.focus(); return true; })()",
  );
  win.webContents.insertText('clipboard-probe');
  // A synthetic key can be dropped while the renderer is busy. Retry the select
  // until the field actually reports a selection; reading once and asserting is
  // what made this test fail intermittently.
  let selectionProbe = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    send('a', ['control']);
    for (let i = 0; i < 20; i += 1) {
      selectionProbe = await win.webContents.executeJavaScript(
        "(() => { const i = document.getElementById('probe'); return i ? [i.selectionStart, i.selectionEnd, i.value] : null; })()",
      );
      if (selectionProbe && selectionProbe[0] !== selectionProbe[1]) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (selectionProbe && selectionProbe[0] !== selectionProbe[1]) break;
  }
  out.selectionProbe = selectionProbe;
  out.hasMenu = Boolean(stripped);
  out.min = zoom.DEFAULTS.min;
  out.max = zoom.DEFAULTS.max;

  console.log('IEXA_ZOOM ' + JSON.stringify(out));
  app.quit();
}).catch((error) => {
  console.log('IEXA_ZOOM_ERROR ' + (error && error.stack));
  app.quit();
});
`;

test('real electron: Ctrl+= zooms in and the range cannot become unusable', { skip: !fs.existsSync(electron), timeout: 120000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-zoom-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* locked */ } });
  const harness = path.join(dir, 'harness.cjs');
  fs.writeFileSync(harness, HARNESS, 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // otherwise electron behaves as plain node
  env.IEXA_HEADLESS = '1';

  const run = spawnSync(electron, [harness], { encoding: 'utf8', env, timeout: 90000, windowsHide: true });
  const output = String(run.stdout || '') + String(run.stderr || '');
  const line = output.split('\n').find((row) => row.startsWith('IEXA_ZOOM '));
  if (!line) assert.fail('harness produced no result:\n' + output.slice(-1500));

  const result = JSON.parse(line.slice('IEXA_ZOOM '.length));

  assert.equal(result.start, 1);
  assert.equal(result.plusEquals, 1.1, 'Ctrl+= is the bug: it used to do nothing');
  assert.equal(result.plusTwice, 1.2);
  assert.equal(result.plusShift, 1.3, 'Ctrl+Shift+= keeps working too');
  assert.equal(result.minus, 1.2, 'Ctrl+- steps back');

  assert.equal(result.floor, result.min, 'holding Ctrl+- stops at the floor instead of 25%');
  assert.equal(result.reset, 1, 'Ctrl+0 returns to 100%');
  assert.equal(result.ceiling, result.max, 'holding Ctrl+= stops at the ceiling');
  assert.equal(result.resetAgain, 1);
  assert.equal(result.altIgnored, 1, 'Ctrl+Alt+= is not a zoom shortcut');

  assert.ok(result.hasMenu, 'the default menu was rebuilt');
  // Roles re-attach their default accelerators, so the items themselves must go.
  for (const role of ['zoomin', 'zoomout', 'resetzoom', 'zoom']) {
    assert.ok(!result.menuRoles.includes(role), `menu still exposes ${role}`);
  }
  assert.deepEqual(result.menuZoomAccelerators, {},
    'no zoom accelerator survives in the rebuilt menu');
  assert.deepEqual(result.selectionProbe, [0, 15, 'clipboard-probe'],
    'Ctrl+A still selects the field after the menu rebuild');
});
