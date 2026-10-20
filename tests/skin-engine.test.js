// The skin engine's palette maths. Pure functions run in a VM with a stub DOM
// so this suite stays fast and does not need a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.resolve('src/renderer/services/SkinEngine.js'), 'utf8');
const sandbox = {
  window: {},
  document: {
    documentElement: {
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
      getAttribute: () => 'light',
    },
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};
vm.runInNewContext(code, sandbox);
const skins = sandbox.window.IexaSkins;

test('one palette becomes the full token set', () => {
  const vars = skins.derive({ accent: '#6c63ff', canvas: '#f1ecec', surface: '#faf7f7', text: '', radius: 12 }, 'light');
  assert.equal(vars['--accent'], '#6c63ff');
  assert.equal(vars['--bg-primary'], '#f1ecec');
  assert.equal(vars['--bg-secondary'], '#faf7f7');
  assert.equal(vars['--radius'], '12px');
  assert.equal(vars['--radius-sm'], '8px');
  assert.match(vars['--accent-light'], /^rgba\(108, 99, 255, 0\.1[0-9]\)$/);
  assert.equal(vars['--text-primary'], '#141414', 'a light surface gets dark ink');
  assert.notEqual(vars['--bg-tertiary'], vars['--bg-secondary'], 'the third surface is its own tone');
  assert.notEqual(vars['--border'], vars['--border-strong'], 'two border weights stay distinct');
});

test('dark mode flips the ink and deepens the action button', () => {
  const light = skins.derive({ accent: '#60a5fa', canvas: '#f1ecec', surface: '#faf7f7', text: '', radius: 12 }, 'light');
  const dark = skins.derive({ accent: '#7dd3fc', canvas: '#211e1e', surface: '#2a2626', text: '', radius: 12 }, 'dark');
  assert.equal(light['--text-primary'], '#141414');
  assert.equal(dark['--text-primary'], '#ffffff');
  assert.equal(light['--action-bg'], light['--accent-hover'], 'light buttons deepen the accent');
  assert.equal(dark['--action-bg'], dark['--accent'], 'dark buttons use the pastel accent itself');
  assert.equal(dark['--on-accent'], '#141414', 'pastel accents take dark ink');
});

test('button ink keeps white on a saturated blue', () => {
  assert.equal(skins.inkOn('#3b82f6'), '#ffffff');
  assert.equal(skins.inkOn('#a5b4fc'), '#141414');
  // Body ink always picks the stronger contrast, even mid-grey.
  assert.equal(skins.readableOn('#808080'), '#141414');
});

test('contrast maths matches the WCAG reference points', () => {
  assert.equal(Number(skins.contrast('#000000', '#ffffff').toFixed(2)), 21);
  assert.equal(Number(skins.contrast('#ffffff', '#ffffff').toFixed(2)), 1);
  assert.ok(skins.contrast('#141414', '#faf7f7') > 15);
});

test('radius is clamped instead of trusted', () => {
  assert.equal(skins.derive({ accent: '#000000', canvas: '#ffffff', surface: '#ffffff', text: '', radius: 2 }, 'light')['--radius'], '6px');
  assert.equal(skins.derive({ accent: '#000000', canvas: '#ffffff', surface: '#ffffff', text: '', radius: 99 }, 'light')['--radius'], '20px');
});

test('every preset defines both modes and readable colours', () => {
  for (const preset of skins.presets) {
    if (!preset.light) continue;
    for (const mode of ['light', 'dark']) {
      const palette = preset[mode];
      assert.match(palette.accent, /^#[0-9a-f]{6}$/, preset.id + ' ' + mode + ' accent');
      const vars = skins.derive(palette, mode);
      assert.ok(skins.contrast(vars['--text-primary'], vars['--bg-secondary']) >= 4.5,
        preset.id + ' ' + mode + ' body contrast');
      assert.ok(skins.contrast(vars['--on-accent'], vars['--action-bg']) >= 3,
        preset.id + ' ' + mode + ' button contrast');
    }
  }
});

test('imported skins are validated, not trusted', () => {
  assert.match(skins.importPatch({ format: 'nope' }), /不是 IEXA 皮肤文件/);
  assert.match(skins.importPatch({ format: 'iexa-skin' }), /缺少配色数据/);
  assert.equal(skins.importPatch({
    format: 'iexa-skin',
    skinPreset: 'custom',
    customSkin: {
      light: { accent: '#112233', canvas: '#ffffff', surface: '#fafafa', text: '', radius: 12 },
      dark: { accent: '#445566', canvas: '#111111', surface: '#181818', text: '', radius: 12 },
    },
  }), null);
  assert.equal(skins.state.preset, 'custom');
});
