'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync(path.join(__dirname, '../src/renderer/components/QuestionCard.js'), 'utf8');

function fixture(t, jsonImpl) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  require('./helpers/install-i18n')(w);
  w.IexaApi = { json: jsonImpl || (async () => ({ ok: true })) };
  w.eval(script);
  return w;
}

function mountOptions(w) {
  const host = w.document.getElementById('host');
  return { apiBase: '', mount: (el) => host.appendChild(el) };
}

const multiData = {
  id: 'ask_1', sessionId: 's', toolCallId: 't1', title: '部署确认',
  questions: [
    { id: 'q1', header: '方案', question: '用哪个方案？', options: [{ label: 'A' }, { label: 'B', description: '更快' }], multiSelect: false, allowFreeText: false, kind: 'choice' },
    { id: 'q2', question: '补充说明', options: [], multiSelect: false, allowFreeText: true, kind: 'text' },
  ],
};

test('multi-question card answers one by one and submits a single payload', async (t) => {
  const calls = [];
  const w = fixture(t, async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true }; });
  const host = w.document.getElementById('host');
  w.IexaQuestionCard.show(multiData, mountOptions(w));
  const card = host.querySelector('.question-card');
  assert.ok(card);
  assert.equal(card.dataset.state, 'awaiting');
  assert.equal(card.querySelector('.question-card-title').textContent, '部署确认');
  assert.match(card.querySelector('.question-card-progress').textContent, /1 \/ 2/);

  const next = () => card.querySelector('.question-next');
  assert.equal(next().disabled, true, 'cannot advance before answering');
  card.querySelectorAll('.question-option')[0].click();
  assert.equal(card.querySelectorAll('.question-option')[0].getAttribute('aria-checked'), 'true');
  assert.equal(next().disabled, false);
  next().click();
  await new Promise((resolve) => w.setTimeout(resolve, 0));
  assert.match(card.querySelector('.question-card-progress').textContent, /2 \/ 2/);

  const area = card.querySelector('.question-free-input');
  area.value = '备注内容';
  area.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(next().textContent, '提交');
  next().click();
  await new Promise((resolve) => w.setTimeout(resolve, 25));

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/questions/answer');
  assert.deepEqual(calls[0][1], {
    id: 'ask_1',
    answers: [
      { id: 'q1', selected: ['A'], skipped: false },
      { id: 'q2', selected: [], freeText: '备注内容', skipped: false },
    ],
  });
  assert.equal(card.dataset.state, 'submitted');
  assert.match(card.querySelector('.question-card-note').textContent, /已提交/);
  assert.equal(card.querySelector('.question-answer-a').textContent, 'A');
});

test('skip marks a question and the card stays deduplicated across redelivery', async (t) => {
  const w = fixture(t);
  const host = w.document.getElementById('host');
  const options = mountOptions(w);
  w.IexaQuestionCard.show(multiData, options);
  w.IexaQuestionCard.show(multiData, options);
  assert.equal(host.querySelectorAll('.question-card').length, 1);

  const card = host.querySelector('.question-card');
  card.querySelector('.question-skip').click();
  await new Promise((resolve) => w.setTimeout(resolve, 0));
  const dots = card.querySelectorAll('.question-dot');
  assert.equal(dots.length, 2);
  assert.ok(dots[0].classList.contains('is-skipped'));
  assert.match(card.querySelector('.question-card-progress').textContent, /2 \/ 2/);
});

test('a terminal tool state closes an unanswered card', (t) => {
  const w = fixture(t);
  const host = w.document.getElementById('host');
  w.IexaQuestionCard.show(multiData, mountOptions(w));
  w.IexaQuestionCard.applyToolState('t1', 'cancelled');
  const card = host.querySelector('.question-card');
  assert.equal(card.dataset.state, 'closed');
  assert.match(card.querySelector('.question-card-note').textContent, /停止/);
  w.IexaQuestionCard.applyToolState('t1', 'completed');
  assert.equal(card.dataset.state, 'closed');
});

test('confirm card submits immediately when a decision is clicked', async (t) => {
  const calls = [];
  const w = fixture(t, async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true }; });
  const host = w.document.getElementById('host');
  w.IexaQuestionCard.show({
    id: 'ask_2', sessionId: 's', toolCallId: 't2', title: '确认',
    questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '确认' }, { label: '取消' }], multiSelect: false, allowFreeText: false, kind: 'confirm' }],
  }, mountOptions(w));
  const card = host.querySelector('.question-card');
  card.querySelectorAll('.question-option')[1].click();
  await new Promise((resolve) => w.setTimeout(resolve, 25));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].answers[0].selected, ['取消']);
  assert.equal(card.dataset.state, 'submitted');
});

test('syncPending renders missing cards and expires stale local ones', async (t) => {
  const w = fixture(t, async (url) => {
    if (String(url).startsWith('/api/questions?')) {
      return {
        questions: [{
          id: 'ask_9', sessionId: 's2', title: '新问题',
          questions: [{ id: 'q1', question: 'Q?', options: [{ label: 'A' }], multiSelect: false, allowFreeText: false, kind: 'choice' }],
        }],
      };
    }
    return { ok: true };
  });
  const host = w.document.getElementById('host');
  const options = mountOptions(w);
  options.isCurrent = () => true;
  await w.IexaQuestionCard.syncPending('s2', options);
  assert.equal(host.querySelectorAll('.question-card').length, 1);
  await w.IexaQuestionCard.syncPending('s2', options);
  assert.equal(host.querySelectorAll('.question-card').length, 1);

  const stale = fixture(t, async (url) => {
    if (String(url).startsWith('/api/questions?')) return { questions: [] };
    return { ok: true };
  });
  const staleHost = stale.document.getElementById('host');
  stale.IexaQuestionCard.show(Object.assign({}, multiData, { id: 'ask_7' }), { apiBase: '', mount: (el) => staleHost.appendChild(el) });
  await stale.IexaQuestionCard.syncPending('s', { apiBase: '', mount: (el) => staleHost.appendChild(el) });
  assert.equal(staleHost.querySelector('.question-card').dataset.state, 'closed');
});

test('disableForSession stops input after a turn cancel', (t) => {
  const w = fixture(t);
  const host = w.document.getElementById('host');
  w.IexaQuestionCard.show(multiData, mountOptions(w));
  w.IexaQuestionCard.disableForSession('s', 'cancelled');
  const card = host.querySelector('.question-card');
  assert.equal(card.dataset.state, 'closed');
  assert.match(card.querySelector('.question-card-note').textContent, /停止/);
  // The interactive controls are replaced by the read-only summary.
  assert.equal(card.querySelector('.question-option'), null);
  assert.equal(card.querySelector('.question-card-actions').hidden, true);
});

test('answered cards fold into a one-line summary and expand on demand', async (t) => {
  const w = fixture(t);
  const host = w.document.getElementById('host');
  w.IexaQuestionCard.show(multiData, mountOptions(w));
  const card = host.querySelector('.question-card');
  const tick = (ms) => new Promise((resolve) => w.setTimeout(resolve, ms));

  // Answer q1, skip q2, submit as usual.
  card.querySelectorAll('.question-option')[0].click();
  card.querySelector('.question-next').click();
  await tick(0);
  card.querySelector('.question-skip').click();
  card.querySelector('.question-next').click();
  await tick(25);

  assert.equal(card.dataset.state, 'submitted');
  // Folded automatically, answers previewed on one line.
  assert.ok(card.classList.contains('is-collapsed'), 'submitted card must fold');
  const toggle = card.querySelector('.question-card-toggle');
  const preview = card.querySelector('.question-card-preview');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.title, '展开回答详情');
  assert.equal(preview.hidden, false);
  assert.equal(preview.textContent, 'A · （跳过）');
  // The folded head shows the question that was asked, plus a question count.
  assert.equal(card.querySelector('.question-card-title').textContent, '用哪个方案？');
  const qmore = card.querySelector('.question-card-qmore');
  assert.equal(qmore.hidden, false);
  assert.equal(qmore.textContent, '共 2 题');

  // Manual expand brings the full summary back.
  toggle.click();
  assert.equal(card.classList.contains('is-collapsed'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.title, '收起回答详情');
  assert.equal(preview.hidden, true);
  assert.equal(card.querySelector('.question-card-title').textContent, '部署确认');
  assert.equal(card.querySelector('.question-card-qmore').hidden, true);
  assert.equal(card.querySelector('.question-answer-a').textContent, 'A');

  // And it folds again by hand.
  toggle.click();
  assert.equal(card.classList.contains('is-collapsed'), true);
  assert.equal(preview.hidden, false);
  assert.equal(preview.textContent, 'A · （跳过）');
});

test('cancelled cards fold too and the preview carries the outcome note', async (t) => {
  const w = fixture(t);
  const host = w.document.getElementById('host');
  w.IexaQuestionCard.show(multiData, mountOptions(w));
  const card = host.querySelector('.question-card');

  card.querySelector('.question-card-close').click();
  await new Promise((resolve) => w.setTimeout(resolve, 25));

  assert.equal(card.dataset.state, 'closed');
  assert.ok(card.classList.contains('is-collapsed'), 'closed card must fold');
  const preview = card.querySelector('.question-card-preview');
  assert.equal(preview.hidden, false);
  assert.match(preview.textContent, /已取消/);
  assert.equal(card.querySelector('.question-card-title').textContent, '用哪个方案？');
  assert.equal(card.querySelector('.question-card-qmore').hidden, false);

  // Expand by chevron, fold again, then expand by clicking the preview line.
  card.querySelector('.question-card-toggle').click();
  assert.equal(card.classList.contains('is-collapsed'), false);
  assert.match(card.querySelector('.question-card-note').textContent, /已取消/);
  assert.equal(card.querySelector('.question-card-title').textContent, '部署确认');
  card.querySelector('.question-card-toggle').click();
  assert.equal(card.classList.contains('is-collapsed'), true);
  preview.click();
  assert.equal(card.classList.contains('is-collapsed'), false);
});
