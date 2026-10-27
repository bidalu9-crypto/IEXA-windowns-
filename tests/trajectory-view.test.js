'use strict';
// The trajectory tab is a pure projection over persisted messages: it never
// mutates the transcript, and its rows keep the tool call identity so Inspect
// can land on the exact record.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function fixture(messages) {
  const dom = new JSDOM(fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window;
  require('./helpers/install-i18n')(w);
  w.uiIcon = () => '<svg class="ui-icon"></svg>';
  w.currentSessionId = 's1';
  w.API_BASE = '';
  w.fetch = async () => ({ ok: true, json: async () => ({ messages }) });
  w.eval(fs.readFileSync(path.join(RENDERER, 'services', 'TrajectoryView.js'), 'utf8'));
  return { dom, w };
}

const MESSAGES = [
  { role: 'user', content: '帮我改造界面', timestamp: 1793000000000 },
  {
    role: 'assistant',
    content: '好的，先看代码。',
    timestamp: 1793000005000,
    durationMs: 5000,
    usage: { inputTokens: 1200, outputTokens: 300 },
    thinking: '先读文件',
    transcript: {
      items: [
        { type: 'thinking', start: 0, end: 4, sequence: 1, id: 'x:1', timestamp: 1793000001000, durationMs: 800 },
        { type: 'tool', start: 0, end: 0, sequence: 2, id: 'call1', timestamp: 1793000002000, durationMs: 120 },
      ],
    },
    toolCalls: [{ id: 'call1', name: 'file_read', args: { path: 'src/app.js' }, result: { success: true, durationMs: 120, output: 'ok' } }],
  },
];

test('the ledger projects user, thinking, tool and reply records', async () => {
  const { dom, w } = fixture(MESSAGES);
  try {
    w.IexaTrajectory.setView('trajectory');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const rows = [...w.document.querySelectorAll('.trajectory-row')];
    assert.deepEqual(rows.map((row) => row.dataset.kind), ['user', 'thinking', 'tool', 'assistant']);
    assert.equal(w.document.querySelector('.chat-messages-area').hidden, true);
    assert.equal(w.document.getElementById('trajectoryView').hidden, false);
  } finally {
    dom.window.close();
  }
});

test('a forced refresh re-reads the session even when a runtime snapshot exists', async () => {
  const { dom, w } = fixture(MESSAGES);
  try {
    const fresh = MESSAGES.concat([
      { role: 'user', content: '补充要求', timestamp: 1793000010000 },
      { role: 'assistant', content: '新的回复', timestamp: 1793000015000 },
    ]);
    w.fetch = async () => ({ ok: true, json: async () => ({ messages: fresh }) });
    // A stale snapshot is exactly what the first cut rendered forever.
    w.sessionRuntimes = new Map([['s1', { historyMessages: MESSAGES.slice() }]]);
    w.IexaTrajectory.setView('trajectory');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const count = Number(w.document.getElementById('trajectoryCount').textContent);
    assert.equal(count, 6, 'setView must fetch the persisted session, not the stale snapshot');
    const button = w.document.getElementById('trajectoryRefresh');
    assert.equal(button.disabled, false);
  } finally {
    dom.window.close();
  }
});

test('switching back restores the conversation surface', async () => {
  const { dom, w } = fixture(MESSAGES);
  try {
    w.IexaTrajectory.setView('trajectory');
    await new Promise((resolve) => setTimeout(resolve, 40));
    w.IexaTrajectory.setView('conversation');
    assert.equal(w.document.querySelector('.chat-messages-area').hidden, false);
    assert.equal(w.document.getElementById('trajectoryView').hidden, true);
  } finally {
    dom.window.close();
  }
});

test('focusCall selects the record and fills the inspector', async () => {
  const { dom, w } = fixture(MESSAGES);
  try {
    w.IexaTrajectory.setView('trajectory');
    await new Promise((resolve) => setTimeout(resolve, 40));
    w.IexaTrajectory.focusCall('call1');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const selected = w.document.querySelector('.trajectory-row.is-selected');
    assert.ok(selected, 'a row is selected');
    assert.equal(selected.dataset.callId, 'call1');
    const inspector = w.document.getElementById('trajectoryInspector');
    assert.equal(inspector.hidden, false);
    assert.match(inspector.textContent, /src\/app\.js/);
    assert.match(inspector.textContent, /ok/);
  } finally {
    dom.window.close();
  }
});

test('the tool filter hides non-tool rows', async () => {
  const { dom, w } = fixture(MESSAGES);
  try {
    w.IexaTrajectory.setView('trajectory');
    await new Promise((resolve) => setTimeout(resolve, 40));
    w.document.querySelector('[data-trajectory-filter="tool"]').click();
    const rows = [...w.document.querySelectorAll('.trajectory-row')];
    assert.deepEqual(rows.map((row) => row.dataset.kind), ['tool']);
  } finally {
    dom.window.close();
  }
});
