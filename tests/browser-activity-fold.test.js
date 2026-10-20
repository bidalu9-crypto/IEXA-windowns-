const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: live reasoning and its rail stay open until the next step', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-activity-fold-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
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
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }
  const frame = (event, data) => `${JSON.stringify({ event, data })}`;

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof sendMessage === 'function' && typeof currentSessionId !== 'undefined'");
  await wait("currentSessionId");
  // The compact rail only exists as a feature when the setting is on.
  await evaluate("applyConsecutiveToolFoldSetting(true); true");

  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input) === '/api/chat') {
        return new Response(new ReadableStream({
          start(controller) {
            window.__pushChat = (text) => controller.enqueue(new TextEncoder().encode(text));
            controller.enqueue(new TextEncoder().encode('event: turn_started\ndata: {"thinkingLevel":"medium"}\n\n'));
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);

  await evaluate("chatInput.value='progressive fold'; void sendMessage(); true");
  await wait("isProcessing === true && typeof window.__pushChat === 'function'");

  // 1. Reasoning streams expanded so the user can read it.
  await evaluate(`window.__pushChat(${JSON.stringify('event: thinking\ndata: {"content":"第一段思考"}\n\n')}); true`);
  await wait("document.querySelectorAll('.thinking-block').length === 1 && document.querySelector('.thinking-block').open === true");

  // 2. The first tool call closes reasoning and opens its rail.
  await evaluate(`window.__pushChat(${JSON.stringify('event: tool_start\ndata: {"id":"t1","name":"file_read"}\n\n')}); true`);
  await wait("document.querySelector('.thinking-block').open === false");
  await wait("document.querySelector('.tool-steps') && document.querySelector('.tool-steps').dataset.autoOpen === 'true'");
  assert.equal(await evaluate("document.querySelector('.tool-steps').classList.contains('is-collapsed')"), false,
    'a running rail must be expanded');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.tool-block')).display !== 'none'"), true,
    'the tool capsule is still hidden inside a folded rail');
  await evaluate(`window.__pushChat(${JSON.stringify('event: tool_complete\ndata: {"id":"t1","name":"file_read","args":{"path":"a.ts"}}\n\n')}); true`);
  await evaluate(`window.__pushChat(${JSON.stringify('event: tool_result\ndata: {"id":"t1","output":"ok","success":true,"executionStatus":"completed"}\n\n')}); true`);

  // 3. New reasoning folds the finished rail and shows itself.
  await evaluate(`window.__pushChat(${JSON.stringify('event: thinking\ndata: {"content":"第二段思考"}\n\n')}); true`);
  await wait("document.querySelectorAll('.thinking-block').length === 2 && document.querySelectorAll('.thinking-block')[1].open === true");
  assert.equal(await evaluate("document.querySelectorAll('.tool-steps')[0].classList.contains('is-collapsed')"), true,
    'reasoning must fold the rail it superseded');

  // 4. The next tool opens a fresh rail in its real position.
  await evaluate(`window.__pushChat(${JSON.stringify('event: tool_start\ndata: {"id":"t2","name":"grep"}\n\n')}); true`);
  await wait("document.querySelectorAll('.tool-steps').length === 2");
  await wait("document.querySelectorAll('.tool-steps')[1].dataset.autoOpen === 'true'");
  assert.equal(await evaluate("document.querySelectorAll('.thinking-block')[1].open"), false);
  assert.equal(await evaluate("document.querySelectorAll('.tool-steps')[1].classList.contains('is-collapsed')"), false);

  // 5. Answer text folds the last rail.
  await evaluate(`window.__pushChat(${JSON.stringify('event: text\ndata: {"content":"最终回答"}\n\n')}); true`);
  await wait("document.querySelectorAll('.tool-steps')[1].classList.contains('is-collapsed') === true");

  // 6. A user's explicit click wins over the automatic rule.
  await evaluate("document.querySelectorAll('.task-summary')[1].click(); true");
  assert.equal(await evaluate("document.querySelectorAll('.tool-steps')[1].classList.contains('is-collapsed')"), false);
  await evaluate(`window.__pushChat(${JSON.stringify('event: thinking\ndata: {"content":"第三段思考"}\n\n')}); true`);
  await wait("document.querySelectorAll('.thinking-block').length === 3");
  assert.equal(await evaluate("document.querySelectorAll('.tool-steps')[1].classList.contains('is-collapsed')"), false,
    'an explicitly opened rail must stay open');

  // 7. A manually folded reasoning block is not reopened by later deltas.
  await evaluate("(() => { const block = document.querySelectorAll('.thinking-block')[2]; block.open = true; block.querySelector('summary').click(); return true; })()");
  await wait("document.querySelectorAll('.thinking-block')[2].open === false");
  await evaluate(`window.__pushChat(${JSON.stringify('event: thinking\ndata: {"content":"继续思考"}\n\n')}); true`);
  await wait("document.querySelectorAll('.thinking-block')[2]._reasoning.includes('继续思考')");
  assert.equal(await evaluate("document.querySelectorAll('.thinking-block')[2].open"), false,
    'a user who collapsed live reasoning should not have it forced open');

  await evaluate(`window.__pushChat(${JSON.stringify('event: done\ndata: {"stopReason":"endTurn"}\n\n')}); true`);
  await wait("isProcessing === false");
  assert.equal(await evaluate("[...document.querySelectorAll('.tool-steps')].every(host => host.dataset.autoOpen !== 'true')"), true,
    'a finished turn leaves no rail waiting for a successor');
});
