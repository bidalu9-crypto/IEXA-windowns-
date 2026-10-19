// Restored turns must keep the task bar the live turn had. Transcript replay
// used to build replacement rails without one, so after a restart a folded
// turn came back as a wall of visible tool rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, flatten } = require('./helpers/transcript-harness.cjs');

function transcriptMessage(items, calls, extra = {}) {
  return {
    role: 'assistant',
    content: '完成。',
    thinking: 'R1R2',
    ...extra,
    toolCalls: calls,
    transcript: { version: 1, valid: true, turnId: 'turn-1', revision: 0, status: 'completed', items },
  };
}

test('restored rails get a task bar and the fold applies to each of them', (t) => {
  const { w, message } = create(t);
  w.document.documentElement.setAttribute('data-collapse-tools', 'on');
  const attached = [];
  w.IexaToolRail = { attach: (host) => attached.push(host) };
  message.querySelector('.message-content').textContent = '完成。';
  for (const id of ['t1', 't2']) {
    w.handleToolStart(id, 'shell_execute');
    w.handleToolComplete(id, 'shell_execute', { command: 'echo ' + id });
  }
  const restored = w.restoreTranscriptOrder(message, transcriptMessage([
    { type: 'thinking', id: 'turn-1:1', sequence: 1, timestamp: 1, start: 0, end: 2 },
    { type: 'tool', id: 'turn-1:2', sequence: 2, timestamp: 2, callId: 't1', name: 'shell_execute' },
    { type: 'thinking', id: 'turn-1:3', sequence: 3, timestamp: 3, start: 2, end: 4 },
    { type: 'tool', id: 'turn-1:4', sequence: 4, timestamp: 4, callId: 't2', name: 'shell_execute' },
    { type: 'text', id: 'turn-1:5', sequence: 5, timestamp: 5, start: 0, end: 3 },
  ], [
    { id: 't1', name: 'shell_execute', args: { command: 'echo t1' }, result: { success: true, output: 't1' } },
    { id: 't2', name: 'shell_execute', args: { command: 'echo t2' }, result: { success: true, output: 't2' } },
  ]));

  assert.equal(restored, true);
  assert.deepEqual(flatten(message), [
    ['thinking', 'R1'], ['tool', 't1'], ['thinking', 'R2'], ['tool', 't2'], ['text', '完成。'],
  ]);
  const rails = [...message.querySelectorAll('.tool-steps')];
  assert.equal(rails.length, 2, 'a think/tool alternation still opens one rail per contiguous run');
  for (const rail of rails) {
    assert.ok(attached.includes(rail), 'every rail must be handed to the task-bar builder');
    assert.equal(rail.querySelectorAll(':scope > .tool-block').length, 1);
  }
});

test('rail ids survive adoption: a row keeps its element when replay reuses the legacy rail', (t) => {
  const { w, message } = create(t);
  w.document.documentElement.setAttribute('data-collapse-tools', 'on');
  w.IexaToolRail = { attach: () => {} };
  message.querySelector('.message-content').textContent = '完成。';
  w.handleToolStart('t1', 'shell_execute');
  w.handleToolComplete('t1', 'shell_execute', { command: 'echo t1' });
  const row = w.currentToolBlocks.t1.block;
  row.querySelector('.tool-result').textContent = 'kept';
  assert.equal(w.restoreTranscriptOrder(message, transcriptMessage([
    { type: 'tool', id: 'turn-1:1', sequence: 1, timestamp: 1, callId: 't1', name: 'shell_execute' },
    { type: 'text', id: 'turn-1:2', sequence: 2, timestamp: 2, start: 0, end: 3 },
  ], [{ id: 't1', name: 'shell_execute', args: {}, result: { success: true, output: 't1' } }], { thinking: '' })), true);
  assert.equal(message.querySelector('[data-tool-id="t1"]'), row);
  assert.equal(row.querySelector('.tool-result').textContent, 'kept');
});

test('with the fold off, reasoning stays inside the chain as one rail', (t) => {
  const { w, message } = create(t);
  w.document.documentElement.setAttribute('data-collapse-tools', 'off');
  w.IexaToolRail = { attach: () => {} };
  message.querySelector('.message-content').textContent = '完成。';
  for (const id of ['t1', 't2']) {
    w.handleToolStart(id, 'shell_execute');
    w.handleToolComplete(id, 'shell_execute', { command: 'echo ' + id });
  }
  assert.equal(w.restoreTranscriptOrder(message, transcriptMessage([
    { type: 'thinking', id: 'turn-1:1', sequence: 1, timestamp: 1, start: 0, end: 2 },
    { type: 'tool', id: 'turn-1:2', sequence: 2, timestamp: 2, callId: 't1', name: 'shell_execute' },
    { type: 'thinking', id: 'turn-1:3', sequence: 3, timestamp: 3, start: 2, end: 4 },
    { type: 'tool', id: 'turn-1:4', sequence: 4, timestamp: 4, callId: 't2', name: 'shell_execute' },
  ], [
    { id: 't1', name: 'shell_execute', args: {}, result: { success: true, output: 't1' } },
    { id: 't2', name: 'shell_execute', args: {}, result: { success: true, output: 't2' } },
  ], { content: '' })), true);
  assert.equal(message.querySelectorAll('.tool-steps').length, 1);
  const rail = message.querySelector('.tool-steps');
  assert.equal(rail.querySelectorAll(':scope > .tool-block').length, 2);
  assert.equal(rail.querySelectorAll(':scope > .thinking-block').length, 1);
});
