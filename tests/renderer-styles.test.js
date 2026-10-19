const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const layers = ['base', 'shell', 'transcript', 'composer', 'settings', 'skills', 'refinements', 'studio'];

test('each style layer is linked exactly once, in cascade order', () => {
  // Order is the contract: these files used to be one stylesheet, so a link
  // moved out of sequence silently changes which rule wins.
  let cursor = -1;
  for (const layer of layers) {
    const href = `styles/${layer}.css`;
    const first = html.indexOf(href);
    assert.ok(first > 0, `${href} is not linked`);
    assert.equal(html.indexOf(href, first + 1), -1, `${href} is linked twice`);
    assert.ok(first > cursor, `${href} is out of order`);
    cursor = first;
  }
  assert.ok(html.indexOf('workbench.css') > cursor, 'the skin must load after every base layer');
});

test('no rule was torn in half by the split', () => {
  for (const layer of layers) {
    const file = path.join(RENDERER, 'styles', `${layer}.css`);
    assert.ok(fs.existsSync(file), `${file} is missing`);
    const text = fs.readFileSync(file, 'utf8');
    const open = (text.match(/\{/g) || []).length;
    const close = (text.match(/\}/g) || []).length;
    assert.equal(open, close, `${layer}.css has ${open} open and ${close} close braces`);
    assert.ok(!text.includes('@import'), `${layer}.css must not @import: the links already order the cascade`);
  }
});

test('the single stylesheet is gone and nothing still points at it', () => {
  assert.ok(!fs.existsSync(path.join(RENDERER, 'styles.css')), 'styles.css still exists');
  const sources = ['index.html', 'workbench.css'];
  for (const file of sources) {
    assert.ok(!fs.readFileSync(path.join(RENDERER, file), 'utf8').includes('href="styles.css"'), `${file} still links styles.css`);
  }
});

test('a layer does not silently grow back into a monolith', () => {
  for (const layer of layers) {
    const lines = fs.readFileSync(path.join(RENDERER, 'styles', `${layer}.css`), 'utf8').split('\n').length;
    assert.ok(lines < 1600, `${layer}.css is ${lines} lines; split it or move the rules to their owner`);
  }
});

test('every relative url() in a layer resolves from that layer', () => {
  // url() is resolved against the stylesheet, not the document. Moving rules
  // from src/renderer/styles.css into src/renderer/styles/ silently broke the
  // wordmark font: the browser fell back to Segoe UI with no error anywhere.
  const dir = path.join(RENDERER, 'styles');
  const missing = [];
  for (const layer of [...layers, '../workbench']) {
    const file = path.join(dir, `${layer}.css`);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const target = match[1];
      if (/^(data:|https?:|#|\/)/.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
        missing.push(`${layer}.css -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'unresolvable asset URLs: ' + missing.join(', '));
});
