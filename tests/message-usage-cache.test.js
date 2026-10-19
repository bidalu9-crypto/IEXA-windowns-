'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const appSource = require('./helpers/renderer-bundle').source;
const tree = ts.createSourceFile('app.js', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = tree.statements.filter((node) => ts.isFunctionDeclaration(node));
function pickFunctions(names) {
  return declarations.filter((node) => names.includes(node.name?.text)).map((node) => node.getText(tree)).join('\n');
}

function createWindow(t) {
  const dom = new JSDOM('<body><div id="messages"></div><div id="tokenUsageList"></div><div id="tokenUsageUpdated"></div><button id="tokenUsageClearAll" hidden></button></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' });
  if (t) t.after(() => dom.window.close());
  const w = dom.window;
  w.escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  w.formatMessageTimestamp = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? '14:31' : '');
  w.eval('var liveTurnDurations = new Set(); var liveTurnDurationTimer = 0;');
  w.eval(pickFunctions([
    'renderMessageUsage', 'formatTokenCount', 'formatUsageNumber', 'formatEstimatedCost', 'renderTokenUsage', 'uiIcon', 'formatUsagePercent',
    'formatTurnDuration', 'messageTurnDuration', 'renderTurnDurationMarkup', 'registerLiveTurnDuration',
    'unregisterLiveTurnDuration', 'tickLiveTurnDurations', 'freezeTurnDuration', 'ensureMessageUsage',
  ]));
  return w;
}

function mountMessage(w) {
  const message = w.document.createElement('div');
  message.className = 'message assistant';
  message.dataset.timestamp = '1792132260000';
  const usageEl = w.document.createElement('div');
  usageEl.className = 'message-usage';
  message.appendChild(usageEl);
  w.document.getElementById('messages').appendChild(message);
  return { message, usageEl };
}

test('message usage line places the cache receipt between output and time', (t) => {
  const w = createWindow(t);
  const { usageEl } = mountMessage(w);
  w.renderMessageUsage(usageEl, 80739, 19398, 79104);
  const text = usageEl.textContent.replace(/\s+/g, ' ').trim();
  assert.ok(text.includes('80.7K 入'), text);
  assert.ok(text.includes('19.4K 出'), text);
  assert.ok(text.includes('79.1K 缓存'), text);
  assert.ok(!/\d,\d{3}/.test(text), 'no digit-grouped counts survive in the line: ' + text);
  assert.ok(text.indexOf('缓存') > text.indexOf('出'), 'cache follows the output count: ' + text);
  assert.ok(text.indexOf('14:31') > text.indexOf('缓存'), 'time stays last: ' + text);
  assert.equal(usageEl.querySelectorAll('i').length, 2, 'two separator dots around the cache segment');
});

test('compact counts keep the exact receipt in the hover title', (t) => {
  const w = createWindow(t);
  const { usageEl } = mountMessage(w);
  w.renderMessageUsage(usageEl, 132225, 1198, 131328);
  const html = usageEl.innerHTML;
  assert.ok(html.includes('title="输入 132,225 tokens"'), html);
  assert.ok(html.includes('title="输出 1,198 tokens"'), html);
  // The ring behind the label reads --cache-share; the title carries the exact
  // count and the share as a number.
  assert.ok(html.includes('title="缓存读取 131,328 tokens（占输入侧 50%）"'), html);
  assert.ok(html.includes('class="message-usage-cache"'), html);
  assert.ok(html.includes('--cache-share:50'), html);
  const text = usageEl.textContent.replace(/\s+/g, ' ').trim();
  assert.ok(text.includes('132K 入'), text);
  assert.ok(text.includes('1.2K 出'), text);
  assert.ok(text.includes('131K 缓存'), text);
});

test('cache segment is omitted when the endpoint reported nothing', (t) => {
  const w = createWindow(t);
  const { usageEl } = mountMessage(w);
  w.renderMessageUsage(usageEl, 123, 45);
  assert.ok(!usageEl.textContent.includes('缓存'), usageEl.textContent);
  w.renderMessageUsage(usageEl, 123, 45, undefined);
  assert.ok(!usageEl.textContent.includes('缓存'), usageEl.textContent);
  w.renderMessageUsage(usageEl, 123, 45, null);
  assert.ok(!usageEl.textContent.includes('缓存'), usageEl.textContent);
});

test('a genuine zero cache receipt is shown as 0 rather than hidden', (t) => {
  const w = createWindow(t);
  const { usageEl } = mountMessage(w);
  w.renderMessageUsage(usageEl, 59272, 19899, 0);
  assert.ok(usageEl.textContent.includes('0 缓存'), usageEl.textContent);
});

test('token usage page keeps a cache tile for every model, including zero', (t) => {
  const w = createWindow(t);
  w.tokenUsageRecords = [
    { model: 'fixture-cache', provider: 'openai', profileName: 'p', inputTokens: 1000, outputTokens: 100, requests: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 295680, estimatedCostUsd: null, updatedAt: 2 },
    { model: 'fixture-zero', provider: 'openai', inputTokens: 10, outputTokens: 1, requests: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: null, updatedAt: 1 },
  ];
  w.renderTokenUsage();
  const html = w.document.getElementById('tokenUsageList').innerHTML;
  assert.equal((html.match(/<span>缓存<\/span>/g) || []).length, 2, 'cache tile is always present, not conditional: ' + html.slice(0, 500));
  assert.ok(html.includes('<span>缓存</span><strong>296K</strong>'), html.slice(0, 500));
  assert.ok(html.includes('<span>缓存</span><strong>0</strong>'), html.slice(0, 500));
});

test('server persists and streams the cache receipt for message usage', () => {
  const server = fs.readFileSync(path.join(root, 'src/main/server.ts'), 'utf8');
  assert.ok(server.includes('cacheReadInputTokens: u.cacheReadInputTokens'), 'lastUsage keeps the receipt');
  assert.ok(server.includes('usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number };'), 'assistant message type extended');
  assert.ok(appSource.includes('0, usage.cacheReadInputTokens)'), 'live stream passes the receipt');
  assert.ok(appSource.includes('msg.usage && msg.usage.cacheReadInputTokens'), 'history re-render passes the receipt');
});

test('usage rendering keeps a single handler and the dead pending path stays removed', () => {
  assert.equal((appSource.match(/function handleUsage\(/g) || []).length, 1, 'exactly one handleUsage definition');
  assert.ok(!appSource.includes('renderPendingMessageUsage'), 'pending usage renderer removed');
  assert.ok(!appSource.includes('usageInputTokens'), 'dataset stash removed (input)');
  assert.ok(!appSource.includes('usageOutputTokens'), 'dataset stash removed (output)');
  assert.ok(!appSource.includes('usageCacheReadTokens'), 'dataset stash removed (cache)');
});

test('the renderer keeps no duplicate top-level function declarations', () => {
  const counts = new Map();
  for (const node of declarations) {
    const name = node.name?.text;
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, [], 'duplicate top-level declarations: ' + JSON.stringify(duplicates));
});

test('token usage cards carry per-record delete controls and the clear-all toggle', (t) => {
  const w = createWindow(t);
  const clear = w.document.getElementById('tokenUsageClearAll');
  w.tokenUsageRecords = [
    { key: 'openai:fixture-cache:p1', model: 'fixture-cache', provider: 'openai', profileName: 'p', inputTokens: 1000, outputTokens: 100, requests: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: null, updatedAt: 2 },
  ];
  w.renderTokenUsage();
  const html = w.document.getElementById('tokenUsageList').innerHTML;
  assert.ok(html.includes('data-ui-action="deleteTokenUsage"'), 'delete action emitted: ' + html.slice(0, 600));
  assert.ok(html.includes('data-ui-arg="openai:fixture-cache:p1"'), 'delete argument is the record key: ' + html.slice(0, 600));
  assert.equal(clear.hidden, false, 'clear-all is offered while records exist');
  w.tokenUsageRecords = [];
  w.renderTokenUsage();
  assert.equal(clear.hidden, true, 'clear-all hides when the list is empty');
});

test('token usage delete wiring stays registered on actions and server routes', () => {
  assert.ok(appSource.includes('deleteTokenUsage: (value) => deleteTokenUsage(value),'), 'single-record delete registered on the delegated action map');
  assert.ok(appSource.includes('clearTokenUsage: () => clearTokenUsage(),'), 'clear-all registered on the delegated action map');
  assert.ok(appSource.includes('class="token-usage-model-delete"'), 'card render keeps the delete control class');
  const serverSource = fs.readFileSync(path.join(root, 'src/main/server.ts'), 'utf8');
  assert.ok(serverSource.includes("url.pathname === '/api/token-usage' && req.method === 'DELETE'"), 'clear-all route present');
  assert.ok(serverSource.includes("url.pathname.startsWith('/api/token-usage/') && req.method === 'DELETE'"), 'single-record delete route present');
});

test('cache tile shows the cache share of the input side as a percentage', (t) => {
  const w = createWindow(t);
  w.tokenUsageRecords = [
    { key: 'k1', model: 'm1', provider: 'openai', inputTokens: 300, outputTokens: 50, requests: 4, cacheCreationInputTokens: 40, cacheReadInputTokens: 60, estimatedCostUsd: null, updatedAt: 2 },
    { key: 'k2', model: 'm2', provider: 'openai', inputTokens: 500, outputTokens: 50, requests: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: null, updatedAt: 1 },
  ];
  w.renderTokenUsage();
  const html = w.document.getElementById('tokenUsageList').innerHTML;
  assert.ok(html.includes('<span>缓存</span><strong>100</strong><small class="token-usage-model-pct">25%</small>'), '100 cache of 300+100 input must read 25%: ' + html.slice(0, 900));
  assert.ok(html.includes('<span>缓存</span><strong>0</strong><small class="token-usage-model-pct">0%</small>'), 'no cache must read 0%: ' + html.slice(0, 900));
});
