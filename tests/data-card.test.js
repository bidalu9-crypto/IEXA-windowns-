// The ```data-card protocol: parsing is separate from drawing, so it is checked
// here without a browser. Every rejection must name the field it refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function fixture(t) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(path.join(RENDERER, 'services', 'DataCard.js'), 'utf8'));
  return dom.window;
}

const VALID = {
  title: '广东今日油价',
  unit: '元/升',
  badge: '实时数据示例',
  items: [
    { label: '92号汽油', value: 8.91, tone: 'up' },
    { label: '95号汽油', value: '9.65' },
  ],
  note: '以上为演示数据',
};

test('a valid card is normalised, including numeric strings', (t) => {
  const w = fixture(t);
  const result = w.IexaDataCard.parseDataCard(JSON.stringify(VALID));
  assert.equal(result.ok, true);
  assert.equal(result.spec.title, '广东今日油价');
  assert.equal(result.spec.unit, '元/升');
  assert.equal(result.spec.badge, '实时数据示例');
  assert.equal(result.spec.items.length, 2);
  assert.equal(result.spec.items[0].value, 8.91);
  assert.equal(result.spec.items[1].value, 9.65, 'a numeric string becomes a number');
  assert.equal(result.spec.items[0].tone, 'up');
  assert.equal(result.spec.items[1].tone, '', 'an unknown tone is dropped, not trusted');
});

test('missing or unusable fields are refused with a readable reason', (t) => {
  const w = fixture(t);
  const cases = [
    [{ ...VALID, title: '' }, /title/],
    [{ ...VALID, items: [] }, /items/],
    [{ ...VALID, items: [{ label: '', value: 1 }] }, /label/],
    [{ ...VALID, items: [{ label: 'x', value: 'abc' }] }, /不是数值/],
    [{ ...VALID, items: [{ label: 'x', value: null }] }, /不是数值/],
    [{ title: 'x', items: Array.from({ length: 40 }, () => ({ label: 'a', value: 1 })) }, /数据项过多/],
    [[], /必须是一个 JSON 对象/],
  ];
  for (const [input, pattern] of cases) {
    const result = w.IexaDataCard.parseDataCard(JSON.stringify(input));
    assert.equal(result.ok, false, JSON.stringify(input).slice(0, 60));
    assert.match(result.error, pattern);
  }
});

test('a body that stops mid-value is incomplete, not an error', (t) => {
  const w = fixture(t);
  const partial = JSON.stringify(VALID).slice(0, 60);
  const result = w.IexaDataCard.parseDataCard(partial);
  assert.equal(result.ok, false);
  assert.equal(result.incomplete, true, 'mid-stream is not a failure');
});

test('values are trimmed for display without float noise', (t) => {
  const w = fixture(t);
  assert.equal(w.IexaDataCard.formatValue(8.91), '8.91');
  assert.equal(w.IexaDataCard.formatValue(8.6), '8.6');
  assert.equal(w.IexaDataCard.formatValue(9), '9');
  assert.equal(w.IexaDataCard.formatValue(8.910000000000001), '8.91');
});

test('the card is built from DOM nodes, never from model text as HTML', (t) => {
  const w = fixture(t);
  const parsed = w.IexaDataCard.parseDataCard(JSON.stringify({
    title: '<img src=x onerror=alert(1)>',
    items: [{ label: '<b>bold</b>', value: 1 }],
  }));
  const card = w.IexaDataCard.buildDataCard(parsed.spec);
  assert.equal(card.querySelector('img'), null, 'no element is created from the title');
  assert.equal(card.querySelector('.data-card-label').textContent, '<b>bold</b>',
    'markup stays literal text');
  assert.equal(card.querySelector('b').textContent, '1', 'the value element holds only the number');
});

test('a broken block degrades to a banner and leaves the rest of the message alone', (t) => {
  const w = fixture(t);
  const root = w.document.createElement('div');
  // Ends with a closing brace, so it is not mistaken for a half-streamed body:
  // this is a genuinely invalid card and must explain itself.
  root.innerHTML = '<p>前面</p><pre><code class="language-data-card">{"title":"","items":[{"label":"a","value":1}]}</code></pre><p>后面</p>';
  const rendered = w.IexaDataCard.enhance(root);
  assert.equal(rendered, 0, 'nothing was drawn');
  const banner = root.querySelector('.chart-error');
  assert.ok(banner, 'a banner explains the failure');
  assert.match(banner.textContent, /数据卡片无法显示/);
  assert.match(banner.textContent, /title/, 'the reason names the missing field');
  assert.equal(root.querySelectorAll('p').length, 2, 'surrounding paragraphs survived');
  // Marked, so the next frame does not stack a second banner on top.
  assert.equal(w.IexaDataCard.enhance(root), 0);
  assert.equal(root.querySelectorAll('.chart-error').length, 1);
});
