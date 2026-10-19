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

test('a running label is swept by transforms, never by repainting glyphs', () => {
  const workbench = css('workbench.css');
  assert.doesNotMatch(workbench, /background-clip: text/,
    'a text-clipped gradient re-rasterises every glyph of the label on every frame');
  assert.doesNotMatch(workbench, /@keyframes[^{]*\{[^}]*background-position/,
    'animating background-position is a paint-only animation, not a compositor one');
  const sweep = /@keyframes iexa-label-glow-sweep \{([\s\S]*?)\n\}/.exec(workbench);
  const copy = /@keyframes iexa-label-glow-copy \{([\s\S]*?)\n\}/.exec(workbench);
  assert.ok(sweep && copy, 'the two opposite transforms from TextShimmer are missing');
  assert.match(sweep[1], /translateX\(-100%\)/);
  assert.match(copy[1], /translateX\(100%\)/,
    'without the counter-translate the glyphs slide with the band instead of staying put');
  assert.match(workbench, /\.label-glow__sweep \{[^}]*mask-image: linear-gradient\(105deg/,
    'the band is drawn by a mask on the moving window');
  assert.match(workbench, /animation: iexa-label-glow-sweep 1\.5s linear/,
    'the sweep left its measured timing');
});

test('only a running row carries a glow, never the reasoning body', () => {
  const glow = fs.readFileSync(path.join(ROOT, 'src/renderer/services/LabelGlow.js'), 'utf8');
  assert.match(glow, /classList\.contains\('is-active'\)/,
    'the glow no longer reads the row state, so finished rows would keep animating');
  assert.match(glow, /setAttribute\('aria-hidden', 'true'\)/,
    'the decorative copy would be read out twice by a screen reader');
  const workbench = css('workbench.css');
  assert.doesNotMatch(workbench, /\.thinking-content[^{]*\{[^}]*\.label-glow/,
    'the reasoning body is swept again; it can run to thousands of glyphs');
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.ok(html.includes('services/LabelGlow.js'), 'the glow module is not loaded by the shell');
});

test('a settled turn removes its activity from the layout, not just its class', () => {
  // workbench.css styles .tool-steps.activity-list as display:flex at (0,3,0)
  // and loads after the styles layer. A hide rule with the same weight loses
  // silently: the class lands, the rail keeps its three thousand pixels, and
  // the transcript shows a gap between the summary line and the answer.
  const sheet = css('styles', 'composer.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]*\.turn-activity-hidden[^{}]*)\{[^}]*display:\s*none/.exec(sheet);
  assert.ok(rule, 'no rule folds the settled activity away');
  const selector = rule[1].trim();
  const weight = (selector.match(/\./g) || []).length;
  assert.ok(selector.includes('.workbench-shell'),
    'the hide rule must outrank .workbench-shell .tool-steps.activity-list: ' + selector);
  assert.ok(weight >= 4, `hide selector has ${weight} class names, needs at least 4: ${selector}`);
});
