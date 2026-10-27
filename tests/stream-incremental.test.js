'use strict';
// Streaming renderer: the settled prefix is cut into small chunks, each
// rendered once and reused verbatim. When a paragraph closes only the chunk
// that just closed is parsed, so a delta costs the new text instead of the
// whole reply.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function fixture() {
  const dom = new JSDOM('<div id="content" class="message-content"></div>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window;
  for (const file of ['vendor/marked.umd.js', 'vendor/highlight.min.js', 'vendor/purify.min.js', 'services/SafeMarkdown.js', 'services/ChatPresentation.js']) {
    w.eval(fs.readFileSync(path.join(RENDERER, file), 'utf8'));
  }
  w.__renderCalls = 0;
  w.eval('var renderSafeMarkdown = function (s, o) { window.__renderCalls += 1; return window.SafeMarkdown.renderSafeMarkdown(s, o); };');
  w.eval('var normalizeRenderedAssets = function () {}; var enhanceCodeBlocks = function () {}; var enhanceTables = function () {}; var scrollToBottom = function () {}; var isNearChatBottom = function () { return false; };');
  w.eval(fs.readFileSync(path.join(RENDERER, 'services', 'StreamPipeline.js'), 'utf8'));
  return { dom, w };
}

function longAnswer(paragraphs, tail) {
  const blocks = [];
  for (let i = 0; i < paragraphs; i += 1) {
    blocks.push('## 第 ' + i + ' 段\n\n这是已经稳定的一段正文，编号 ' + i + '，包含 **加粗** 与 `code`。');
  }
  return blocks.join('\n\n') + '\n\n' + tail;
}

test('a growing long reply keeps every settled chunk and all of its text', () => {
  const { dom, w } = fixture();
  try {
    const content = w.document.getElementById('content');
    const base = longAnswer(40, '');
    let source = base + '正在生成的第一句话';
    w.renderMarkdownContent(content, source, false);
    const first = content._streamChunks;
    assert.ok(first && Array.isArray(first.texts), 'the chunk cache is attached');
    assert.ok(first.texts.length >= 2, 'a long reply splits into chunks: ' + first.texts.length);
    assert.equal(first.html.length, first.texts.length);

    let previousChunks = first.texts.length;
    for (let i = 0; i < 20; i += 1) {
      source += '，继续补充第 ' + i + ' 个词';
      w.renderMarkdownContent(content, source, false);
      const cache = content._streamChunks;
      assert.equal(cache.html.length, cache.texts.length);
      assert.ok(cache.texts.length >= previousChunks, 'settled chunks are never dropped');
      previousChunks = cache.texts.length;
    }
    const text = content.textContent;
    assert.match(text, /第 11 段/);
    assert.match(text, /继续补充第 19 个词/);
    assert.doesNotMatch(text, /\*\*加粗\*\*/, 'markdown is rendered, not left literal');
  } finally {
    dom.window.close();
  }
});

test('an open code fence never becomes a settled chunk', () => {
  const { dom, w } = fixture();
  try {
    const content = w.document.getElementById('content');
    const prefix = '开头段落。\n\n' + '稳定的正文。\n\n'.repeat(200);
    const fence = '```js\nconst a = 1;\n\nconst b = 2;\n';
    w.renderMarkdownContent(content, prefix + fence, false);
    const cache = content._streamChunks;
    assert.ok(cache && cache.texts.length > 0, 'the settled prefix is chunked');
    const settled = cache.texts.join('');
    assert.doesNotMatch(settled, /const b = 2/, 'the open fence stays in the live tail');
  } finally {
    dom.window.close();
  }
});

test('finalizing drops the cache and highlights once', () => {
  const { dom, w } = fixture();
  try {
    const content = w.document.getElementById('content');
    const source = longAnswer(4, '```js\nconst x = 1;\n```');
    w.renderMarkdownContent(content, source, false);
    w.renderMarkdownContent(content, source, true);
    assert.equal(content._streamChunks, null);
    assert.equal(content._renderedMarkdownFinal, true);
    assert.ok(content.querySelector('pre code'), 'the code block survives finalization');
  } finally {
    dom.window.close();
  }
});

test('closing a paragraph renders one chunk, not the whole prefix', () => {
  const { dom, w } = fixture();
  try {
    const content = w.document.getElementById('content');
    let source = longAnswer(60, '');
    w.renderMarkdownContent(content, source, false);
    const before = content._streamChunks.texts.length;
    const beforeCalls = w.__renderCalls;

    // Close one more paragraph: the settled prefix gains a chunk boundary.
    source += '\n\n新的段落收尾。';
    w.renderMarkdownContent(content, source, false);
    const added = w.__renderCalls - beforeCalls;
    assert.ok(content._streamChunks.texts.length >= before, 'the chunk list only grows');
    // One render for the newly settled chunk plus one for the live tail.
    assert.ok(added <= 2, 'a closed paragraph re-renders ' + added + ' chunks, not the prefix');
  } finally {
    dom.window.close();
  }
});
