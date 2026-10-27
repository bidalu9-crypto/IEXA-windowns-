// The renderer half of "continue after a restart": an interrupted turn must
// surface a banner, and 继续 must ask the server to continue that same turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: an interrupted turn offers 继续 and asks for a continuation', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-interrupted-ui-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_interrupted_ui';
  const at = Date.now() - 120_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '被中断的任务', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }), 'utf8');
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${sessionId}.json`), JSON.stringify([
    { role: 'user', content: '把登录页的错误提示改成行内显示', timestamp: at },
    {
      role: 'assistant', content: '我先看一下登录页。', status: 'running', timestamp: at + 500,
      toolCalls: [
        { id: 'c1', name: 'file_read', args: { path: 'login.html' }, result: { output: 'ok', success: true } },
        { id: 'c2', name: 'file_read', args: { path: 'auth.ts' }, result: { output: 'ok', success: true } },
      ],
    },
  ]), 'utf8');
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
    await new Promise((r) => server.close(r));
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
    for (let index = 0; index < 120; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof currentSessionId !== 'undefined' && currentSessionId === '" + sessionId + "'");

  // The banner must describe the recovered turn, not a live pause.
  await wait("document.getElementById('pausedBanner')?.hidden === false");
  const banner = await evaluate(`(() => {
    const el = document.getElementById('pausedBanner');
    return {
      title: el.querySelector('strong').textContent,
      hint: el.querySelector('small').textContent,
      buttons: [...el.querySelectorAll('button')].map((b) => b.textContent),
      inputDisabled: document.getElementById('chatInput').disabled,
    };
  })()`);
  assert.equal(banner.title, '任务已中断');
  assert.match(banner.hint, /2 次工具结果/);
  assert.deepEqual(banner.buttons, ['结束任务', '继续']);
  assert.equal(banner.inputDisabled, true, 'a parked turn keeps the composer closed');

  // 继续 must ask the server to continue the stored turn, not resend the prompt.
  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.__chatBody = null;
    window.fetch = async (input, init) => {
      if (String(input) === '/api/chat') {
        window.__chatBody = JSON.parse(init.body || '{}');
        return new Response(new ReadableStream({
          start(controller) {
            window.__push = (frame) => controller.enqueue(new TextEncoder().encode(frame));
            controller.enqueue(new TextEncoder().encode('event: turn_started\ndata: {}\n\n'));
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);
  await evaluate("document.getElementById('pausedResume').click(); true");
  await wait("!!window.__chatBody");
  const body = await evaluate('window.__chatBody');
  assert.equal(body.continueTurn, true, 'the request asks to continue');
  assert.equal(body.message, '', 'no prompt is re-sent');
  assert.equal(body.sessionId, sessionId);
  await wait("document.getElementById('chatInput').disabled === false");
  assert.equal(await evaluate("document.getElementById('pausedBanner').hidden"), true, 'the banner clears once the turn is live again');

  await evaluate("window.__push('event: done\\ndata: {\"stopReason\":\"endTurn\"}\\n\\n'); true");
  await wait("isProcessing === false");
});
