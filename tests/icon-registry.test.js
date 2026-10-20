// Icons referenced by name from JavaScript are not in the served DOM at boot, so
// the "every use resolves" check on index.html cannot see them. This guard reads
// every uiIcon('name') literal and every #ui-* reference in the renderer sources
// and proves the symbol actually exists in the sprite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.resolve(__dirname, '../src/renderer');
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const symbols = new Set([...html.matchAll(/<symbol id="(ui-[a-z0-9-]+)"/g)].map((match) => match[1]));

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test('every icon name used by the renderer exists in the sprite', () => {
  const missing = [];
  for (const file of sourceFiles(renderer)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/uiIcon\(\s*'([a-z0-9-]+)'/g)) {
      if (!symbols.has('ui-' + match[1])) missing.push(`${path.relative(renderer, file)}: uiIcon('${match[1]}')`);
    }
    for (const match of source.matchAll(/href="#(ui-[a-z0-9-]+)"/g)) {
      if (!symbols.has(match[1])) missing.push(`${path.relative(renderer, file)}: #${match[1]}`);
    }
    for (const match of source.matchAll(/use href="(#ui-[a-z0-9-]+)"/g)) {
      const id = match[1].slice(1);
      if (!symbols.has(id)) missing.push(`${path.relative(renderer, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'dangling icon references');
});

test('the reset-here action keeps a glyph', () => {
  const helpers = fs.readFileSync(path.join(renderer, 'services/UiHelpers.js'), 'utf8');
  const reset = helpers.match(/data-action="reset"[^>]*>\$\{uiIcon\('([a-z0-9-]+)'\)\}/);
  assert.ok(reset, 'the reset action no longer renders an icon');
  assert.ok(symbols.has('ui-' + reset[1]), `ui-${reset[1]} is missing from the sprite`);
});
