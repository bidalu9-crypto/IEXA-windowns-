const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { StreamBatcher } = require('../dist/main/api/StreamBatcher');
const { JsonStore } = require('../dist/main/persistence/JsonStore');

test('stream batching preserves final text, thinking and tool input before completion', () => {
  const events = [];
  const batcher = new StreamBatcher((event, data) => events.push({ event, data }), 10000);
  for (let index = 0; index < 10000; index++) {
    batcher.emit('text', { content: 'x'.repeat(index + 1) });
    batcher.emit('thinking', { content: 't' });
    batcher.emit('tool_input', { id: 'tool', args: String(index) });
  }
  batcher.emit('done', {});
  assert.deepEqual(events.map((entry) => entry.event), ['text', 'thinking', 'tool_input', 'done']);
  assert.equal(events[0].data.content.length, 10000);
  assert.equal(events[1].data.content.length, 10000);
  assert.equal(events[2].data.args, '9999');
  batcher.flush();
  assert.equal(events.length, 4);
});

test('independent streams and cancellation flush without mixing sessions', () => {
  const first = [];
  const second = [];
  const left = new StreamBatcher((event, data) => first.push([event, data]));
  const right = new StreamBatcher((event, data) => second.push([event, data]));
  left.emit('text', { content: 'left' });
  right.emit('text', { content: 'right' });
  left.emit('cancelled', {});
  right.emit('error', { message: 'stop' });
  assert.equal(first[0][1].content, 'left');
  assert.equal(second[0][1].content, 'right');
  assert.equal(first[1][0], 'cancelled');
});

test('async atomic writes serialize across store instances and preserve backups', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iexa-perf-'));
  try {
    const file = path.join(root, 'state.json');
    await Promise.all(Array.from({ length: 20 }, (_, index) => new JsonStore(file, () => null).save({ index })));
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).index, 19);
    assert.equal(JSON.parse(await fs.readFile(file + '.bak', 'utf8')).index, 18);
    assert.deepEqual((await fs.readdir(root)).sort(), ['state.json', 'state.json.bak']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('renderer queues are session-bound and discard stale turns', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('const pendingStreamUpdates =');
  const end = source.indexOf('function handleSSEEvent', start);
  const results = [];
  const context = { currentSessionId: 'one', visibleSessionId: 'one', activeChatTurnToken: 1,
    setTimeout: () => 1, clearTimeout() {}, snapshotActiveSessionRuntime() {},
    handleTextDelta: (text) => results.push(text), handleThinkingDelta() {}, handleToolInput() {},
    withSessionRuntime: (_, work) => work() };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext("queueStreamUpdate('text', { content: 'old' }, 0); queueStreamUpdate('text', { content: 'new' }, 1); flushStreamUpdates('one');", context);
  assert.deepEqual(results, ['new']);
});

test('negotiated SSE sends linear deltas, resets and preserves legacy snapshots', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/main/server.ts'), 'utf8');
  const ts = require('typescript');
  const start = source.indexOf('const deltaClients =');
  const end = source.indexOf('function broadcastSessionEvent', start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const frames = [];
  const response = { writableLength: 0, write: (frame) => frames.push(JSON.parse(frame.split('data: ')[1])) };
  const context = { response };
  vm.createContext(context);
  vm.runInContext(code, context);
  vm.runInContext("deltaClients.set(response, new Map()); for (let index = 1; index <= 1000; index++) sendSSE(response, 'text', {content: 'x'.repeat(index)});", context);
  assert.equal(frames.reduce((sum, frame) => sum + frame.content.length, 0), 1000);
  vm.runInContext("sendSSE(response, 'text', {content: 'new'});", context);
  assert.equal(frames.at(-1).reset, true);
  assert.equal(frames.at(-1).content, 'new');
  vm.runInContext("deltaClients.delete(response); sendSSE(response, 'text', {content: 'legacy'});", context);
  assert.equal(frames.at(-1).content, 'legacy');
  assert.equal(frames.at(-1).reset, undefined);
});

test('text pager bounds mounted text while preserving navigation and full copy', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('function setPagedText');
  const end = source.indexOf('function handleToolResult', start);
  const element = { after() {} };
  let copied;
  const context = { element, document: { createElement: () => ({ append() {} }) },
    writeClipboardText: async (text) => { copied = text; }, addError() {} };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext("setPagedText(element, 'x'.repeat(1000000));", context);
  assert.equal(element.textContent.length, 16000);
  assert.equal(element._fullText.length, 1000000);
  element._pager.next.onclick();
  assert.equal(element._page, 1);
  element._page = 62;
  vm.runInContext('setPagedText(element, element._fullText);', context);
  assert.equal(element.textContent.length, 8000);
  assert.equal(element._pager.next.disabled, true);
});

test('streaming markdown renders each changed batch once and finalizes without reparsing', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('function renderMarkdownContent(');
  const end = source.indexOf('function handleTextDelta(', start);
  let parses = 0;
  let normalized = 0;
  let codeEnhancements = 0;
  let tableEnhancements = 0;
  const content = { querySelectorAll: () => [], innerHTML: '' };
  const context = {
    marked: { parse: (markdown) => { parses += 1; return `<p>${markdown}</p>`; } },
    normalizeRenderedAssets: () => { normalized += 1; },
    enhanceCodeBlocks: () => { codeEnhancements += 1; },
    enhanceTables: () => { tableEnhancements += 1; },
    scrollToBottom() {},
    isNearChatBottom: true,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  context.renderMarkdownContent(content, '**live**');
  assert.equal(content.innerHTML, '<p>**live**</p>');
  assert.equal(content._markdownSource, '**live**');
  assert.equal(parses, 1);
  assert.equal(normalized, 1);
  context.renderMarkdownContent(content, '**live**', true);
  assert.equal(parses, 1);
  assert.equal(codeEnhancements, 1);
  assert.equal(tableEnhancements, 1);
});

test('chat follow survives layout growth, pauses on upward wheel, and resumes at bottom', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('function isChatNearBottom(');
  const end = source.indexOf('function setProcessing(', start);
  const chatListeners = {};
  const documentListeners = {};
  const frames = [];
  const visibleChatMessages = {
    scrollHeight: 1000,
    scrollTop: 900,
    clientHeight: 100,
    addEventListener: (name, listener) => { chatListeners[name] = listener; },
  };
  const context = {
    visibleChatMessages,
    currentSessionId: 'session',
    visibleSessionId: 'session',
    isNearChatBottom: true,
    scrollToBottomBtn: null,
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    document: { addEventListener: (name, listener) => { documentListeners[name] = listener; } },
    window: { setTimeout: () => 1, clearTimeout() {} },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  visibleChatMessages.scrollHeight = 1200;
  chatListeners.scroll();
  assert.equal(vm.runInContext('isNearChatBottom', context), true);
  context.scrollToBottom(false, true);
  frames.shift()();
  assert.equal(visibleChatMessages.scrollTop, 1200);
  frames.shift()();

  chatListeners.wheel({ deltaY: -120 });
  visibleChatMessages.scrollTop = 700;
  chatListeners.scroll();
  assert.equal(vm.runInContext('isNearChatBottom', context), false);
  context.scrollToBottom();
  frames.shift()();
  assert.equal(visibleChatMessages.scrollTop, 700);

  // A manual scrollbar drag between scheduling and the next frame cancels the
  // pending follow request as well, so the stale frame cannot pull the user down.
  visibleChatMessages.scrollTop = 650;
  chatListeners.pointerdown();
  context.scrollToBottom(false, true);
  chatListeners.scroll();
  frames.shift()();
  assert.equal(visibleChatMessages.scrollTop, 650);

  visibleChatMessages.scrollTop = 1100;
  chatListeners.scroll();
  assert.equal(vm.runInContext('isNearChatBottom', context), true);
});
