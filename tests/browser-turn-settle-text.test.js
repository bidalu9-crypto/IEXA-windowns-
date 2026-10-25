// A finished turn must read as one line plus its answer. Commentary that the
// model streamed between tool calls is part of the work, not the reply: leaving
// it in the transcript made a settled turn look like a wall of narration with the
// answer buried at the bottom.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a settled turn folds its commentary and keeps the answer', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-settle-'));
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
    for (let index = 0; index < 120; index++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof sendMessage === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");

  // Two turns: one with commentary around a tool, one plain answer.
  await evaluate(String.raw`(() => {
    window.__realFetch = window.fetch;
    window.__pushChat = null;
    window.fetch = async (input, init) => {
      if (String(input) === '/api/chat') {
        const body = JSON.parse(init.body || '{}');
        const withTool = String(body.message || '').includes('WITH_TOOL');
        return new Response(new ReadableStream({
          start(controller) {
            const send = (frame) => controller.enqueue(new TextEncoder().encode(frame));
            window.__pushChat = send;
            send('event: turn_started\ndata: {"thinkingLevel":"medium"}\n\n');
            if (withTool) {
              send('event: text\ndata: ' + JSON.stringify({ content: '我先看一下现有的引用。' }) + '\n\n');
              send('event: tool_start\ndata: ' + JSON.stringify({ id: 't1', name: 'grep' }) + '\n\n');
              send('event: tool_complete\ndata: ' + JSON.stringify({ id: 't1', name: 'grep', args: { pattern: 'logo' } }) + '\n\n');
              send('event: tool_result\ndata: ' + JSON.stringify({ id: 't1', output: 'a.png\nb.png', success: true }) + '\n\n');
              send('event: text\ndata: ' + JSON.stringify({ content: '我先看一下现有的引用。\n\n## 结论\n\n两张图需要替换。' }) + '\n\n');
            } else {
              send('event: text\ndata: ' + JSON.stringify({ content: '直接回答，没有工具。' }) + '\n\n');
            }
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return window.__realFetch(input, init);
    };
  })()`);

  // --- turn with commentary -------------------------------------------------
  await evaluate("chatInput.value = 'WITH_TOOL 处理一下'; void sendMessage(); true");
  await wait("typeof window.__pushChat === 'function' && isProcessing === true");
  await new Promise((r) => setTimeout(r, 300));
  await evaluate("window.__pushChat('event: done\\ndata: {}\\n\\n'); true");
  await wait("isProcessing === false && !!document.querySelector('.message.assistant .turn-summary')");
  await new Promise((r) => setTimeout(r, 300));

  const settled = await evaluate(`(() => {
    const msg = [...document.querySelectorAll('.message.assistant')].pop();
    const blocks = [...msg.querySelectorAll('.message-content')];
    const bar = msg.querySelector('.turn-summary');
    return {
      blocks: blocks.length,
      texts: blocks.map((b) => b.textContent.trim().slice(0, 20)),
      hidden: blocks.map((b) => b.classList.contains('turn-activity-hidden')),
      collapsed: msg.classList.contains('is-activity-collapsed'),
      expanded: bar.getAttribute('aria-expanded'),
      label: bar.textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  assert.equal(settled.blocks, 2, 'commentary and answer are separate blocks');
  assert.equal(settled.hidden[0], true, 'the commentary folds away');
  assert.equal(settled.hidden[1], false, 'the answer stays in the transcript');
  assert.match(settled.texts[1], /结论/, 'the visible block is the reply');
  assert.equal(settled.collapsed, true);
  assert.equal(settled.expanded, 'false');
  assert.match(settled.label, /次调用/, 'the bar still reports the tool count');

  // Expanding restores the commentary in place, without touching the answer.
  await evaluate("document.querySelector('.message.assistant .turn-summary').click(); true");
  await wait("document.querySelector('.message.assistant').classList.contains('is-activity-collapsed') === false");
  const expanded = await evaluate(`(() => {
    const msg = [...document.querySelectorAll('.message.assistant')].pop();
    const blocks = [...msg.querySelectorAll('.message-content')];
    return { hidden: blocks.map((b) => b.classList.contains('turn-activity-hidden')), count: blocks.length };
  })()`);
  assert.deepEqual(expanded.hidden, [false, false], 'expanding brings the commentary back');
  assert.equal(expanded.count, 2, 'and does not duplicate anything');

  // --- plain answer ---------------------------------------------------------
  await evaluate("chatInput.value = 'PLAIN 你好'; void sendMessage(); true");
  await wait("typeof window.__pushChat === 'function' && isProcessing === true");
  await new Promise((r) => setTimeout(r, 300));
  await evaluate("window.__pushChat('event: done\\ndata: {}\\n\\n'); true");
  await wait("isProcessing === false");
  await new Promise((r) => setTimeout(r, 300));

  const plain = await evaluate(`(() => {
    const msg = [...document.querySelectorAll('.message.assistant')].pop();
    return { summary: !!msg.querySelector('.turn-summary'), text: msg.textContent };
  })()`);
  assert.equal(plain.summary, false, 'a turn without activity gets no summary bar');
  assert.match(plain.text, /直接回答/, 'and its answer stays visible');
});
