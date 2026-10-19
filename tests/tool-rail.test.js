const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { create, flatten } = require('./helpers/transcript-harness.cjs');

const ROOT = path.join(__dirname, '..');
const css = (...parts) => fs.readFileSync(path.join(ROOT, 'src/renderer', ...parts), 'utf8');
const stream = fs.readFileSync(path.join(ROOT, 'src/renderer/services/StreamPipeline.js'), 'utf8');

test('a think/tool alternation stays on one rail instead of one card per step', (t) => {
  // Reproduces the shape from the screenshots: 思考 -> 工具 -> 思考 -> 工具 -> 思考.
  const { w, message } = create(t);
  w.handleThinkingDelta('第一段');
  w.handleToolStart('a', 'file_read');
  w.handleToolComplete('a', 'file_read', { path: 'a.ts' });
  w.handleThinkingDelta('第二段');
  w.handleToolStart('b', 'grep');
  w.handleToolComplete('b', 'grep', { pattern: 'x' });
  w.handleThinkingDelta('第三段');

  assert.equal(message.querySelectorAll('.tool-steps').length, 1, 'the turn split into several rails');
  const rail = message.querySelector('.tool-steps');
  assert.equal(rail.querySelectorAll('.task-summary').length, 1, 'one summary bar per rail');
  // The first reasoning block predates the rail; the rest join it.
  assert.equal(rail.querySelectorAll('.thinking-block').length, 2);
  assert.equal(rail.querySelectorAll('.tool-block').length, 2);
  // Order inside the rail is still the real chronology.
  assert.deepEqual(flatten(message), [
    ['thinking', '第一段'], ['tool', 'a'], ['thinking', '第二段'], ['tool', 'b'], ['thinking', '第三段'],
  ]);
});

test('a collapsed rail keeps live reasoning out of it', (t) => {
  const { w, message } = create(t);
  w.handleThinkingDelta('先想');
  w.handleToolStart('a', 'file_read');
  w.handleToolComplete('a', 'file_read', { path: 'a.ts' });
  const rail = message.querySelector('.tool-steps');
  rail.classList.add('is-collapsed');
  w.handleThinkingDelta('收起来之后');
  // A collapsed rail hides its children, so live reasoning must be a sibling.
  assert.equal(rail.querySelectorAll('.thinking-block').length, 0,
    'new reasoning was appended into a collapsed rail and would be invisible');
  assert.equal(message.querySelectorAll('.tool-steps').length, 1);
  assert.deepEqual(flatten(message), [['thinking', '先想'], ['tool', 'a'], ['thinking', '收起来之后']]);
});

test('the transcript spends one animated layer, not one per call', () => {
  const composer = css('styles', 'composer.css');
  assert.ok(!composer.includes('toolShimmer'), 'the per-row gloss is back');
  assert.ok(!/\.tool-block[^{]*\{[^}]*animation\s*:/.test(composer), 'a tool row animates on its own');

  const workbench = css('workbench.css');
  const sweeps = [...workbench.matchAll(/animation:\s*toolSweep/g)];
  assert.equal(sweeps.length, 1, 'the sweep is declared more than once');
  assert.match(workbench, /\.tool-block\.is-active > \.tool-header::after/, 'the sweep left the running row');
  assert.match(workbench, /animation: toolSweep [\d.]+s linear/, 'an eased infinite sweep stops at both ends');
});

test('streaming reveals stay on compositor properties', () => {
  const workbench = css('workbench.css');
  const block = /@keyframes iexa-stream-reveal \{([\s\S]*?)\n\}/.exec(workbench);
  assert.ok(block, 'iexa-stream-reveal is missing');
  assert.ok(!block[1].includes('clip-path'), 'clip-path repaints every streamed chunk');
  assert.ok(!block[1].includes('filter'), 'a filter per chunk forces a render surface');
});

test('tool rows are contained so an append cannot lay out the whole transcript', () => {
  const workbench = css('workbench.css');
  const rule = /\.workbench-shell \.tool-block,\s*\n[^{]*\{([^}]*)\}/.exec(workbench);
  assert.ok(rule, 'the tool row rule moved');
  assert.match(rule[1], /contain: layout paint style/);
  assert.match(rule[1], /border: 0/, 'rows should not carry card chrome');
});

// The next three pin the parts of DeepSeek Harness's tool UI that were actually
// read from the repo, not the parts that were assumed.
test('the rail is one border on the container, not a hairline per row', () => {
  const workbench = css('workbench.css');
  assert.match(workbench, /\.tool-steps\.activity-list \{[^}]*border-left: \.5px/,
    'the rail border is not on the container');
  assert.doesNotMatch(workbench, /\.tool-steps > :is\(\.tool-block, \.thinking-block\) \{[^}]*box-shadow: inset/,
    'rows still draw their own hairline; that is one paint per row again');
});

test('a row is one 24px line with the 2px separator', () => {
  const workbench = css('workbench.css');
  // ToolRow.module.css documents 24px, gap 6 after the leading glyph, gap 8
  // around the separator.
  assert.match(workbench, /\.tool-block \.tool-header \{[^}]*min-height: 24px/,
    'row height drifted from the measured 24px');
  assert.match(workbench, /\.tool-meta::before \{[^}]*width: 2px;[^}]*height: 2px/,
    'the 2x2 dot between title and summary is missing');
});

test('a paragraph is never text-clipped and swept', () => {
  const workbench = css('workbench.css');
  const clip = /([^{}]*)\{[^}]*background-clip: text/.exec(workbench);
  assert.ok(clip, 'the label sweep is gone');
  assert.ok(!clip[1].includes('.thinking-content'),
    'the reasoning body is being re-rasterised every frame; text-clip belongs on one-line labels only');
  const frames = css('styles', 'transcript.css');
  const cycle = /@keyframes iexa-waiting-text-sweep \{[\s\S]*?\r?\n\}/.exec(frames);
  assert.ok(cycle, 'the sweep keyframes are missing');
  assert.match(cycle[0], /66\.6667%, 100%/,
    'the sweep runs continuously; Harness holds the band for the last third of the cycle');
});
