// Guards for the two mistakes this card shipped with: a strikethrough over CJK
// text, and a full innerHTML rebuild on every progress update.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');
const view = read('src/renderer/services/DeliverableView.js');
const css = read('src/renderer/styles/composer.css');
const sessions = read('src/renderer/services/SessionList.js');

test('completed plan rows are dimmed, never struck through', () => {
  assert.doesNotMatch(css, /\.todo-plan-item\.is-completed[^{]*\{[^}]*text-decoration/,
    'a line through CJK text reads as cancelled and sinks the contrast');
  assert.match(css, /\.todo-plan-item\.is-completed \{[^}]*color: color-mix\(in srgb, var\(--text-secondary\)/,
    'completed rows keep a readable tone instead of the faintest grey');
});

test('one plan snapshot updates rows in place', () => {
  const renderFn = view.slice(view.indexOf('function renderTodoPlan'), view.indexOf('function latestTodoPlanFromCalls'));
  assert.ok(renderFn.length > 200, 'the render function was found');
  assert.doesNotMatch(renderFn, /innerHTML\s*=/,
    'rewriting the panel restarts every spinner and resets scroll');
  assert.match(view, /function paintTodoPlanRow\(/, 'rows are diffed individually');
  assert.match(view, /text\.textContent !== item\.content/, 'text only changes when it changed');
  assert.doesNotMatch(view, /seen\.has\(/, 'duplicate lines are legitimate plan entries');
});

test('the list carries list semantics and a live summary', () => {
  assert.match(view, /role="list"/, 'the ordered list keeps its role under list-style: none');
  assert.match(view, /role="status" aria-live="polite"/, 'progress is announced, not silent');
  assert.match(view, /aria-controls="' \+ panel\.dataset\.planId/, 'the toggle points at its body');
  assert.match(view, /aria-expanded/, 'the toggle exposes its state');
});

test('a finished plan is carried by the composer dock when history is restored', () => {
  assert.match(view, /options\.restored && done === items\.length/, 'restored plans start folded');
  assert.match(view, /if \(!panel\.dataset\.seeded\)/, 'a later live update cannot re-fold a plan');
  assert.match(sessions, /IexaPlanDock\?\.setTodos\(id, window\.IexaPlanDock\.extractTodos\(msgs\)\)/,
    'the restored plan feeds the dock above the composer');
  assert.doesNotMatch(sessions, /renderTodoPlan\(el, todoPlan/,
    'the transcript must not repeat the plan the dock already shows');
});

test('the rail and the fold are theme-token driven', () => {
  assert.match(css, /\.todo-plan-rail i\.is-done \{ background: var\(--success\)/, 'done segments use the success token');
  assert.match(css, /\.todo-plan-rail i\.is-active \{ background: var\(--accent\)/, 'the running segment uses the accent');
  assert.match(css, /\.todo-plan-item\.is-in_progress \{[^}]*background: var\(--accent-light\)/, 'the active row is a tinted pill');
  assert.match(css, /html\[data-motion="reduced"\][^}]*\.todo-plan-item/, 'reduced motion disables the settle and fold');
});
