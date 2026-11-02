// Verifies the island behaves like the user's screenshot asked: the window is
// exactly 40px tall at launch (never a restored expanded height), the pill fills
// it with no slack, text is 12.5px, and the icon is 15px.
//
// Also asserts the two plumbing bugs that made it look broken: the preload must
// pass the resize request through unchanged (Number({width,height}) is NaN and
// collapsed every resize to 0), and the window must be created only after PORT is
// known, otherwise loadURL targets http://127.0.0.1:null/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const entry = fs.readFileSync(path.join(ROOT, 'electron-entry.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/island.css'), 'utf8');
const island = fs.readFileSync(path.join(ROOT, 'src/renderer/island.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/island.html'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'resources/island-preload.js'), 'utf8');

test('the launch height is fixed and never restored from disk', () => {
  // Height used to be Math.max(COMPACT, saved.height): an expanded 98–560px was
  // saved, so the next launch opened with a tall empty pill.
  assert.doesNotMatch(entry, /height: Math\.max\(ISLAND_COMPACT_HEIGHT, Number\(saved\.height\)/,
    'saved height must not be restored');
  assert.match(entry, /height: ISLAND_COMPACT_HEIGHT,/, 'launch is always collapsed');
  assert.match(entry, /const ISLAND_COMPACT_HEIGHT = 46;/, 'window height');
  assert.match(island, /const COMPACT_HEIGHT = 46;/, 'renderer agrees with the window');
});

test('resize requests reach main untouched', () => {
  // Number({ width, height }) is NaN -> || 0 -> the main process saw "height 0"
  // on every call, so the pill never hugged its text and never grew.
  assert.match(preload, /resize: \(request\) => ipcRenderer\.send\('iexa:island-resize', request\)/,
    'the object is forwarded as-is');
  assert.doesNotMatch(preload, /Number\(height\) \|\| 0/, 'no numeric coercion');
  assert.match(island, /resize\(\{ width, height \}\)/, 'the renderer sends both dimensions');
  assert.match(entry, /Number\(object\.height\)/, 'main reads the object form');
  assert.match(entry, /Number\(object\.width\)/, 'including the width');
});

test('the window is created only after PORT exists', () => {
  const portAt = entry.indexOf('PORT = await claimPort(PREFERRED_PORT)');
  const createAt = entry.indexOf('if (readIslandConfig().enabled) createIslandWindow()');
  assert.ok(portAt > 0 && createAt > 0, 'both anchors exist');
  assert.ok(createAt > portAt,
    'creating before the port is claimed pointed loadURL at http://127.0.0.1:null/island.html');
  assert.match(entry, /did-finish-load[\s\S]{0,200}pushIslandState\(\)/,
    'state pushed while the page was loading is re-sent once it finishes');
});

test('the compact row fills the window and the type is legible', () => {
  assert.match(css, /flex: 0 0 36px;/, 'row height');
  assert.match(css, /height: 36px;/);
  assert.match(css, /justify-content: center;/, 'the group is centred');
  assert.match(css, /font-size: 13px;/, 'label size');
  // The compact row carries no tool glyph at all: a 15px filled icon read as a
  // play button. Glyphs live in the expanded list, where they have room.
  assert.doesNotMatch(html, /id="islandIcon"/, 'no glyph in the compact row');
  assert.match(css, /\.island-step-icon svg \{ width: 15px; height: 15px;/, 'step icon size');
  assert.match(css, /height: calc\(100% - 36px\);/, 'the expanded area accounts for the row');
  // 36px row + 5px inset top and bottom is exactly the 46px window.
  assert.match(css, /\.island \{[\s\S]{0,80}?inset: 5px;/, 'the pill is inset by 5px on all sides');
});

test('the page canvas stays transparent', () => {
  // `color-scheme: dark` on the root made Chromium paint the canvas with its
  // opaque dark base colour. In a transparent Electron window that is an opaque
  // rectangle behind the pill — the "extra black layer" in the report. It is
  // scoped to the pill instead, where only form controls read it.
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  assert.doesNotMatch(rootBlock, /color-scheme/, 'the root must not declare a colour scheme');
  assert.match(css, /html, body \{[\s\S]*?background: transparent;/, 'the page paints nothing');
});

test('the expanded card is measured so its list never scrolls', () => {
  assert.match(island, /const clone = expanded\.cloneNode\(true\)/, 'measured on a detached clone');
  assert.match(island, /clone\.style\.cssText = 'position:fixed;left:-9999px/, 'outside the flex parent');
  assert.match(island, /return COMPACT_HEIGHT \+ measured \+ 4;/, 'the window grows by the measured height');
  assert.doesNotMatch(island, /COMPACT_HEIGHT \+ 34 \+ steps \* 26/, 'the guessed formula is gone');
  // At most six rows are ever shown and the window is sized to them, so nothing
  // may scroll: a scrollbar inside a 168px pill was one of the reported defects.
  assert.match(css, /\.island-steps \{[\s\S]*?overflow: hidden;/, 'the step list does not scroll');
});
