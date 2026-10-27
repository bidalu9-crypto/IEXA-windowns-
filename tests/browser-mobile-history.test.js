'use strict';
// Mobile transcript: a long conversation must not be built into the DOM in one
// pass. Phones render a bounded window of recent messages and graft earlier
// chunks on demand; desktop keeps rendering everything.
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

const LONG_MESSAGES = 200;   // 100 turns
const SHORT_MESSAGES = 4;

function buildSession(count) {
  const now = Date.now();
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    const at = now - (count - index) * 60_000;
    if (index % 2 === 0) {
      messages.push({ role: 'user', content: `第 ${index / 2 + 1} 轮提问`, timestamp: at });
      continue;
    }
    messages.push({
      role: 'assistant',
      content: `回答 ${(index + 1) / 2}\n\n\`\`\`js\nconst v = ${index};\n\`\`\``,
      thinking: `推理 ${index}`,
      thinkingLevel: 'medium',
      timestamp: at,
      durationMs: 1200,
      status: 'done',
      usage: { inputTokens: 1000 + index, outputTokens: 100 },
      toolCalls: [{
        id: `c_${index}`, name: 'file_read',
        args: { tool_title: `读取 ${index}`, path: `a${index}.ts` },
        result: { success: true, output: 'ok' },
      }],
    });
  }
  return messages;
}

test('real browser: mobile window keeps the DOM bounded and loads earlier chunks', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-mobile-history-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });

  const long = buildSession(LONG_MESSAGES);
  const short = buildSession(SHORT_MESSAGES);
  const now = Date.now();
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: 'sess_short',
    sessions: [
      { id: 'sess_short', title: '短对话', created: now, updated: now, messageCount: short.length, projectRoot: '', projectName: '无项目' },
      { id: 'sess_long', title: '长对话', created: now - 1000, updated: now - 1000, messageCount: long.length, projectRoot: '', projectName: '无项目' },
    ],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_short.json'), JSON.stringify(short));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', 'sess_long.json'), JSON.stringify(long));
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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
    return result.result?.result?.value;
  }
  async function wait(expression) {
    for (let index = 0; index < 200; index += 1) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof switchSession === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");

  // The renderer only windows the transcript for paired devices. Force the
  // marker the bridge would have set, then open the long conversation.
  await evaluate("document.body.dataset.mobileClient = 'paired'; true");
  await evaluate("void switchSession('sess_long'); true");
  await wait("document.querySelectorAll('#chatMessages .message').length > 0");
  await new Promise((r) => setTimeout(r, 600));

  const parked = await evaluate(`(() => {
    const root = document.getElementById('chatMessages');
    const messages = [...root.querySelectorAll('.message')];
    const indices = messages.map((el) => Number(el.dataset.messageIndex));
    const button = root.querySelector('.load-earlier-messages');
    return {
      rendered: messages.length,
      domNodes: root.querySelectorAll('*').length,
      indices,
      contiguous: indices.every((value, i) => i === 0 || value === indices[i - 1] + 1),
      unique: new Set(indices).size === indices.length,
      firstIndex: indices[0],
      lastIndex: indices[indices.length - 1],
      hasButton: Boolean(button),
      buttonText: button ? button.textContent : null,
      buttonAbove: button ? button === root.firstElementChild : null,
      scrollHeight: root.scrollHeight,
    };
  })()`);

  assert.equal(parked.rendered, 60, 'mobile renders only the recent window');
  assert.equal(parked.lastIndex, LONG_MESSAGES - 1, 'the window ends at the newest message');
  assert.equal(parked.firstIndex, LONG_MESSAGES - 60, 'and starts 60 messages back');
  assert.equal(parked.contiguous, true, 'the window is a contiguous range');
  assert.equal(parked.unique, true, 'no message is rendered twice');
  assert.ok(parked.domNodes < 9000, 'the DOM stays bounded: ' + parked.domNodes + ' nodes');
  assert.equal(parked.hasButton, true, 'older messages are reachable');
  assert.match(parked.buttonText, /还有 140 条/);
  assert.equal(parked.buttonAbove, true, 'the affordance sits at the top');

  // Loading an earlier chunk must not move what the reader is looking at.
  const anchored = await evaluate(`(() => {
    const root = document.getElementById('chatMessages');
    root.scrollTop = 400;
    const probe = [...root.querySelectorAll('.message')].find((el) => el.getBoundingClientRect().top >= root.getBoundingClientRect().top);
    return { index: Number(probe.dataset.messageIndex), offset: Math.round(probe.getBoundingClientRect().top - root.getBoundingClientRect().top), scrollTop: root.scrollTop };
  })()`);

  await evaluate("document.querySelector('.load-earlier-messages').click(); true");
  await wait("document.querySelectorAll('#chatMessages .message').length >= 100");
  await new Promise((r) => setTimeout(r, 300));

  const extended = await evaluate(`(() => {
    const root = document.getElementById('chatMessages');
    const messages = [...root.querySelectorAll('.message')];
    const indices = messages.map((el) => Number(el.dataset.messageIndex));
    const probe = messages.find((el) => Number(el.dataset.messageIndex) === ${anchored.index});
    const button = root.querySelector('.load-earlier-messages');
    return {
      rendered: messages.length,
      indices,
      contiguous: indices.every((value, i) => i === 0 || value === indices[i - 1] + 1),
      unique: new Set(indices).size === indices.length,
      anchorOffset: probe ? Math.round(probe.getBoundingClientRect().top - root.getBoundingClientRect().top) : null,
      buttonText: button ? button.textContent : null,
    };
  })()`);

  assert.equal(extended.rendered, 100, 'the chunk is prepended on demand');
  assert.equal(extended.indices[0], LONG_MESSAGES - 100);
  assert.equal(extended.contiguous, true, 'prepending keeps the order');
  assert.equal(extended.unique, true, 'prepending does not duplicate messages');
  assert.ok(Math.abs(extended.anchorOffset - anchored.offset) <= 2,
    `the reader keeps their place: ${anchored.offset} → ${extended.anchorOffset}`);
  assert.match(extended.buttonText, /还有 100 条/);

  // Switching away removes the affordance with the transcript.
  await evaluate("void switchSession('sess_short'); true");
  await wait("document.querySelectorAll('#chatMessages .message').length === " + SHORT_MESSAGES);
  assert.equal(await evaluate("!!document.querySelector('.load-earlier-messages')"), false,
    'a short conversation has no affordance');

  // Desktop parity, on a cold page load: the default client is desktop, so the
  // same conversation must render in full with no affordance. A reload is used
  // because switchSession mounts a cached transcript instead of re-rendering.
  await evaluate("document.body.dataset.mobileClient = 'desktop'; true");
  // Mark the outgoing document: after Page.reload the old globals are still
  // visible for a moment, so a bare `typeof switchSession` wait can pass on the
  // document that is about to be replaced.
  await evaluate("window.__beforeReload = true; true");
  await cdp('Page.reload');
  await wait("!window.__beforeReload && typeof switchSession === 'function' && typeof currentSessionId !== 'undefined' && currentSessionId");
  await evaluate("void switchSession('sess_long'); true");
  await wait("document.querySelectorAll('#chatMessages .message').length === " + LONG_MESSAGES);
  assert.equal(await evaluate("!!document.querySelector('.load-earlier-messages')"), false,
    'desktop renders the whole history and needs no affordance');
  assert.equal(await evaluate("document.querySelectorAll('#chatMessages .message')[0].dataset.messageIndex"), '0');
});
