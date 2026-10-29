// Real browser check for the provider avatars: the settings page must draw the
// vendor's own mark inside each profile tile, and a gateway registered as
// "openai" must still wear the model vendor (DeepSeek, Qwen, …).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const PROFILES = [
  { id: 'p1', name: 'Senova-6.8-flash-lite', provider: 'openai', model: 'senova-6.8-flash-lite', baseURL: 'https://token.senova.cn' },
  { id: 'p2', name: 'Agnes-3.0-flash', provider: 'openai', model: 'agnes-3.0-flash', baseURL: 'https://apihub.agnes-ai.com' },
  { id: 'p3', name: 'EvanShine-deepseek-v4.1-flash', provider: 'openai', model: 'deepseek-v4.1-flash', baseURL: 'https://web2api.bilinb666.site' },
  { id: 'p4', name: 'Claude-opus-4-8', provider: 'anthropic', model: 'claude-opus-4-8', baseURL: 'https://hanzapi.cc.cd' },
  { id: 'p5', name: 'GPT-5-astra', provider: 'openai', model: 'gpt-5-astra', baseURL: 'http://38.175.201.172:8080' },
  { id: 'p6', name: 'Gemini-3-pro', provider: 'gemini', model: 'gemini-3.0-pro', baseURL: '' },
  { id: 'p7', name: 'Grok-4.1-fast', provider: 'xai', model: 'grok-4.1-fast', baseURL: '' },
  { id: 'p8', name: '本地网关', provider: 'custom', model: 'private-model', baseURL: 'http://10.0.0.5:8000' },
];

test('real browser: profile avatars wear the vendor mark', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-logos-'));
  const workspace = path.join(dir, 'workspace');
  const artifact = path.resolve('.iexa-artifacts', 'provider-logos');
  fs.mkdirSync(artifact, { recursive: true });
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 140; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined'");

  // Open 设置 and serve the fixture from the same-origin fetch the page uses.
  await evaluate(`document.querySelector('.nav-btn[data-view="settings"]').click(); true`);
  await evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (String(url).includes('/api/profiles')) {
        return Promise.resolve({ ok: true, json: async () => (${JSON.stringify({ profiles: PROFILES, activeProfileId: 'p4' })}) });
      }
      return original(url, options);
    };
    return true;
  })()`);
  await evaluate(`renderProfileList(); true`);
  await wait("document.querySelectorAll('#profileList .profile-card').length === 8");
  await new Promise((resolve) => setTimeout(resolve, 250));

  const cards = await evaluate(`Array.from(document.querySelectorAll('#profileList .profile-card')).map((card) => {
    const svg = card.querySelector('.profile-avatar svg');
    const box = card.querySelector('.profile-avatar').getBoundingClientRect();
    return {
      name: card.querySelector('.profile-card-name').textContent,
      provider: card.querySelector('.profile-provider-chip').textContent,
      logo: svg ? svg.getAttribute('data-provider') : null,
      path: svg ? (svg.querySelector('path')?.getAttribute('d') || '').length : 0,
      fallback: !!card.querySelector('.profile-avatar svg.ui-icon'),
      width: Math.round(box.width),
      height: Math.round(box.height),
      letter: !svg,
    };
  })`);

  const byName = Object.fromEntries(cards.map((c) => [c.name, c]));
  assert.equal(cards.length, 8);
  for (const card of cards) {
    if (card.logo) {
      assert.ok(card.path > 40, card.name + ' path has geometry (' + card.path + ')');
    } else {
      assert.equal(card.name, '本地网关', 'only an unknown vendor falls back to the neutral glyph');
      assert.equal(card.fallback, true, 'the fallback is still a real glyph, never a bare letter');
    }
    assert.equal(card.width, 30);
    assert.equal(card.height, 30);
  }
  assert.equal(byName['EvanShine-deepseek-v4.1-flash'].logo, 'deepseek', 'gateway shows the model vendor');
  assert.equal(byName['EvanShine-deepseek-v4.1-flash'].provider, 'openai');
  assert.equal(byName['Claude-opus-4-8'].logo, 'anthropic');
  assert.equal(byName['GPT-5-astra'].logo, 'openai');
  assert.equal(byName['Gemini-3-pro'].logo, 'gemini');
  assert.equal(byName['Grok-4.1-fast'].logo, 'xai');
  assert.equal(byName['本地网关'].logo, null, 'an unknown gateway keeps the neutral sprite glyph');
  assert.equal(byName['本地网关'].letter, false);

  // Distinct vendors must not collapse to the same shape.
  const shapes = await evaluate(`Array.from(document.querySelectorAll('#profileList .profile-avatar svg path')).map((p) => p.getAttribute('d').slice(0, 60))`);
  assert.ok(new Set(shapes).size >= 5, 'vendors have distinct glyphs: ' + new Set(shapes).size);

  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme='${theme}'; document.querySelector('#profileList').scrollIntoView({block:'center'}); true`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(artifact, 'avatars-' + theme + '.png'), Buffer.from(shot.result.data, 'base64'));
  }
  await evaluate(`document.documentElement.dataset.theme='dark'; true`);
});
