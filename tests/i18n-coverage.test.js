// Three locales, and every wired string must exist in all of them. A missing
// entry silently falls back to Chinese, which looks like "translation done" to
// anyone testing in English while a panel quietly stays Chinese.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');

function loadI18n() {
  const sandbox = { window: {}, localStorage: { getItem: () => null, setItem: () => {} }, document: undefined };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  for (const file of ['services/I18nUi.js', 'services/I18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox.window;
}

test('every static string has zh, en and ja', () => {
  const win = loadI18n();
  const ui = win.IexaI18nUi;
  assert.ok(ui, 'I18nUi is exposed');
  const keys = Object.keys(ui.zh);
  assert.ok(keys.length >= 300, 'the static table covers the markup: ' + keys.length);

  const missing = [];
  for (const key of keys) {
    for (const locale of ['zh', 'en', 'ja']) {
      const value = ui[locale][key];
      if (typeof value !== 'string' || !value.trim()) missing.push(`${locale}:${key}`);
    }
  }
  assert.deepEqual(missing, [], 'no locale may leave a string blank');

  // Same key set in all three, so a one-line edit cannot shift the others.
  assert.deepEqual(Object.keys(ui.en).sort(), keys.slice().sort());
  assert.deepEqual(Object.keys(ui.ja).sort(), keys.slice().sort());
});

test('the locales are actually different, not copies of Chinese', () => {
  const ui = loadI18n().IexaI18nUi;
  const cjk = /[\u3040-\u30ff\u4e00-\u9fff]/;
  // Japanese legitimately shares kanji with Chinese, so check the reverse: the
  // English table must be free of CJK, which catches a pasted-through fallback.
  const leaked = Object.entries(ui.en).filter(([, v]) => cjk.test(v)).map(([k]) => k);
  assert.deepEqual(leaked, [], 'English must not contain CJK text');
  const identical = Object.keys(ui.zh).filter((k) => ui.zh[k] === ui.ja[k]);
  assert.ok(identical.length < 30, 'too many ja entries equal the zh source: ' + identical.length);
});

test('ja-JP resolves and falls through to zh only for unknown keys', () => {
  const win = loadI18n();
  const { t, setLocale, normalize } = win.IexaI18n;
  assert.equal(normalize('ja'), 'ja-JP');
  assert.equal(normalize('ja-JP'), 'ja-JP');
  setLocale('ja');
  assert.equal(t('ui.1'), 'プロジェクトと会話');
  assert.equal(t('nav.chat'), '会話', 'the pre-existing table is merged in');
  assert.equal(t('does.not.exist'), 'does.not.exist');
  setLocale('zh-CN');
  assert.equal(t('ui.1'), '项目与对话');
});

test('every data-i18n hook in the markup resolves to a real key', () => {
  const win = loadI18n();
  const dict = win.IexaI18n.dictionaries;
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
  const unknown = [...used].filter((key) => !dict['zh-CN'][key]);
  assert.deepEqual(unknown, [], 'wired keys without a translation');
  assert.ok(used.size >= 300, 'the markup should expose hundreds of keys: ' + used.size);
});

test('switching locale rewrites the live DOM', () => {
  const win = loadI18n();
  // A minimal DOM stand-in: apply() only needs querySelectorAll over the four hooks.
  const nodes = [
    { dataset: { i18n: 'ui.1' }, textContent: '项目与对话' },
    { dataset: { i18nPlaceholder: 'ui.p1' }, placeholder: '搜索会话' },
  ];
  const document = { querySelectorAll: (sel) => nodes.filter((n) => sel === '[data-i18n]' ? n.dataset.i18n : sel === '[data-i18n-placeholder]' ? n.dataset.i18nPlaceholder : false) };
  win.IexaI18n.applyForTest?.(document);
  // apply() is exported; call it directly with the stand-in document.
  win.IexaI18n.setLocale('en');
  win.IexaI18n.apply(document);
  assert.equal(nodes[0].textContent, 'Projects & chats');
  assert.equal(nodes[1].placeholder, 'Search conversations');
});

// The hooks above are only half the job: a hover title or an aria label that
// stays Chinese is invisible in a screenshot, so it needs a real DOM check.
test('hover titles and aria labels follow the locale in the real markup', () => {
  const dom = new JSDOM(fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:19840/',
  });
  const win = dom.window;
  for (const file of ['services/I18nUi.js', 'services/I18n.js']) {
    win.eval(fs.readFileSync(path.join(RENDERER, file), 'utf8'));
  }

  const titles = [...win.document.querySelectorAll('[data-i18n-title]')];
  const labels = [...win.document.querySelectorAll('[data-i18n-aria]')];
  assert.ok(titles.length >= 60, 'hover titles are wired: ' + titles.length);
  assert.ok(labels.length >= 90, 'aria labels are wired: ' + labels.length);

  const cjk = /[\u4e00-\u9fa5]/;
  win.IexaI18n.setLocale('en');
  const chineseTitles = titles.filter((el) => cjk.test(el.title)).map((el) => el.dataset.i18nTitle);
  assert.deepEqual(chineseTitles, [], 'an English hover title must not stay Chinese');
  const chineseLabels = labels.filter((el) => cjk.test(el.getAttribute('aria-label'))).map((el) => el.dataset.i18nAria);
  assert.deepEqual(chineseLabels, [], 'an English aria label must not stay Chinese');

  const button = win.document.getElementById('mobileMenuBtn');
  assert.equal(button.title, 'Open navigation');
  assert.equal(button.getAttribute('aria-label'), 'Open navigation');

  win.IexaI18n.setLocale('ja');
  assert.equal(button.title, 'ナビゲーションを開く');

  win.IexaI18n.setLocale('zh-CN');
  assert.equal(button.title, '打开导航');
  assert.equal(button.getAttribute('aria-label'), '打开导航');
  dom.window.close();
});
