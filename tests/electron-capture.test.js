'use strict';
// Electron has no built-in screen picker: getDisplayMedia rejects unless the main
// process registers a handler and supplies a source. These checks keep that
// wiring, the picker assets and the composer button order from drifting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the main process registers a display-media handler with a real picker', () => {
  const entry = read('electron-entry.js');
  assert.match(entry, /desktopCapturer/, 'desktopCapturer must be imported');
  assert.match(entry, /setDisplayMediaRequestHandler\(/, 'the session handler is what makes getDisplayMedia work');
  assert.match(entry, /installDisplayMediaHandler\(\);/, 'the handler must be installed during startup');
  assert.match(entry, /answer\(source \? \{ video: source \} : \{\}\)/, 'the chosen source is handed back to Chromium');
  assert.match(entry, /answered = true/, 'the one-shot callback must never fire twice');
  assert.match(entry, /capturePickerOpen/, 'a second request must not open a second picker');
  // ipcMain.handle is refused for file:// senders ("Untrusted IPC sender"), so
  // the list travels through executeJavaScript instead.
  assert.doesNotMatch(entry, /ipcMain\.handle\('iexa:capture-sources'/);
  assert.match(entry, /executeJavaScript\(`window\.__setSources/, 'the picker receives its list by injection');
});

test('the picker page and its bridge exist and stay minimal', () => {
  const html = read('resources/capture-picker.html');
  const preload = read('resources/capture-picker-preload.js');
  assert.match(html, /role="listbox"/, 'the grid is a listbox for screen readers');
  assert.match(html, /window\.__setSources = /, 'the page accepts an injected list');
  assert.match(html, /Escape/, 'Esc cancels the picker');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('capturePicker'/);
  assert.match(preload, /iexa:capture-choose/);
  assert.match(preload, /iexa:capture-cancel/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke/, 'invoke is rejected from this sender');
  assert.doesNotMatch(preload, /require\('fs'\)/, 'the bridge exposes two calls, not the filesystem');
});

test('the composer keeps the camera left of the microphone', () => {
  const html = read('src/renderer/index.html');
  const actions = html.slice(html.indexOf('<div class="input-actions">'), html.indexOf('</div>', html.indexOf('<div class="input-actions">')));
  const screenshot = actions.indexOf('id="screenshotBtn"');
  const voice = actions.indexOf('id="voiceBtn"');
  const send = actions.indexOf('id="sendBtn"');
  assert.ok(screenshot > 0 && voice > 0 && send > 0, 'all three controls live in the action row');
  assert.ok(screenshot < voice, 'the camera sits left of the microphone');
  assert.ok(voice < send, 'the microphone sits left of send');
});
