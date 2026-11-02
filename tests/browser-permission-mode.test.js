// The composer chip and the menu it opens must never disagree, and both must
// survive a document-wide i18n apply, a conversation switch and a locale change.
//
// Two defects made them drift:
//   1. the chip carried data-i18n="ui.31", so every IexaI18n.apply() rewrote it to
//      the static "帮我批准" while the menu kept the real mode;
//   2. the label table was computed once at load time, so switching to English
//      re-synced the chip with Chinese strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

const EXPECT = {
  'zh-CN': { plan: '仅规划（只读）', ask: '请求批准', risk: '帮我批准', full: '完全访问权限' },
  en: { plan: 'Plan only (read-only)', ask: 'Ask for approval', risk: 'Approve for me', full: 'Full access' },
};

test('real browser: the permission chip follows its menu through apply, session switches and locale changes', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-permmode-'));
  const workspace = path.join(dir, 'workspace');
  const at = Date.now();
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [
      { id: 'sess_perm_one', title: '会话一', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' },
      { id: 'sess_perm_two', title: '会话二', titleSource: 'message', created: at - 60_000, updated: at - 60_000, messageCount: 2, projectRoot: '', projectName: '无项目' },
    ],
  }));
  for (const id of ['sess_perm_one', 'sess_perm_two']) {
    fs.writeFileSync(path.join(workspace, '.iexa-sessions', id + '.json'), JSON.stringify([
      { role: 'user', content: '你好', timestamp: at },
      { role: 'assistant', content: '你好。', status: 'done', timestamp: at + 900, durationMs: 800 },
    ]));
  }
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 200));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 200; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  const read = () => evaluate(`(() => {
    const checked = [...document.querySelectorAll('#permissionModeMenu [data-permission-menu-mode]')]
      .filter((button) => button.getAttribute('aria-checked') === 'true')
      .map((button) => button.dataset.permissionMenuMode);
    return {
      label: document.getElementById('permissionModeLabel').textContent.trim(),
      checked,
      chip: document.getElementById('permissionModeBtn').dataset.permissionMode || null,
    };
  })()`);
  const expectMode = async (label, mode, locale = 'zh-CN') => {
    const state = await read();
    assert.deepEqual(state.checked, [mode], label + ': menu checkmark');
    assert.equal(state.chip, mode, label + ': button dataset');
    assert.equal(state.label, EXPECT[locale][mode], label + ': chip text');
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.readyState === 'complete' && typeof setPermissionMode === 'function' && typeof loadPermissionMode === 'function'");
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await evaluate("void setPermissionMode('full'); true");
  await new Promise((resolve) => setTimeout(resolve, 700));
  await expectMode('after choosing full', 'full');

  // The original regression: a document-wide apply used to overwrite the chip.
  await evaluate('IexaI18n.apply(document); true');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await expectMode('after a full i18n apply', 'full');

  await evaluate("void switchSession('sess_perm_two'); true");
  await new Promise((resolve) => setTimeout(resolve, 1400));
  await expectMode('after switching to the second conversation', 'full');
  await evaluate("void switchSession('sess_perm_one'); true");
  await new Promise((resolve) => setTimeout(resolve, 1400));
  await expectMode('after switching back', 'full');

  await evaluate("IexaI18n.setLocale('en'); true");
  await new Promise((resolve) => setTimeout(resolve, 800));
  await expectMode('in English', 'full', 'en');
  await evaluate("IexaI18n.setLocale('zh-CN'); true");
  await new Promise((resolve) => setTimeout(resolve, 600));
  await expectMode('back in Chinese', 'full');

  // Every mode round-trips, not just full.
  for (const mode of ['plan', 'ask', 'risk', 'full']) {
    await evaluate(`void setPermissionMode('${mode}'); true`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expectMode('mode ' + mode, mode);
  }

  assert.equal((await evaluate("fetch('/api/permissions/mode').then(r => r.json())")).mode, 'full',
    'the last choice is persisted on the server');
});
