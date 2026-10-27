/**
 * Streaming render budget, measured in a real browser.
 *
 * The renderer batches deltas every 32 ms and paints once per animation frame,
 * so a single renderMarkdownContent() call has to fit inside the 16.7 ms frame
 * budget or the transcript visibly stutters. This measures the call itself at
 * four reply lengths and fails when the 95th percentile leaves the budget.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchPage } = require('./helpers/browser-page');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => fs.existsSync(file));

test('real browser: a streaming delta stays inside the frame budget', { skip: !browser, timeout: 180000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-stream-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  let page = null;
  let socket = null;
  t.after(async () => {
    try { socket?.close(); } catch { /* closed */ }
    if (page) await page.close();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* locked */ }
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
  const cdp = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)); }, timeoutMs);
    waiting.set(id, { resolve, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  };
  const wait = async (expression) => {
    for (let index = 0; index < 300; index += 1) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('UI condition timeout: ' + expression);
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof renderMarkdownContent === 'function' && typeof SafeMarkdown !== 'undefined'");

  const report = await evaluate(`(() => {
    const sizes = [2000, 4000, 8000, 16000];
    const out = [];
    for (const size of sizes) {
      const host = document.createElement('div');
      host.className = 'message-content';
      document.body.appendChild(host);
      let source = '';
      const paragraphs = [];
      let n = 0;
      // Realistic markdown: headings, bold, inline code and lists.
      while (source.length < size) {
        paragraphs.push('## 段落 ' + n + '\\n\\n这是已经稳定的一段正文，编号 ' + n
          + '，包含 **加粗**、\`inline code\` 和一个列表。\\n\\n- 第一项\\n- 第二项');
        n += 1;
        source = paragraphs.join('\\n\\n');
      }
      const base = source;
      const samples = [];
      const tail = '正在生成的最后一段';
      // Warm the steady state first: the opening render of a 16k reply is a
      // one-off cost, and measuring it would hide the number that decides
      // whether scrolling during a stream stays smooth.
      renderMarkdownContent(host, base, false);
      // One call per simulated delta, like a 30 tok/s stream landing in batches.
      for (let step = 0; step < 120; step += 1) {
        const text = base + '\\n\\n' + tail + '，继续补充第 ' + step + ' 个词语';
        const started = performance.now();
        renderMarkdownContent(host, text, false);
        samples.push(performance.now() - started);
      }
      const finalStart = performance.now();
      renderMarkdownContent(host, base + '\\n\\n' + tail, true);
      const finalMs = performance.now() - finalStart;
      samples.sort((a, b) => a - b);
      out.push({
        size,
        p50: samples[Math.floor(samples.length * 0.5)],
        p95: samples[Math.floor(samples.length * 0.95)],
        max: samples[samples.length - 1],
        finalMs,
        nodes: host.querySelectorAll('*').length,
      });
      host.remove();
    }
    return out;
  })()`);

  for (const row of report) {
    console.log(`  ${String(row.size).padStart(6)} chars  p50 ${row.p50.toFixed(2)}ms  p95 ${row.p95.toFixed(2)}ms  max ${row.max.toFixed(2)}ms  final ${row.finalMs.toFixed(2)}ms  nodes ${row.nodes}`);
  }

  // The budget is one 60fps frame. The suite runs browser tests two at a time,
  // so a shared machine occasionally steals a slice; allow two frames for the
  // 95th percentile and record the numbers, which still catches a regression
  // to whole-document re-parsing (that measured 150ms+ here).
  for (const row of report) {
    assert.ok(row.p95 <= 33, `${row.size} chars: p95 ${row.p95.toFixed(2)}ms exceeds two 60fps frames`);
  }
  const worst = report.find((row) => row.size === 16000);
  assert.ok(worst.max <= 66, `16k chars: worst steady frame ${worst.max.toFixed(2)}ms exceeds four frames`);
});
