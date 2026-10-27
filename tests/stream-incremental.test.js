'use strict';
// Streaming renderer: only the last open block is parsed again; the settled
// prefix stays cached so a long reply does not re-parse its whole document on
// every delta.
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
  w.eval('var renderSafeMarkdown = function (s, o) { window.__renderCalls += 1; return window.SafeMarkdown.renderSafeMarkdown(s, o); };')
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

test('a growing long reply renders the settled prefix once and keeps all text', () => {
  const { dom, w } = fixture();
  try {
    const content = w.document.getElementById('content');
    const base = longAnswer(40, '');
    let source = base + '正在生成的第一句话';
    w.renderMarkdownContent(content, source, false);
    assert.ok(content._streamStable, 'the settled prefix is cached');

    for (let i = 0; i < 20; i += 1) {
      source += '，继续补充第 ' + i + ' 个词';
      w.renderMarkdownContent(content, source, false);
    }
    const text = content.textContent;
    assert.match(text, /第 11 段/);
    assert.match(text, /继续补充第 19 个词/);
    assert.doesNotMatch(text, /\*\*加粗\*\*/, 'markdown is rendered, not left literal');
  } finally {
    dom.window.close();
  }
});

test('a blank line inside a code fence never becomes a stable split', () => {
  const { dom, w } = fixture();
  try {
    const content = w.document.getElementById('content');
    const prefix = '开头段落。\n\n' + '稳定的正文。\n\n'.repeat(200);
    const fence = '```js\nconst a = 1;\n\nconst b = 2;\n';
    const source = prefix + fence;
    w.renderMarkdownContent(content, source, false);
    const stable = content._streamStable;
    assert.ok(stable, 'a split exists');
    assert.doesNotMatch(stable.source, /const b = 2/, 'the open fence stays in the live tail');
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
    assert.equal(content._streamStable, null);
    assert.equal(content._renderedMarkdownFinal, true);
    assert.ok(content.querySelector('pre code'), 'the code block survives finalization');
  } finally {
    dom.window.close();
  }
});

test('the settled prefix is parsed once across dozens of deltas', () => {
  const { dom, w } = fixture();
  try {
    const content = w.document.getElementById('content');
    let source = longAnswer(40, '') + '开始';
    w.renderMarkdownContent(content, source, false);
    const afterFirst = w.__renderCalls;
    for (let i = 0; i < 30; i += 1) {
      source += '，增量' + i;
      w.renderMarkdownContent(content, source, false);
    }
    const extra = w.__renderCalls - afterFirst;
    assert.ok(extra <= 32, 'one parse per delta at most, not one per block: ' + extra);
    assert.ok(afterFirst <= 2, 'the first frame parses the prefix once: ' + afterFirst);
  } finally {
    dom.window.close();
  }
});
