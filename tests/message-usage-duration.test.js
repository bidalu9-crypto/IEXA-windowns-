'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { JSDOM } = require('jsdom');

/* The usage line carries a live turn timer between the prompt-cache receipt and
   the clock: it starts at 0 秒, advances once a second while the turn streams,
   and freezes when the reply is finalized. */

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const tree = ts.createSourceFile('app.js', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = tree.statements.filter((node) => ts.isFunctionDeclaration(node));
function pickFunctions(names) {
  return declarations.filter((node) => names.includes(node.name?.text)).map((node) => node.getText(tree)).join('\n');
}

const DURATION_FUNCTIONS = [
  'renderMessageUsage',
  'formatTokenCount',
  'formatTurnDuration',
  'messageTurnDuration',
  'renderTurnDurationMarkup',
  'registerLiveTurnDuration',
  'unregisterLiveTurnDuration',
  'tickLiveTurnDurations',
  'freezeTurnDuration',
  'ensureMessageUsage',
];

const FIXED_NOW = 1_700_000_000_000;

function createWindow(t) {
  const dom = new JSDOM('<body><div id="messages"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost' });
  if (t) t.after(() => dom.window.close());
  const w = dom.window;
  w.escapeHtml = (value) => String(value);
  w.formatMessageTimestamp = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? '14:31' : '');
  // Module-scope state the extracted functions close over.
  w.eval('var liveTurnDurations = new Set(); var liveTurnDurationTimer = 0;');
  w.eval(pickFunctions(DURATION_FUNCTIONS));
  w.__now = FIXED_NOW;
  w.Date.now = () => w.__now;
  return w;
}

function mount(w, dataset) {
  const message = w.document.createElement('div');
  message.className = 'message assistant';
  message.dataset.timestamp = '1792132260000';
  Object.assign(message.dataset, dataset || {});
  const footer = w.document.createElement('div');
  footer.className = 'assistant-message-footer';
  const actions = w.document.createElement('div');
  actions.className = 'assistant-message-actions';
  footer.appendChild(actions);
  message.appendChild(footer);
  w.document.getElementById('messages').appendChild(message);
  return message;
}

const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

test('turn duration renders whole seconds first, then minutes and hours', (t) => {
  const w = createWindow(t);
  const cases = [
    [0, '0 秒'],
    [999, '0 秒'],
    [1000, '1 秒'],
    [59_000, '59 秒'],
    [59_999, '59 秒'],
    [60_000, '1 分 00 秒'],
    [65_000, '1 分 05 秒'],
    [3_599_000, '59 分 59 秒'],
    [3_600_000, '1 小时 00 分'],
    [7_380_000, '2 小时 03 分'],
  ];
  for (const [ms, expected] of cases) {
    assert.equal(w.formatTurnDuration(ms), expected, `${ms}ms`);
  }
  assert.equal(w.formatTurnDuration(-5), '0 秒', 'negative input clamps to zero');
  assert.equal(w.formatTurnDuration(undefined), '0 秒', 'missing input clamps to zero');
});

test('the first paint of a live turn shows only a running counter', (t) => {
  const w = createWindow(t);
  const message = mount(w, { turnStartedAt: String(FIXED_NOW) });
  const usageEl = w.ensureMessageUsage(message);
  w.renderMessageUsage(usageEl, null, null, undefined, { pending: true });

  assert.ok(usageEl.textContent.includes('耗时'), usageEl.textContent);
  assert.ok(usageEl.textContent.includes('0 秒'), usageEl.textContent);
  assert.ok(!usageEl.textContent.includes('入'), 'no token receipt before the model reports one: ' + usageEl.textContent);
  const node = usageEl.querySelector('.message-usage-duration');
  assert.ok(node.classList.contains('is-running'), 'the counter is live');
  assert.equal(w.liveTurnDurations.size, 1, 'the shared ticker owns exactly one element');
});

test('the counter advances from the clock, not from an incrementing value', (t) => {
  const w = createWindow(t);
  const message = mount(w, { turnStartedAt: String(FIXED_NOW) });
  const usageEl = w.ensureMessageUsage(message);
  w.renderMessageUsage(usageEl, null, null, undefined, { pending: true });

  w.__now = FIXED_NOW + 12_400;
  w.tickLiveTurnDurations();
  assert.equal(text(usageEl.querySelector('.message-usage-duration-value')), '12 秒');

  // A stalled/hidden tab must not drift: the value is recomputed each tick.
  w.__now = FIXED_NOW + 30_000;
  w.tickLiveTurnDurations();
  assert.equal(text(usageEl.querySelector('.message-usage-duration-value')), '30 秒');
});

test('a token receipt arrives mid-turn without resetting the counter', (t) => {
  const w = createWindow(t);
  const message = mount(w, { turnStartedAt: String(FIXED_NOW) });
  const usageEl = w.ensureMessageUsage(message);
  w.renderMessageUsage(usageEl, null, null, undefined, { pending: true });
  w.__now = FIXED_NOW + 12_000;
  w.renderMessageUsage(usageEl, 80739, 19398, 79104);

  const line = text(usageEl);
  assert.ok(line.includes('80.7K 入'), line);
  assert.ok(line.includes('19.4K 出'), line);
  assert.ok(line.includes('79.1K 缓存'), line);
  assert.ok(line.includes('耗时 12 秒'), line);
  assert.ok(line.indexOf('缓存') < line.indexOf('耗时'), 'the turn time follows the cache receipt: ' + line);
  assert.ok(line.indexOf('耗时') < line.indexOf('14:31'), 'the clock stays last: ' + line);
  assert.equal(usageEl.querySelectorAll('i').length, 3, 'one separator dot per segment boundary');
  assert.equal(w.liveTurnDurations.size, 1, 'the re-render replaces its element instead of leaking another');
});

test('finalizing freezes the value and releases the ticker', (t) => {
  const w = createWindow(t);
  const message = mount(w, { turnStartedAt: String(FIXED_NOW) });
  const usageEl = w.ensureMessageUsage(message);
  w.renderMessageUsage(usageEl, null, null, undefined, { pending: true });

  w.__now = FIXED_NOW + 15_000;
  w.freezeTurnDuration(message);
  const frozen = text(usageEl.querySelector('.message-usage-duration-value'));
  assert.equal(frozen, '15 秒');
  assert.equal(message.dataset.durationMs, '15000');
  assert.ok(message.dataset.turnFinishedAt, 'the finish stamp is recorded');
  assert.equal(usageEl.querySelector('.message-usage-duration').classList.contains('is-running'), false);
  assert.equal(w.liveTurnDurations.size, 0, 'no element is left ticking');
  assert.equal(w.liveTurnDurationTimer, 0, 'the interval is released');

  // Ticks must not resurrect a finished turn, and a re-render keeps the value.
  w.__now = FIXED_NOW + 90_000;
  w.tickLiveTurnDurations();
  assert.equal(text(usageEl.querySelector('.message-usage-duration-value')), '15 秒');
  w.renderMessageUsage(usageEl, 111, 22, 33);
  assert.equal(text(usageEl.querySelector('.message-usage-duration-value')), '15 秒');
  assert.ok(text(usageEl).indexOf('缓存') < text(usageEl).indexOf('耗时'), text(usageEl));
});

test('a restored turn renders the persisted duration as static text', (t) => {
  const w = createWindow(t);
  const message = mount(w, { durationMs: '65000' });
  const usageEl = w.ensureMessageUsage(message);
  w.renderMessageUsage(usageEl, 100, 20, 30);

  const line = text(usageEl);
  assert.ok(line.includes('耗时 1 分 05 秒'), line);
  assert.equal(usageEl.querySelector('.message-usage-duration').classList.contains('is-running'), false);
  assert.equal(w.liveTurnDurations.size, 0);

  const noUsage = mount(w, { durationMs: '9000' });
  const noUsageEl = w.ensureMessageUsage(noUsage);
  w.renderMessageUsage(noUsageEl, 0, 0, undefined, { pending: true });
  const onlyDuration = text(noUsageEl);
  assert.ok(onlyDuration.includes('耗时 9 秒'), onlyDuration);
  assert.ok(!onlyDuration.includes('入'), onlyDuration);
});

test('a message without any duration renders exactly as before', (t) => {
  const w = createWindow(t);
  const message = mount(w, {});
  const usageEl = w.ensureMessageUsage(message);
  w.renderMessageUsage(usageEl, 80739, 19398, 79104);
  const line = text(usageEl);
  assert.ok(!line.includes('耗时'), line);
  assert.equal(usageEl.querySelectorAll('i').length, 2, 'no extra separator without a duration');
  assert.equal(w.liveTurnDurations.size, 0);
});

test('the turn start, freeze and persistence are wired into the real flows', () => {
  assert.ok(appSource.includes('const turnStartedAt = Date.now();'), 'the renderer stamps the send');
  assert.ok(appSource.includes('{ streaming: true, turnStartedAt }'), 'the stamp reaches the live message');
  assert.ok(/function finalizeAssistantMessage\(messageEl\) \{\s*if \(!messageEl\) return;\s*freezeTurnDuration\(messageEl\);/.test(appSource),
    'finalize freezes the counter');
  assert.ok(appSource.includes('msg.dataset.turnStartedAt'), 'live messages carry a start stamp');
  assert.ok(appSource.includes('el.dataset.durationMs = String(durationMs)'), 'history restores the persisted duration');

  const server = fs.readFileSync(path.join(root, 'src/main/server.ts'), 'utf8');
  assert.ok(server.includes('durationMs?: number;'), 'the message record stores the duration');
  assert.ok(server.includes('const durationMs = turnStartedAt > 0 ? Math.max(0, Date.now() - turnStartedAt) : undefined;'),
    'the server measures wall-clock time');
  assert.equal((server.match(/transcriptRecorder\.snapshot\(\), chatTurnStartedAt\)/g) || []).length, 3,
    'done, error and cancelled all persist the duration');
});
