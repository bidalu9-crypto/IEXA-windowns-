'use strict';
// The composer dock mirrors DeepSeek Harness's conversation.input.dock: the
// task plan (order 0) and the queued prompts (order 20) share one stack above
// the input card, and the container hides itself when both are empty.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function fixture() {
  const dom = new JSDOM(fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window;
  require('./helpers/install-i18n')(w);
  w.uiIcon = () => '<svg class="ui-icon"></svg>';
  for (const file of ['ComposerDock', 'PlanDock', 'QueueDock']) {
    w.eval(fs.readFileSync(path.join(RENDERER, 'services', file + '.js'), 'utf8'));
  }
  return { dom, w };
}

test('the task dock starts collapsed, counts statuses, and opens on demand', () => {
  const { dom, w } = fixture();
  try {
    w.IexaPlanDock.setTodos('s1', [
      { content: '读代码', status: 'completed' },
      { content: '写方案', status: 'in_progress' },
      { content: '施工', status: 'pending' },
    ]);
    const section = w.document.getElementById('planDock');
    assert.equal(section.hidden, false);
    assert.equal(section.dataset.collapsed, 'true');
    assert.match(w.document.querySelector('#planDock .dock-progress').textContent, /1 已完成/);
    assert.match(w.document.querySelector('#planDock .dock-progress').textContent, /1 进行中/);
    assert.equal(w.document.querySelectorAll('#planDock .dock-list-item').length, 0);

    w.document.querySelector('#planDock .dock-toggle').click();
    const rows = [...w.document.querySelectorAll('#planDock .dock-list-item')];
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.className.split(' ')[1]),
      ['is-done', 'is-active', 'is-pending']);
    assert.equal(section.dataset.collapsed, 'false');
  } finally {
    dom.window.close();
  }
});

test('dismissing the plan hides it until a new plan arrives', () => {
  const { dom, w } = fixture();
  try {
    const first = [{ content: '一', status: 'pending' }];
    w.IexaPlanDock.setTodos('s1', first);
    w.document.querySelector('#planDock .dock-dismiss').click();
    assert.equal(w.document.getElementById('planDock').hidden, true);
    assert.equal(w.document.getElementById('composerDock').hidden, true);

    w.IexaPlanDock.setTodos('s1', first);
    assert.equal(w.document.getElementById('planDock').hidden, true, 'same plan stays dismissed');

    w.IexaPlanDock.setTodos('s1', [{ content: '二', status: 'pending' }]);
    assert.equal(w.document.getElementById('planDock').hidden, false, 'a new plan reopens');
  } finally {
    dom.window.close();
  }
});

test('queued prompts sit above the composer and collapse past three rows', () => {
  const { dom, w } = fixture();
  try {
    const withdrawn = [];
    w.withdrawQueuedMessage = (id) => withdrawn.push(id);
    w.IexaQueueDock.setQueue('s1', [
      { id: 'a', text: '第一条', mode: 'queue' },
      { id: 'b', text: '第二条', mode: 'queue' },
      { id: 'c', text: '第三条', mode: 'interrupt' },
      { id: 'd', text: '第四条', mode: 'queue' },
    ]);
    const section = w.document.getElementById('queueDock');
    assert.equal(section.hidden, false);
    assert.equal(w.document.querySelectorAll('.dock-queue-chip').length, 3);
    assert.equal(w.document.querySelector('.dock-more').hidden, false);
    assert.match(w.document.querySelector('.dock-more').textContent, /\+1/);

    w.document.querySelector('.dock-more').click();
    assert.equal(w.document.querySelectorAll('.dock-queue-chip').length, 4);

    w.document.querySelector('.dock-queue-chip .dock-icon-btn:last-child').click();
    assert.deepEqual(withdrawn, ['a']);
  } finally {
    dom.window.close();
  }
});

test('history recovery reads the last todo_write plan', () => {
  const { dom, w } = fixture();
  try {
    const messages = [
      { role: 'assistant', toolCalls: [{ name: 'todo_write', result: { todos: [{ content: '旧', status: 'completed' }] } }] },
      { role: 'assistant', toolCalls: [{ name: 'todo_write', result: { todos: [{ content: '新', status: 'in_progress' }] } }] },
      { role: 'user', content: '继续' },
    ];
    const todos = w.IexaPlanDock.extractTodos(messages);
    assert.deepEqual(todos, [{ content: '新', status: 'in_progress' }]);
  } finally {
    dom.window.close();
  }
});
