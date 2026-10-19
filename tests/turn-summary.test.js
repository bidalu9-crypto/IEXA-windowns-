// A finished turn folds its reasoning and tool rails behind one line carrying
// the elapsed time; during the turn nothing is folded. This is the Codex
// behaviour the user asked for, pinned because it is the kind of thing that
// silently regresses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { create } = require('./helpers/transcript-harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => require('node:fs').readFileSync(path.join(ROOT, ...parts), 'utf8');

function turnWithActivity(t) {
  const { w, message } = create(t);
  w.handleThinkingDelta('先看一眼结构');
  w.handleToolStart('a', 'file_read');
  w.handleToolComplete('a', 'file_read', { path: 'a.ts' });
  w.handleToolStart('b', 'grep');
  w.handleToolComplete('b', 'grep', { pattern: 'x' });
  w.handleThinkingDelta('再确认一遍');
  return { w, message };
}

test('a running turn keeps every block on screen', (t) => {
  const { message } = turnWithActivity(t);
  assert.equal(message.querySelector('.turn-summary'), null, 'the bar appeared mid-turn');
  assert.equal(message.querySelectorAll('.tool-block').length, 2);
  assert.equal(message.querySelectorAll('.tool-block.turn-activity-hidden').length, 0);
});

test('the settled turn folds to one line with its duration', (t) => {
  const { w, message } = turnWithActivity(t);
  message.dataset.durationMs = String(72_000);
  w.IexaTurnSummary.settle(message);

  const bar = message.querySelector('.turn-summary');
  assert.ok(bar, 'no summary bar');
  assert.equal(message.classList.contains('is-activity-collapsed'), true);
  assert.equal(bar.getAttribute('aria-expanded'), 'false');
  assert.match(bar.querySelector('.turn-summary-label').textContent, /用时/);
  assert.match(bar.querySelector('.turn-summary-time').textContent, /1 分 12 秒/);
  assert.match(bar.querySelector('.turn-summary-count').textContent, /2 次调用/);
  // Every reasoning block and rail is folded, none of them removed.
  const folded = message.querySelectorAll('.turn-activity-hidden');
  assert.equal(folded.length, message.querySelectorAll('.thinking-block, .tool-steps').length);
  assert.ok(folded.length >= 3, 'expected reasoning blocks and the rail to fold, got ' + folded.length);
});

test('expanding puts the original blocks back untouched', (t) => {
  const { w, message } = turnWithActivity(t);
  w.IexaTurnSummary.settle(message);
  const before = [...message.querySelectorAll('.tool-block')].map((b) => b.dataset.toolId);
  w.IexaTurnSummary.expand(message);

  assert.equal(message.classList.contains('is-activity-collapsed'), false);
  assert.equal(message.querySelectorAll('.turn-activity-hidden').length, 0);
  const after = [...message.querySelectorAll('.tool-block')].map((b) => b.dataset.toolId);
  assert.deepEqual(after, before, 'expansion rebuilt the rows instead of revealing them');
});

test('reasoning stays closed while the turn is expanded', (t) => {
  const { w, message } = turnWithActivity(t);
  const reasoning = message.querySelector('.thinking-block');
  reasoning.open = true;
  w.IexaTurnSummary.settle(message);
  assert.equal(reasoning.open, false, 'a settled turn must not expand its reasoning');
});

test('folding honours a chain the reader opened by hand', (t) => {
  const { w, message } = turnWithActivity(t);
  const rail = message.querySelector('.tool-steps');
  const summary = rail.querySelector('.task-summary');
  summary.dataset.userExpanded = 'true';
  w.IexaTurnSummary.settle(message);
  assert.equal(message.classList.contains('is-activity-collapsed'), false,
    'an intentionally opened chain was slammed shut');
  assert.match(message.querySelector('.turn-summary-time').textContent, /\d/);
});

test('settling twice reuses the bar instead of stacking them', (t) => {
  const { w, message } = turnWithActivity(t);
  w.IexaTurnSummary.settle(message);
  w.IexaTurnSummary.settle(message);
  assert.equal(message.querySelectorAll('.turn-summary').length, 1);
});

test('a turn with no activity gets no bar', (t) => {
  const { w, message } = create(t);
  w.IexaTurnSummary.settle(message);
  assert.equal(message.querySelector('.turn-summary'), null);
});

test('the summary reads the persisted duration after a replay', (t) => {
  const { w, message } = turnWithActivity(t);
  message.dataset.durationMs = String(3_600_000 + 32 * 60_000 + 19_000);
  w.IexaTurnSummary.settle(message);
  assert.match(message.querySelector('.turn-summary-time').textContent, /1 小时 32 分 19 秒/);
});

test('disabling the setting unfolds what it had folded', (t) => {
  const { w, message } = turnWithActivity(t);
  w.IexaTurnSummary.setEnabled(true);
  w.IexaTurnSummary.settle(message);
  assert.equal(message.classList.contains('is-activity-collapsed'), true);
  w.IexaTurnSummary.setEnabled(false);
  assert.equal(message.classList.contains('is-activity-collapsed'), false);
  assert.equal(message.querySelectorAll('.turn-activity-hidden').length, 0);
  w.IexaTurnSummary.setEnabled(true);
});

test('the completion path calls the module instead of folding by hand', () => {
  const helpers = read('src', 'renderer', 'services', 'UiHelpers.js');
  const body = helpers.slice(helpers.indexOf('function finalizeAssistantMessage'));
  assert.match(body.slice(0, 1600), /IexaTurnSummary\?\.settle\(messageEl\)/,
    'finalizeAssistantMessage no longer settles the turn');
  const session = read('src', 'renderer', 'services', 'SessionList.js');
  assert.match(session, /IexaTurnSummary\?\.settle\(el\)/, 'replayed turns are not settled');
  const view = read('src', 'renderer', 'services', 'TranscriptView.js');
  assert.match(view, /IexaTurnSummary\?\.settle\(element\)/, 'ordered replay is not settled');
});
