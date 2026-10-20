'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x => fs.existsSync(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The served renderer must paint the prompt-cache receipt on both surfaces the
   user watches: the per-message usage line and the token-usage page. This runs
   the real app in headless Chrome against the real server, so it covers the
   exact files the desktop client serves from src/renderer. */
test('real browser: usage line and token page expose the cache receipt', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-usage-browser-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server'); const server = await backend.startServer(0, false); const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;
  const proc = spawn(browser, ['--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket; const exited = once(proc, 'exit');
  t.after(async () => { if (socket) { try { socket.close(); } catch {} } if (proc.exitCode === null) proc.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]); server.closeAllConnections(); await new Promise((r) => server.close(r)); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {} });

  const wsUrl = await new Promise((resolve, reject) => { let log = ''; const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 12000); proc.stderr.on('data', (d) => { log += d; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timeout); resolve(m[1]); } }); proc.once('error', reject); });
  const endpoint = new URL(wsUrl); const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl); await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let sequence = 0; const waiting = new Map();
  socket.onmessage = (event) => { const msg = JSON.parse(event.data); const entry = waiting.get(msg.id); if (entry) { clearTimeout(entry.timer); waiting.delete(msg.id); entry.resolve(msg); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { waiting.delete(id); reject(new Error('cdp timeout: ' + method)); }, 20000); waiting.set(id, { resolve, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 900)); return r.result && r.result.result ? r.result.result.value : undefined; };
  const wait = async (expression, ms = 20000) => { const started = Date.now(); for (;;) { if (await evaluate(expression)) return; if (Date.now() - started > ms) throw new Error('UI wait timeout: ' + expression); await sleep(150); } };

  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof renderMessageUsage === 'function' && document.body.dataset.mobileClient === 'desktop'", 30000);

  const handlers = await evaluate(`({ handleUsage: typeof handleUsage, pending: typeof renderPendingMessageUsage })`);
  assert.equal(handlers.handleUsage, 'function', 'live usage handler still present');
  assert.equal(handlers.pending, 'undefined', 'dead pending renderer fully removed');

  const liveLine = await evaluate(`(() => {
    const fake = document.createElement('div');
    fake.className = 'message assistant';
    fake.dataset.timestamp = String(Date.now());
    const footer = document.createElement('div');
    footer.className = 'assistant-message-footer';
    const actions = document.createElement('div');
    actions.className = 'assistant-message-actions';
    footer.appendChild(actions);
    fake.appendChild(footer);
    document.body.appendChild(fake);
    const prev = currentAssistantMsg;
    currentAssistantMsg = fake;
    handleUsage({ inputTokens: 111, outputTokens: 22, cacheReadInputTokens: 33 });
    const text = (fake.querySelector('.message-usage') || {}).textContent || '';
    currentAssistantMsg = prev;
    fake.remove();
    return text.replace(/\\s+/g, ' ').trim();
  })()`);
  assert.ok(liveLine.includes(`${(111).toLocaleString()} 入`), liveLine);
  assert.ok(liveLine.includes(`${(22).toLocaleString()} 出`), liveLine);
  assert.ok(liveLine.includes(`${(33).toLocaleString()} 缓存`), liveLine);

  const line = await evaluate(`(() => {
    const msg = document.createElement('div'); msg.className = 'message assistant'; msg.dataset.timestamp = String(Date.now());
    const el = document.createElement('div'); el.className = 'message-usage'; msg.appendChild(el); document.body.appendChild(msg);
    renderMessageUsage(el, 80739, 19398, 79104);
    const withCache = el.textContent.replace(/\\s+/g, ' ').trim();
    const withCacheHtml = el.innerHTML;
    renderMessageUsage(el, 123, 45);
    const withoutCache = el.textContent;
    renderMessageUsage(el, 59272, 19899, 0);
    const zero = el.textContent;
    renderMessageUsage(el, 132225, 1198, 131328);
    const big = el.textContent.replace(/\\s+/g, ' ').trim();
    const bigHtml = el.innerHTML;
    msg.dataset.generationMs = '8000';
    msg.dataset.generationRateVersion = '2';
    msg.dataset.firstTokenMs = '12400';
    renderMessageUsage(el, 1000, 380, 900);
    const rated = el.textContent.replace(/\\s+/g, ' ').trim();
    const ratedHtml = el.innerHTML;
    msg.dataset.generationMs = '200';
    renderMessageUsage(el, 1000, 380, 900);
    const tooFast = el.textContent.replace(/\\s+/g, ' ').trim();
    // Version 1 records divided output by prefill too; they must not print a rate.
    msg.dataset.generationMs = '8000';
    delete msg.dataset.generationRateVersion;
    delete msg.dataset.firstTokenMs;
    renderMessageUsage(el, 1000, 380, 900);
    const legacy = el.textContent.replace(/\\s+/g, ' ').trim();
    delete msg.dataset.generationMs;
    renderMessageUsage(el, 1000, 380, 900);
    const unrated = el.textContent.replace(/\\s+/g, ' ').trim();
    msg.remove();
    return { withCache, withCacheHtml, withoutCache, zero, big, bigHtml, rated, ratedHtml, tooFast, legacy, unrated };
  })()`);
  assert.ok(line.withCache.includes('80.7K 入'), line.withCache);
  assert.ok(line.withCache.includes('19.4K 出'), line.withCache);
  assert.ok(line.withCache.includes('79.1K 缓存'), line.withCache);
  assert.ok(!/\d,\d{3}/.test(line.withCache), 'the painted line carries no digit-grouped counts: ' + line.withCache);
  assert.ok(line.withCacheHtml.includes('title="输入 80,739 tokens"'), 'exact value stays in the title: ' + line.withCacheHtml);
  assert.ok(!line.withoutCache.includes('缓存'), line.withoutCache);
  assert.ok(line.zero.includes('0 缓存'), line.zero);
  assert.ok(line.big.includes('132K 入') && line.big.includes('1.2K 出') && line.big.includes('131K 缓存'), line.big);
  assert.ok(line.bigHtml.includes('title="缓存读取 131,328 tokens（占输入 99%）"'), line.bigHtml);
  assert.ok(line.rated.includes('48 tok/s'), '380 tokens over 8s reads as 48 tok/s: ' + line.rated);
  assert.ok(line.rated.includes('缓存'), 'the rate follows the cache receipt: ' + line.rated);
  assert.ok(line.ratedHtml.includes('title="生成 380 tokens，解码 8.0 秒；首字等待合计 12.4 秒（预填充，不计入）"'),
    'the tooltip separates decode time from prefill: ' + line.ratedHtml);
  assert.ok(!line.tooFast.includes('tok/s'), 'sub-second receipts do not invent a rate: ' + line.tooFast);
  assert.ok(!line.legacy.includes('tok/s'), 'version 1 timings cannot produce an honest rate: ' + line.legacy);
  assert.ok(!line.unrated.includes('tok/s'), 'a turn without provider timing stays unchanged: ' + line.unrated);
  assert.ok(line.bigHtml.includes('(99%)'), 'the share is written after the label: ' + line.bigHtml);

  const tokenHtml = await evaluate(`(() => {
    tokenUsageRecords = [
      { model: 'fixture-cache', provider: 'openai', inputTokens: 296680, outputTokens: 100, requests: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 295680, estimatedCostUsd: null, updatedAt: Date.now() },
      { model: 'fixture-zero', provider: 'openai', inputTokens: 10, outputTokens: 1, requests: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: null, updatedAt: Date.now() - 500 },
    ];
    renderTokenUsage();
    return document.getElementById('tokenUsageList').innerHTML;
  })()`);
  assert.equal((tokenHtml.match(/<span>缓存<\/span>/g) || []).length, 2, tokenHtml.slice(0, 400));
  assert.ok(tokenHtml.includes('<span>缓存</span><strong>296K</strong>'), tokenHtml.slice(0, 400));
  assert.ok(tokenHtml.includes('<span>缓存</span><strong>0</strong>'), tokenHtml.slice(0, 400));
  assert.ok(tokenHtml.includes('<small class="token-usage-model-pct">100%</small>'), tokenHtml.slice(0, 500));
  assert.ok(tokenHtml.includes('<small class="token-usage-model-pct">0%</small>'), tokenHtml.slice(0, 500));

  /* The elapsed counter is the only part of this line that has to be alive:
     it must appear on the first paint, advance while the turn streams, and
     stop for good once the reply is finalized. */
  const timer = await evaluate(`(async () => {
    const startedAt = Date.now();
    const msg = addMessage('assistant', '', undefined, { streaming: true, turnStartedAt: startedAt });
    const node = msg.querySelector('.message-usage-duration');
    const firstText = node ? node.textContent.replace(/\\s+/g, ' ').trim() : '';
    const running = !!node && node.classList.contains('is-running');
    const tokensBeforeUsage = msg.querySelector('.message-usage').textContent.includes('入');
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const ticked = (msg.querySelector('.message-usage-duration-value') || {}).textContent || '';
    const previousAssistant = currentAssistantMsg;
    currentAssistantMsg = msg;
    handleUsage({ inputTokens: 111, outputTokens: 22, cacheReadInputTokens: 33 });
    currentAssistantMsg = previousAssistant;
    const withTokens = msg.querySelector('.message-usage').textContent.replace(/\\s+/g, ' ').trim();
    finalizeAssistantMessage(msg);
    const frozenMs = Number(msg.dataset.durationMs);
    const frozenText = (msg.querySelector('.message-usage-duration-value') || {}).textContent || '';
    const stillRunning = !!msg.querySelector('.message-usage-duration.is-running');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterWait = (msg.querySelector('.message-usage-duration-value') || {}).textContent || '';
    msg.remove();
    return { firstText, running, tokensBeforeUsage, ticked, withTokens, frozenMs, frozenText, stillRunning, afterWait };
  })()`);
  assert.ok(timer.running, 'the first paint starts a live timer: ' + JSON.stringify(timer));
  assert.ok(timer.firstText.includes('耗时') && timer.firstText.includes('0 秒'),
    'the counter starts at zero seconds: ' + timer.firstText);
  assert.equal(timer.tokensBeforeUsage, false, 'no token receipt is invented before the model reports one');
  assert.equal(timer.ticked, '1 秒', 'the counter advances on its own: ' + JSON.stringify(timer));
  assert.ok(timer.withTokens.includes(`${(111).toLocaleString()} 入`), timer.withTokens);
  assert.ok(timer.withTokens.includes('耗时'), 'the counter survives the token re-render: ' + timer.withTokens);
  assert.ok(timer.frozenMs >= 1000, 'the final duration is recorded: ' + timer.frozenMs);
  assert.equal(timer.stillRunning, false, 'completion stops the live state');
  assert.equal(timer.afterWait, timer.frozenText, 'a finished turn never ticks again');
});
