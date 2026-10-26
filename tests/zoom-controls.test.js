// Ctrl+= did nothing because Electron's default menu binds zoom-in to
// `CommandOrControl+Plus`, and `+` needs Shift on most layouts. Zoom-out had no
// floor either, so the only escape from a 25% window was a shortcut nobody knew.
// These tests pin the replacement: one handler, both keys, a readable range.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULTS, clampZoom, stepZoom, zoomCommandFor, stripZoomAccelerators,
} = require('../resources/zoom-controls.cjs');

test('the range never leaves the window unreadable', () => {
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0.1), DEFAULTS.min, 'Chromium would allow 0.25; we stop at 75%');
  assert.equal(clampZoom(5), DEFAULTS.max);
  assert.equal(clampZoom('nonsense'), 1, 'a broken value falls back to 100%');
  assert.equal(clampZoom(0.824999), 0.82, 'two decimals, no float drift');
});

test('stepping moves by 10% and stops at both ends', () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.95, 1), DEFAULTS.max);
  assert.equal(stepZoom(0.8, -1), DEFAULTS.min);
  // Repeated presses must not walk past the floor, which is the reported bug.
  let factor = 1;
  for (let i = 0; i < 40; i += 1) factor = stepZoom(factor, -1);
  assert.equal(factor, DEFAULTS.min);
  for (let i = 0; i < 40; i += 1) factor = stepZoom(factor, 1);
  assert.equal(factor, DEFAULTS.max);
});

test('both spellings of plus work, and only with the control modifier', () => {
  const inKeys = [
    { type: 'keyDown', control: true, key: '=', code: 'Equal' },
    { type: 'keyDown', control: true, key: '+', code: 'Equal' },
    { type: 'keyDown', control: true, key: '+', code: 'NumpadAdd' },
    { type: 'keyDown', meta: true, key: '=', code: 'Equal' },
  ];
  for (const input of inKeys) assert.equal(zoomCommandFor(input), 'in', JSON.stringify(input));

  const outKeys = [
    { type: 'keyDown', control: true, key: '-', code: 'Minus' },
    { type: 'keyDown', control: true, key: '-', code: 'NumpadSubtract' },
  ];
  for (const input of outKeys) assert.equal(zoomCommandFor(input), 'out', JSON.stringify(input));

  assert.equal(zoomCommandFor({ type: 'keyDown', control: true, key: '0', code: 'Digit0' }), 'reset');
  assert.equal(zoomCommandFor({ type: 'keyDown', control: true, key: '0', code: 'Numpad0' }), 'reset');

  // Not ours: no modifier, alt held (AltGr sends ctrl+alt), key-up, plain digits.
  assert.equal(zoomCommandFor({ type: 'keyDown', key: '=', code: 'Equal' }), null);
  assert.equal(zoomCommandFor({ type: 'keyDown', control: true, alt: true, key: '=', code: 'Equal' }), null);
  assert.equal(zoomCommandFor({ type: 'keyUp', control: true, key: '=', code: 'Equal' }), null);
  assert.equal(zoomCommandFor({ type: 'keyDown', control: true, key: '1', code: 'Digit1' }), null);
});

test('the menu rebuild drops zoom accelerators and keeps everything else', () => {
  const seen = { built: null, applied: null };
  const fakeMenu = {
    getApplicationMenu: () => ({
      items: [
        { label: 'File', submenu: { items: [{ role: 'quit', label: 'Exit', accelerator: 'Alt+F4' }] } },
        {
          label: 'View',
          submenu: {
            items: [
              { role: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R' },
              { type: 'separator' },
              { role: 'resetZoom', label: 'Actual Size', accelerator: 'CommandOrControl+0' },
              { role: 'zoomIn', label: 'Zoom In', accelerator: 'CommandOrControl+Plus' },
              { role: 'zoomOut', label: 'Zoom Out', accelerator: 'CommandOrControl+-' },
              { type: 'separator' },
              { role: 'toggleDevTools', label: 'Developer Tools' },
            ],
          },
        },
        { label: 'Edit', submenu: { items: [{ role: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C' }] } },
      ],
    }),
    buildFromTemplate: (template) => { seen.built = template; return template; },
    setApplicationMenu: (menu) => { seen.applied = menu; },
  };

  const result = stripZoomAccelerators(fakeMenu);
  assert.ok(seen.built, 'the menu is rebuilt');
  assert.equal(result, seen.applied, 'and installed');

  const view = seen.built.find((item) => item.label === 'View');
  const roles = view.submenu.map((item) => item.role || item.type);
  // The roles would re-attach their default accelerators, so the items must go.
  assert.ok(!roles.includes('zoomIn') && !roles.includes('zoomin'), 'zoom-in item removed');
  assert.ok(!roles.includes('zoomOut') && !roles.includes('zoomout'), 'zoom-out item removed');
  assert.ok(!roles.includes('resetZoom') && !roles.includes('resetzoom'), 'reset item removed');
  const byRole = Object.fromEntries(view.submenu.map((item) => [item.role || item.type, item]));
  assert.equal(byRole.reload.accelerator, 'CmdOrCtrl+R', 'unrelated accelerators survive');
  assert.ok(roles.includes('separator'), 'separators survive');
  assert.equal(seen.built.find((item) => item.label === 'Edit').submenu[0].accelerator, 'CmdOrCtrl+C',
    'edit shortcuts survive');
  assert.equal(seen.built.find((item) => item.label === 'File').submenu[0].accelerator, 'Alt+F4',
    'file shortcuts survive');
});

test('removing entries never leaves a doubled or dangling separator', () => {
  const seen = { built: null };
  const fakeMenu = {
    getApplicationMenu: () => ({
      items: [{
        label: 'View',
        submenu: {
          items: [
            { role: 'reload', label: 'Reload' },
            { type: 'separator' },
            { role: 'zoomIn', label: 'Zoom In' },
            { role: 'zoomOut', label: 'Zoom Out' },
            { type: 'separator' },
            { role: 'toggleDevTools', label: 'DevTools' },
            { type: 'separator' },
          ],
        },
      }],
    }),
    buildFromTemplate: (template) => { seen.built = template; return template; },
    setApplicationMenu: () => {},
  };
  stripZoomAccelerators(fakeMenu);
  const submenu = seen.built[0].submenu;
  assert.deepEqual(submenu.map((item) => item.role || item.type),
    ['reload', 'separator', 'toggleDevTools'], 'no doubled separator, none at the end');
});

test('a missing menu is not an error', () => {
  const fakeMenu = { getApplicationMenu: () => null, buildFromTemplate: () => { throw new Error('must not build'); } };
  assert.equal(stripZoomAccelerators(fakeMenu), null);
});
