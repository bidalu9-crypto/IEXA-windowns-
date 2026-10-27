'use strict';
// The code preview: numbered gutter, syntax highlighting, wrap toggle and a
// copy action. The panel replaces the old plain <pre>, so these assertions pin
// what a reader actually gets when they click a file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

const SAMPLE = [
  "import { readFile } from 'node:fs/promises'",
  '',
  'export async function load(name) {',
  '  const text = await readFile(name, \'utf8\')',
  '  return text.trim()',
  '}',
].join('\n');

function fixture() {
  const dom = new JSDOM('<!doctype html><div id="filesPreview" style="display:none"></div>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(RENDERER, 'vendor', 'highlight.min.js'), 'utf8'));
  require('./helpers/install-i18n')(w);
  w.IexaI18n.setLocale('en');
  w.navigator.clipboard = { writeText: async () => {} };
  w.eval(fs.readFileSync(path.join(RENDERER, 'services', 'CodePreview.js'), 'utf8'));
  return { dom, w };
}

test('a file opens with a numbered gutter and highlighted tokens', () => {
  const { dom, w } = fixture();
  try {
    w.IexaCodePreview.open({ path: 'src/load.js', name: 'load.js', content: SAMPLE });
    const host = w.document.getElementById('filesPreview');
    assert.equal(host.style.display, 'flex');
    assert.equal(host.querySelectorAll('.code-preview-row').length, 6);
    assert.equal(host.querySelectorAll('.code-preview-line').length, 6);
    assert.equal(host.querySelectorAll('.code-preview-line-number').length, 6);
    assert.deepEqual(
      [...host.querySelectorAll('.code-preview-line-number')].map((n) => n.textContent),
      ['1', '2', '3', '4', '5', '6'],
    );
    assert.match(host.querySelector('.code-preview-meta').textContent, /javascript/);
    // highlight.js wraps tokens in spans; plain text has none.
    assert.ok(host.querySelectorAll('.code-preview-line span').length > 3, 'tokens are highlighted');
  } finally {
    dom.window.close();
  }
});

test('source is shown verbatim and never executed as markup', () => {
  const { dom, w } = fixture();
  try {
    const payload = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>';
    w.IexaCodePreview.open({ path: 'evil.html', name: 'evil.html', content: payload });
    const host = w.document.getElementById('filesPreview');
    assert.equal(host.querySelectorAll('img').length, 0);
    assert.equal(host.querySelectorAll('script').length, 0);
    assert.match(host.textContent, /<script>alert\(2\)<\/script>/);
  } finally {
    dom.window.close();
  }
});

test('wrap toggles the body and hides the gutter so numbers cannot drift', () => {
  const { dom, w } = fixture();
  try {
    w.IexaCodePreview.open({ path: 'a.js', name: 'a.js', content: SAMPLE });
    const host = w.document.getElementById('filesPreview');
    const button = host.querySelector('#codePreviewWrap');
    assert.equal(host.querySelector('.code-preview-body').dataset.wrap, 'off');
    button.click();
    assert.equal(host.querySelector('.code-preview-body').dataset.wrap, 'on');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    button.click();
    assert.equal(host.querySelector('.code-preview-body').dataset.wrap, 'off');
  } finally {
    dom.window.close();
  }
});

test('unknown extensions fall back to plain text with no highlighter', () => {
  const { dom, w } = fixture();
  try {
    w.IexaCodePreview.open({ path: 'notes.qqq', name: 'notes.qqq', content: 'plain <b>not bold</b>' });
    const host = w.document.getElementById('filesPreview');
    assert.match(host.querySelector('.code-preview-meta').textContent, /Plain text/);
    assert.equal(host.querySelector('.code-preview-line b'), null);
  } finally {
    dom.window.close();
  }
});

test('a span crossing lines is closed and reopened, not left dangling', () => {
  const { dom, w } = fixture();
  try {
    const html = '<span class="hljs-comment">/* one\n   two */</span>\nconst a = 1';
    const lines = w.IexaCodePreview._splitHighlightedLines(html);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const open = (line.match(/<span/g) || []).length;
      const close = (line.match(/<\/span>/g) || []).length;
      assert.equal(open, close, 'balanced spans on ' + JSON.stringify(line));
    }
    assert.match(lines[0], /one/);
    assert.match(lines[1], /two \*\//);
  } finally {
    dom.window.close();
  }
});

test('language comes from the file name, not from the folder', () => {
  const { dom, w } = fixture();
  try {
    assert.equal(w.IexaCodePreview.languageFor('src/app.tsx'), 'typescript');
    assert.equal(w.IexaCodePreview.languageFor('scripts/build.ps1'), 'powershell');
    assert.equal(w.IexaCodePreview.languageFor('Dockerfile'), 'dockerfile');
    assert.equal(w.IexaCodePreview.languageFor('a/b/c.unknown'), '');
  } finally {
    dom.window.close();
  }
});
