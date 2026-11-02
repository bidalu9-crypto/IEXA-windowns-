'use strict';
// The reasoning chip must describe what the provider will actually receive.
//
// `applyThinkingLevelUI` reads the profile's wire capability, so this drives the
// real page with three profiles: a V4 gateway that takes high/max, a pre-V4
// DeepSeek that sends nothing, and a chat model with no reasoning mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: the reasoning chip states what the provider actually receives', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-wire-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({ sessions: [] }));
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  let socket;
  let page;
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (page) await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  page = await launchPage();
  socket = page.socket;
  let sequence = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 10000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 240));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 150; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof applyThinkingLevelUI === 'function' && typeof modelSelectorProfiles !== 'undefined'");
  await new Promise((resolve) => setTimeout(resolve, 900));

  const probe = async (profile, level) => evaluate(`(() => {
    modelSelectorProfiles = [${JSON.stringify(profile)}];
    activeProfileId = ${JSON.stringify(profile.id)};
    applyThinkingLevelUI(${JSON.stringify(level)});
    const btn = document.getElementById('thinkingLevelBtn');
    const slider = document.getElementById('thinkingLevelSlider');
    const note = document.getElementById('thinkingSliderNote');
    return {
      level: btn.dataset.level,
      disabled: btn.disabled,
      label: document.getElementById('thinkingLevelLabel').textContent.trim(),
      sliderMax: Number(slider.max),
      topLevel: THINKING_LEVEL_ORDER[Number(slider.max)],
      sliderDisabled: slider.disabled,
      note: note.hidden ? '' : note.textContent.trim(),
    };
  })()`);

  const v4 = await probe({ id: 'p_v4', provider: 'openai', model: 'BLANK-deepseek-v4.1-flash', maxThinkingLevel: 'max', thinkingWire: 'levels' }, 'max');
  assert.equal(v4.disabled, false, 'V4 accepts a level');
  assert.equal(v4.level, 'max');
  assert.equal(v4.topLevel, 'max', 'every step up to max is reachable');
  assert.equal(v4.sliderDisabled, false);
  assert.equal(v4.label, '最大');
  assert.match(v4.note, /high \/ max/, 'the menu states the two values the gateway forwards');

  const preV4 = await probe({ id: 'p_ds', provider: 'openai', model: 'deepseek-reasoner', maxThinkingLevel: 'high', thinkingWire: 'model-decides' }, 'high');
  assert.equal(preV4.disabled, true, 'a level that is never sent cannot be chosen');
  assert.equal(preV4.label, '模型自定');
  assert.equal(preV4.sliderDisabled, true);
  assert.match(preV4.note, /自行决定/);

  const chat = await probe({ id: 'p_chat', provider: 'openai', model: 'gpt-4o', maxThinkingLevel: 'off', thinkingWire: 'unsupported' }, 'medium');
  assert.equal(chat.disabled, true);
  assert.equal(chat.label, '不适用');
  assert.match(chat.note, /没有思考档位/);

  // The old backend shape (no thinkingWire) still resolves locally.
  const legacy = await probe({ id: 'p_legacy', provider: 'openai', model: 'deepseek-v4.1-flash' }, 'ultra');
  assert.equal(legacy.disabled, false, 'a profile without the wire field still resolves from the model id');
  assert.equal(legacy.topLevel, 'max', 'ultra is clamped to the local max, not hidden');
  assert.equal(legacy.level, 'max');
});
