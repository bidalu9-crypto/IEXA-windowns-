'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../src/renderer');

test('voice input button is beside send and uses native streaming recognition without model configuration', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = require('./helpers/renderer-bundle').source;
  const css = fs.readFileSync(path.join(root, 'workbench.css'), 'utf8');
  assert.ok(html.indexOf('id="voiceBtn"') < html.indexOf('id="sendBtn"'));
  assert.match(html, /voice-icon/);
  assert.match(app, /SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(app, /continuous = true/);
  assert.match(app, /interimResults = true/);
  assert.match(app, /onresult/);
  assert.match(app, /isFinal/);
  assert.match(app, /recognition\.stop/);
  assert.match(app, /recognition\.abort/);
  assert.match(css, /voice-level/);
  assert.match(css, /is-listening/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function voiceHarness(t, options = {}) {
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = source.indexOf('// Native streaming speech input:');
  const end = source.indexOf("sendBtn.addEventListener('click', sendMessage);", start);
  assert.ok(start >= 0 && end > start, 'Execute the actual renderer voice IIFE');
  const dom = new JSDOM('<button id="voiceBtn"></button><textarea id="chatInput"></textarea><div id="status"></div>', {
    url: 'http://localhost', runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const button = window.document.getElementById('voiceBtn');
  const input = window.document.getElementById('chatInput');
  const status = window.document.getElementById('status');
  const timers = new Map();
  let timerId = 0, engine;
  window.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.SpeechRecognition = class {
    constructor() { engine = this; this.starts = 0; this.stops = 0; this.aborts = 0; }
    start() { this.starts++; }
    stop() { this.stops++; }
    abort() { this.aborts++; }
  };
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    value: options.noPermissions ? undefined : { query: options.query || (async () => ({ state: 'granted' })) },
  });
  Object.assign(window, {
    voiceBtn: button, chatInput: input,
    IexaI18n: { t: (key, params) => key + (params?.error ? ':' + params.error : '') },
    setStatusText: text => { status.textContent = text; },
  });
  vm.runInContext(source.slice(start, end), dom.getInternalVMContext(), { filename: 'app.js:voice-input' });
  return {
    window, button, input, status, engine, timers,
    runTimeouts() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('an actually denied microphone permission prevents recognition startup and remains visible after end', async t => {
  const queried = [];
  const h = voiceHarness(t, { query: async descriptor => { queried.push(descriptor.name); return { state: 'denied' }; } });
  h.input.value = 'Preserved draft';
  h.button.click();
  await settle();
  assert.deepEqual(queried, ['microphone']);
  assert.equal(h.engine.starts, 0);
  assert.equal(h.button.dataset.voiceState, 'error');
  assert.equal(h.button.title, 'voice.denied');
  assert.equal(h.status.textContent, 'voice.deniedHint');
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.button.classList.contains('is-listening'), false);
  assert.equal(h.input.value, 'Preserved draft');
  h.engine.onend();
  assert.equal(h.button.dataset.voiceState, 'error');
  assert.equal(h.button.title, 'voice.denied');
  assert.equal(h.status.textContent, 'voice.deniedHint');
});

test('Stop while permission is pending invalidates the request even after the stop timeout', async t => {
  const permission = deferred();
  const h = voiceHarness(t, { query: () => permission.promise });
  h.button.click();
  assert.equal(h.button.dataset.voiceState, 'starting');
  assert.equal(h.engine.starts, 0);
  h.button.click();
  assert.equal(h.button.dataset.voiceState, 'stopping');
  h.runTimeouts();
  assert.equal(h.button.dataset.voiceState, 'idle');
  const stoppedTitle = h.button.title;
  permission.resolve({ state: 'granted' });
  await settle();
  assert.equal(h.engine.starts, 0);
  assert.equal(h.button.dataset.voiceState, 'idle');
  assert.equal(h.button.title, stoppedTitle);
  h.engine.onstart();
  assert.equal(h.button.dataset.voiceState, 'idle');
  assert.equal(h.input.classList.contains('is-voice-live'), false);
  assert.equal(h.engine.aborts, 2, 'Timeout and late startup both abort the stopped recognition');
});

test('a stale permission result cannot replace a newer startup after Stop', async t => {
  const requests = [deferred(), deferred()];
  let index = 0;
  const h = voiceHarness(t, { query: () => requests[index++].promise });
  h.button.click();
  h.button.click();
  h.runTimeouts();
  h.button.click();
  requests[0].resolve({ state: 'denied' });
  await settle();
  assert.equal(h.engine.starts, 0);
  assert.equal(h.button.dataset.voiceState, 'starting');
  assert.equal(h.status.textContent, '');
  requests[1].resolve({ state: 'granted' });
  await settle();
  assert.equal(h.engine.starts, 1);
  h.engine.onstart();
  assert.equal(h.button.dataset.voiceState, 'listening');
});

for (const error of ['not-allowed', 'network']) {
  test(error + ' recognition error followed by end keeps its message and permits an explicit retry', async t => {
    const h = voiceHarness(t);
    h.button.click();
    await settle();
    h.engine.onstart();
    h.engine.onerror({ error });
    h.engine.onend();
    assert.equal(h.button.dataset.voiceState, 'error');
    assert.equal(h.button.title, error === 'not-allowed' ? 'voice.denied' : 'voice.failed:network');
    assert.equal(h.status.textContent, error === 'not-allowed' ? 'voice.deniedHint' : 'voice.failed:network');
    assert.equal(h.input.classList.contains('is-voice-live'), false);
    assert.equal(h.button.getAttribute('aria-pressed'), 'false');
    h.button.click();
    await settle();
    assert.equal(h.engine.starts, 2);
    assert.equal(h.button.dataset.voiceState, 'starting');
  });
}

for (const state of ['granted', 'prompt']) {
  test(state + ' permission starts recognition once, retains the draft and stops cleanly', async t => {
    const h = voiceHarness(t, { query: async () => ({ state }) });
    h.input.value = 'Existing draft ';
    let inputEvents = 0;
    h.input.addEventListener('input', () => inputEvents++);
    h.button.click();
    assert.equal(h.engine.starts, 0, 'Recognition waits for the permission query');
    await settle();
    assert.equal(h.engine.starts, 1);
    assert.equal(h.engine.continuous, true);
    assert.equal(h.engine.interimResults, true);
    h.engine.onstart();
    assert.equal(h.button.dataset.voiceState, 'listening');
    assert.equal(h.button.getAttribute('aria-pressed'), 'true');
    h.engine.onresult({ resultIndex: 0, results: [
      Object.assign([{ transcript: 'final words' }], { isFinal: true }),
      Object.assign([{ transcript: 'live words' }], { isFinal: false }),
    ] });
    assert.equal(h.input.value, 'Existing draft final words live words');
    assert.equal(inputEvents, 1);
    h.button.click();
    assert.equal(h.engine.stops, 1);
    assert.equal(h.button.dataset.voiceState, 'stopping');
    h.engine.onend();
    assert.equal(h.button.dataset.voiceState, 'idle');
    assert.equal(h.button.title, '语音输入已停止');
    assert.equal(h.input.classList.contains('is-voice-live'), false);
    assert.equal(h.timers.size, 0, 'Successful end clears the fallback abort timer');
  });
}

for (const [label, options] of [
  ['missing Permissions API', { noPermissions: true }],
  ['synchronous unsupported permission query', { query: () => { throw new TypeError('Unsupported permission'); } }],
  ['rejected permission query', { query: () => Promise.reject(new TypeError('Unsupported permission')) }],
]) {
  test(label + ' preserves the native recognition fallback', async t => {
    const h = voiceHarness(t, options);
    h.button.click();
    await settle();
    assert.equal(h.engine.starts, 1);
    h.engine.onstart();
    assert.equal(h.button.dataset.voiceState, 'listening');
  });
}

test('unloading cancels a permission query before it can start recognition', async t => {
  const permission = deferred();
  const h = voiceHarness(t, { query: () => permission.promise });
  h.button.click();
  h.window.dispatchEvent(new h.window.Event('beforeunload'));
  permission.resolve({ state: 'granted' });
  await settle();
  assert.equal(h.engine.starts, 0);
  assert.equal(h.engine.aborts, 1);
});
