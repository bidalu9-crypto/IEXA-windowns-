// Sharing has to produce something a person can paste or send: a valid JSON
// document, and a plain-text transcript that keeps the prompt and the reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: an exchange is shared as JSON and as plain text', { skip: !browser, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-share-'));
  const workspace = path.join(dir, 'workspace');
  const sessionId = 'sess_share_ui';
  const at = Date.now() - 60_000;
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: sessionId, title: '分享会话测试', titleSource: 'message', created: at, updated: at, messageCount: 2, projectRoot: 'E:\\IEXA-WIN', projectName: 'IEXA-WIN' }],
  }), 'utf8');
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${sessionId}.json`), JSON.stringify([
    { role: 'user', content: '把登录页的错误提示改成行内显示', timestamp: at },
    {
      role: 'assistant', content: '已改成行内提示，并补了单元测试。', status: 'done', timestamp: at + 5000,
      thinking: '先看登录页的结构，再决定提示放在哪。', thinkingLevel: 'medium',
      durationMs: 5120, generationMs: 3400,
      usage: { inputTokens: 12000, outputTokens: 320, cacheReadInputTokens: 9000 },
      toolCalls: [
        { id: 'c1', name: 'file_read', args: { path: 'src/login.html' }, result: { success: true, output: 'login form', durationMs: 120 } },
        { id: 'c2', name: 'file_edit', args: { path: 'src/login.html', old_string: 'alert(', new_string: 'inline(' }, result: { success: true, output: 'ok', durationMs: 40 } },
      ],
    },
  ]), 'utf8');
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
  await wait("!!document.querySelector('.message.assistant .assistant-message-action[data-action=\"share\"]')");

  // The button sits after 重新生成, which is where the screenshot pointed.
  assert.deepEqual(
    await evaluate(`Array.from(document.querySelectorAll('.message.assistant .assistant-message-action')).map((b) => b.dataset.action)`),
    ['translate', 'copy', 'retry', 'share', 'doc']);

  // Capture what the page would copy or download.
  await evaluate(`(() => {
    window.__clip = null;
    window.__download = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__clip = value; } },
    });
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__download = { name: this.download, href: this.href }; return; }
      return realClick.call(this);
    };
    return true;
  })()`);

  await evaluate("document.querySelector('.assistant-message-action[data-action=\"share\"]').click(); true");
  await wait("!!document.querySelector('.share-menu')");
  const menu = await evaluate(`(() => {
    const el = document.querySelector('.share-menu');
    const box = el.getBoundingClientRect();
    return {
      head: el.querySelector('.share-menu-head').textContent,
      items: [...el.querySelectorAll('[data-share]')].map((b) => b.dataset.share),
      labels: [...el.querySelectorAll('.share-menu-text strong')].map((n) => n.textContent),
      downloads: [...el.querySelectorAll('[data-download]')].map((b) => b.dataset.download),
      onScreen: box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      expanded: document.querySelector('.assistant-message-action[data-action="share"]').getAttribute('aria-expanded'),
    };
  })()`);
  assert.equal(menu.head, '分享这条回复');
  assert.deepEqual(menu.items, ['json', 'text'], 'two formats, as asked');
  assert.deepEqual(menu.labels, ['JSON 格式', '纯文本格式']);
  assert.deepEqual(menu.downloads, ['json', 'text']);
  assert.equal(menu.onScreen, true, 'the menu must stay inside the viewport');
  assert.equal(menu.expanded, 'true');

  // JSON: a valid document carrying the prompt, the reply and the tool calls.
  await evaluate("document.querySelector('.share-menu [data-share=\"json\"]').click(); true");
  await wait("!!window.__clip");
  const jsonText = await evaluate('window.__clip');
  const payload = JSON.parse(jsonText);
  assert.equal(payload.schema, 'iexa.conversation.share/1');
  assert.equal(payload.session.title, '分享会话测试');
  assert.equal(payload.session.project, 'IEXA-WIN');
  assert.equal(payload.exchange.prompt, '把登录页的错误提示改成行内显示');
  assert.equal(payload.exchange.reply.content, '已改成行内提示，并补了单元测试。');
  assert.equal(payload.exchange.reply.thinking, '先看登录页的结构，再决定提示放在哪。');
  assert.equal(payload.exchange.reply.toolCalls.length, 2);
  assert.equal(payload.exchange.reply.toolCalls[0].name, 'file_read');
  assert.match(payload.exchange.reply.toolCalls[1].args, /login\.html/);
  assert.equal(payload.exchange.reply.usage.inputTokens, 12000);
  assert.equal(payload.exchange.reply.usage.outputTokens, 320);
  assert.match(await evaluate("document.querySelector('.share-menu-status').textContent"), /已复制 JSON/);

  // Plain text: readable, with both sides of the exchange and the usage line.
  await evaluate("document.querySelector('.share-menu [data-share=\"text\"]').click(); true");
  await wait("window.__clip && window.__clip.includes('IEXA 对话分享')");
  const text = await evaluate('window.__clip');
  assert.match(text, /会话：分享会话测试/);
  assert.match(text, /项目：IEXA-WIN/);
  assert.match(text, /──── 用户 ────\n把登录页的错误提示改成行内显示/);
  assert.match(text, /\[思考\]\n先看登录页的结构/);
  assert.match(text, /\[工具调用\] 2 次/);
  assert.match(text, /1\. file_read/);
  assert.match(text, /──── 助手 ────/);
  assert.match(text, /已改成行内提示，并补了单元测试。/);
  assert.match(text, /\[用量\] 输入 12000 tokens · 输出 320 tokens/);
  assert.doesNotMatch(text, /\{"/, 'plain text must not leak JSON punctuation');

  // Download: the file name carries the session title and the right extension.
  await evaluate("document.querySelector('.share-menu [data-download=\"json\"]').click(); true");
  await wait("!!window.__download");
  const download = await evaluate('window.__download');
  assert.match(download.name, /^分享会话测试-.*\.json$/);
  assert.match(download.href, /^blob:/);

  // Esc closes and hands focus back to the button that opened it.
  await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  await wait("!document.querySelector('.share-menu')");
  assert.equal(await evaluate("document.querySelector('.assistant-message-action[data-action=\"share\"]').getAttribute('aria-expanded')"), 'false');
  assert.equal(await evaluate("document.activeElement?.dataset?.action"), 'share');
});
