'use strict';
// Tool cards keep the input/output panes in place and offer Inspect as the
// bridge into the trajectory ledger.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function fixture() {
  const dom = new JSDOM('<div class="tool-block" data-tool-id="call1">' +
    '<div class="tool-header"></div>' +
    '<div class="tool-body">' +
    '<button data-tool-tab="input" aria-selected="true" class="is-active">输入</button>' +
    '<button data-tool-tab="output" aria-selected="false">输出</button>' +
    '<button data-tool-inspect>Inspect</button>' +
    '<div data-pane="input"><pre class="tool-args">{}</pre></div>' +
    '<div data-pane="output" hidden><pre class="tool-result"></pre></div>' +
    '</div></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(RENDERER, 'services', 'ToolCard.js'), 'utf8'));
  return { dom, w };
}

test('switching tabs reveals exactly one pane', () => {
  const { dom, w } = fixture();
  try {
    const block = w.document.querySelector('.tool-block');
    w.IexaToolCard.showTab(block, 'output');
    assert.equal(block.querySelector('[data-pane="input"]').hidden, true);
    assert.equal(block.querySelector('[data-pane="output"]').hidden, false);
    assert.equal(block.querySelector('[data-tool-tab="output"]').getAttribute('aria-selected'), 'true');
    assert.equal(block.querySelector('[data-tool-tab="input"]').getAttribute('aria-selected'), 'false');
  } finally {
    dom.window.close();
  }
});

test('clicking Inspect hands the call id to the trajectory view', () => {
  const { dom, w } = fixture();
  try {
    const seen = [];
    w.IexaTrajectory = { focusCall: (id) => seen.push(id) };
    w.document.querySelector('[data-tool-inspect]').click();
    assert.deepEqual(seen, ['call1']);
  } finally {
    dom.window.close();
  }
});
