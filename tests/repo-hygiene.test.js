// Repository hygiene: keeps the failure modes that made app.js and scripts/
// expensive to maintain from coming back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// One-off codemods are applied and forgotten; the next person cannot tell which
// of the seven patch_est*.py files ever ran. Real migrations live in git history.
const TRANSIENT = [
  { dir: 'scripts', pattern: /^(patch|fix|debug|find)[-_]/i, why: 'one-off repair script' },
  { dir: 'scripts', pattern: /.*[-_](final|fixed|copy|old|bak)\.(py|js|cjs)$/i, why: 'versioned duplicate of another script' },
  { dir: 'src', pattern: /\.(orig|rej|bak|copy)$/i, why: 'merge/patch leftover' },
  { dir: 'tests', pattern: /\.(orig|rej|bak|copy)$/i, why: 'merge/patch leftover' },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('no one-off patch scripts or patch leftovers are tracked', () => {
  const offenders = [];
  for (const rule of TRANSIENT) {
    const dir = path.join(ROOT, rule.dir);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const name = path.basename(file);
      if (rule.pattern.test(name)) offenders.push(`${path.relative(ROOT, file)} (${rule.why})`);
    }
  }
  assert.deepEqual(offenders, [], 'remove these: ' + offenders.join(', '));
});

test('scripts/ only holds repeatable entry points', () => {
  const dir = path.join(ROOT, 'scripts');
  const files = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    // A script that hardcodes one machine's desktop path cannot be run again.
    assert.doesNotMatch(text, /[A-Za-z]:\\\\Users\\\\|C:\\Users\\/i,
      `${name} hardcodes an absolute user path; a reusable script resolves from the repo root`);
  }
});
