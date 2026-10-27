'use strict';
// File cards expose the native actions from DeepSeek Harness (open / reveal)
// plus our explicit run action, which is gated by a confirmation and by the
// extension allowlist in the main process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function fixture() {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const calls = [];
  w.uiIcon = () => '<svg class="ui-icon"></svg>';
  w.IexaDialogs = { confirm: async () => true };
  w.iexaDesktop = {
    openFile: async (p) => { calls.push(['open', p]); return { ok: true }; },
    revealPath: async (p) => { calls.push(['reveal', p]); return { ok: true }; },
    runFile: async (p) => { calls.push(['run', p]); return { ok: true }; },
  };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  w.eval(fs.readFileSync(path.join(RENDERER, 'services', 'FileActions.js'), 'utf8'));
  return { dom, w, calls };
}

test('a file inside the open project offers a code preview', () => {
  const { dom, w } = fixture();
  try {
    const opened = [];
    w.IexaFilePreview = { root: () => 'C:/work', open: (rel) => opened.push(rel) };
    const card = w.IexaFileActions.create({ name: 'app.js', absolutePath: 'C:/work/src/app.js' });
    w.document.body.appendChild(card);
    card.querySelector('.file-action-main').click();
    const items = [...card.querySelectorAll('.file-action-item')];
    assert.equal(items[0].textContent, 'Preview');
    items[0].click();
    assert.deepEqual(opened, ['src/app.js']);
  } finally {
    dom.window.close();
  }
});

test('a file outside the project has no preview entry', () => {
  const { dom, w } = fixture();
  try {
    w.IexaFilePreview = { root: () => 'C:/work', open: () => {} };
    const card = w.IexaFileActions.create({ name: 'notes.txt', absolutePath: 'D:/elsewhere/notes.txt' });
    w.document.body.appendChild(card);
    card.querySelector('.file-action-main').click();
    const items = [...card.querySelectorAll('.file-action-item')].map((item) => item.textContent);
    assert.equal(items.includes('Preview'), false);
  } finally {
    dom.window.close();
  }
});

test('a runnable artifact offers open, reveal, run and copy', () => {
  const { dom, w } = fixture();
  try {
    const card = w.IexaFileActions.create({ name: 'run_test_se.bat', absolutePath: 'C:/work/run_test_se.bat' });
    w.document.body.appendChild(card);
    const main = card.querySelector('.file-action-main');
    main.click();
    const items = [...card.querySelectorAll('.file-action-item')].map((item) => item.textContent);
    assert.deepEqual(items, ['Open', 'Open containing folder', 'Run in terminal', 'Copy path']);
  } finally {
    dom.window.close();
  }
});

test('a plain text artifact hides the run action', () => {
  const { dom, w } = fixture();
  try {
    const card = w.IexaFileActions.create({ name: 'notes.md', absolutePath: 'C:/work/notes.md' });
    card.querySelector('.file-action-main').click();
    const items = [...card.querySelectorAll('.file-action-item')].map((item) => item.textContent);
    assert.equal(items.includes('Run in terminal'), false);
    assert.equal(items.length, 3);
  } finally {
    dom.window.close();
  }
});

test('the menu forwards open, reveal and run to the desktop bridge', async () => {
  const { dom, w, calls } = fixture();
  try {
    const card = w.IexaFileActions.create({ name: 'run.bat', absolutePath: 'C:/work/run.bat' });
    card.querySelector('.file-action-main').click();
    card.querySelectorAll('.file-action-item')[0].click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    card.querySelector('.file-action-main').click();
    card.querySelectorAll('.file-action-item')[1].click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    card.querySelector('.file-action-main').click();
    card.querySelectorAll('.file-action-item')[2].click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, [
      ['open', 'C:/work/run.bat'],
      ['reveal', 'C:/work/run.bat'],
      ['run', 'C:/work/run.bat'],
    ]);
  } finally {
    dom.window.close();
  }
});
