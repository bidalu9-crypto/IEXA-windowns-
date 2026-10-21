// Guards for the two halves of "links work": the renderer routes the click, and
// the main process only hands safe schemes to the OS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the renderer intercepts transcript anchors and hands them to the bridge', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /closest\?\.\('\.message-content a\[href\]'\)/, 'only transcript anchors are intercepted');
  assert.match(app, /if \(!\/\^\(https\?:\|mailto:\)\/i\.test\(href\)\) return;/, 'other schemes keep their default behaviour');
  assert.match(app, /event\.preventDefault\(\)/, 'the in-app navigation must be cancelled');
  assert.match(app, /bridge\.openExternal\(href\)/, 'the click goes through the preload bridge');
  assert.match(app, /window\.open\(href, '_blank', 'noopener'\)/, 'a plain browser still has a fallback');
});

test('the preload exposes exactly one external-open call', () => {
  const preload = read('preload.js');
  assert.match(preload, /openExternal: \(url\) => ipcRenderer\.invoke\('iexa:open-external', url\)/);
  // It must not become a generic shell escape hatch.
  assert.doesNotMatch(preload, /shell\./);
});

test('the main process refuses anything but web and mail schemes', () => {
  const entry = read('electron-entry.js');
  const start = entry.indexOf("ipcMain.handle('iexa:open-external'");
  assert.ok(start > 0, 'the handler is registered');
  const block = entry.slice(start, start + 900);
  assert.match(block, /\['http:', 'https:', 'mailto:'\]/, 'only three schemes are allowed');
  assert.match(block, /parsed\.username \|\| parsed\.password/, 'embedded credentials are rejected');
  assert.match(block, /shell\.openExternal\(parsed\.href\)/);
  assert.match(block, /new URL\(rawUrl\)/, 'the URL is parsed before use');
});

test('the sanitizer still strips target, so the click handler is the only path', () => {
  const markdown = read('src/renderer/services/SafeMarkdown.js');
  assert.match(markdown, /FORBID_ATTR: \[[^\]]*'target'/, 'a model cannot open windows by itself');
});

test('links and emphasis are painted from one token, with a mask globe', () => {
  const css = read('src/renderer/styles/transcript.css');
  assert.match(css, /\.message-content a\[href\] \{[^}]*color: var\(--link\)/);
  assert.match(css, /\.message-content strong \{ color: var\(--link\)/);
  assert.match(css, /a\[href\^="http"\]::before[\s\S]{0,220}-webkit-mask: var\(--icon-globe\)/,
    'the globe is a mask so it inherits the link colour');
  const base = read('src/renderer/styles/base.css');
  assert.match(base, /--link: #[0-9a-f]{6};/, 'the light tone is declared');
  assert.match(base, /\[data-theme="dark"\][\s\S]{0,900}--link: #[0-9a-f]{6};/, 'the dark tone is declared');
});
