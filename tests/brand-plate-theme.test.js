// The brand plate used to carry a literal white fill (`#fff` in the base rule and
// `#f5f5f6` re-forced under [data-theme="dark"]). With the outline-only fox mark
// — a pale cyan stroke — that plate swallowed the logo in the dark theme. The
// plate now derives from the text colour, so it follows any theme or skin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = path.join(root, 'src/renderer');

function cssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Every rule whose selector list mentions `.brand-title`. */
function brandRules() {
  const rules = [];
  for (const file of cssFiles(renderer)) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!match[1].includes('.brand-title')) continue;
      rules.push({ file: path.relative(root, file), selector: match[1].trim(), body: match[2] });
    }
  }
  return rules;
}

test('no rule paints the brand plate with a literal white', () => {
  const rules = brandRules();
  assert.ok(rules.length >= 1, 'the brand plate still has a rule');
  for (const rule of rules) {
    assert.doesNotMatch(rule.body, /#fff(f{3})?\b/i, `${rule.file} pins white: ${rule.selector}`);
    assert.doesNotMatch(rule.body, /#f5f5f6/i, `${rule.file} pins the old light plate: ${rule.selector}`);
    assert.doesNotMatch(rule.body, /background:\s*(white|#fair)\b/i, `${rule.file} pins a light fill: ${rule.selector}`);
  }
});

test('the plate and the wordmark both derive from the theme text colour', () => {
  const rules = brandRules();
  const plate = rules.find((rule) => /background/.test(rule.body));
  assert.ok(plate, 'a rule sets the plate background');
  assert.match(plate.body, /background:\s*color-mix\(in srgb,\s*var\(--text-primary\)/,
    'the wash follows the theme instead of a fixed colour');
  assert.match(plate.body, /color:\s*var\(--text-primary\)/, 'and so does the word');

  const heading = fs.readFileSync(path.join(renderer, 'workbench.css'), 'utf8');
  const rule = /\.workbench-shell \.sidebar-header h1 \{[^}]*\}/.exec(heading);
  assert.ok(rule, 'the wordmark rule exists');
  assert.match(rule[0], /color:\s*var\(--text-primary\)/, 'the h1 follows the theme too');
  assert.doesNotMatch(rule[0], /color:\s*#2[0-9a-f]{5}/i, 'no pinned near-black on the wordmark');
});

test('there is no dark-only override re-forcing a light plate', () => {
  const rules = brandRules();
  for (const rule of rules) {
    if (!/data-theme=["']?dark/.test(rule.selector)) continue;
    assert.doesNotMatch(rule.body, /background:/,
      `${rule.file} still overrides the plate in dark mode: ${rule.selector}`);
  }
});
