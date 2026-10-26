// A picture the model showed is a deliverable, not activity. When a turn settles,
// the tool rail folds — and the artifact card used to be a child of that rail, so
// the image vanished together with it. The final summary could never show an image.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a shown image survives the turn settling', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-artifacts-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_artifacts';
  const at = Date.now() - 60_000;

  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'attachments'), { recursive: true });
  // A real image on disk: the card removes itself when its bytes fail to load,
  // which would hide the very regression this test is about.
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 210, g: 90, b: 70 } } })
    .png().toFile(path.join(workspace, 'attachments', 'probe.png'));

  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '出图', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify([
    { role: 'user', content: '生成一张图并给我看', timestamp: at },
    {
      role: 'assistant', content: '已经生成好了。', status: 'done', timestamp: at + 4000, durationMs: 4000,
      toolCalls: [{
        id: 'call_display', name: 'display_file',
        args: { tool_title: '展示生成的图片', path: 'attachments/probe.png' },
        result: {
          success: true, output: 'displayed', durationMs: 40,
          artifacts: [{ path: 'attachments/probe.png', kind: 'image', mimeType: 'image/png' }],
        },
      }],
    },
  ]));
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  const proc = spawn(browser, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* windows lock */ }
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
    proc.stderr.on('data', (data) => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 8000);
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
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId");
  await evaluate(`void switchSession('${sessionId}'); true`);
  await wait("document.querySelectorAll('#chatMessages .message').length === 2");
  await wait("!!document.querySelector('#chatMessages .tool-artifacts img')");
  // The image has to finish loading before visibility means anything.
  await wait("document.querySelector('#chatMessages .tool-artifacts img').complete");
  await new Promise((r) => setTimeout(r, 400));

  const state = await evaluate(`(() => {
    const card = document.querySelector('#chatMessages .tool-artifacts');
    const image = card.querySelector('img');
    const box = image.getBoundingClientRect();
    return {
      settled: !!document.querySelector('#chatMessages .message.is-activity-settled'),
      collapsed: !!document.querySelector('#chatMessages .message.is-activity-collapsed'),
      cardDisplay: getComputedStyle(card).display,
      imageHeight: Math.round(box.height),
      imageWidth: Math.round(box.width),
      insideHidden: !!card.closest('.turn-activity-hidden'),
      insideRail: !!card.closest('.tool-steps'),
      naturalWidth: image.naturalWidth,
    };
  })()`);

  assert.equal(state.settled, true, 'the turn is folded');
  assert.equal(state.collapsed, true, 'and folded shut by default');
  assert.equal(state.insideHidden, false, 'the deliverable is not inside the folded region');
  assert.equal(state.insideRail, false, 'it lives beside the rail, not inside it');
  assert.equal(state.cardDisplay, 'flex', 'the artifact card stays laid out');
  assert.ok(state.imageHeight >= 40 && state.imageWidth >= 40,
    `the image is actually rendered (${state.imageWidth}x${state.imageHeight})`);
  assert.equal(state.naturalWidth, 64, 'and its bytes loaded');

  // Expanding restores the rail without duplicating the image.
  await evaluate("document.querySelector('#chatMessages .turn-summary').click(); true");
  await new Promise((r) => setTimeout(r, 350));
  const expanded = await evaluate(`(() => ({
    hiddenRails: document.querySelectorAll('#chatMessages .turn-activity-hidden').length,
    images: document.querySelectorAll('#chatMessages .tool-artifacts img').length,
    visible: document.querySelectorAll('#chatMessages .tool-artifacts img').length > 0
      && getComputedStyle(document.querySelector('#chatMessages .tool-artifacts')).display !== 'none',
  }))()`);
  assert.equal(expanded.hiddenRails, 0, 'expanding shows the rail again');
  assert.equal(expanded.images, 1, 'the image is not duplicated');
  assert.equal(expanded.visible, true, 'and remains visible');

  // Collapsing again must not take it away either.
  await evaluate("document.querySelector('#chatMessages .turn-summary').click(); true");
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#chatMessages .tool-artifacts')).display !== 'none'"), true,
    'folding again keeps the deliverable visible');
});
