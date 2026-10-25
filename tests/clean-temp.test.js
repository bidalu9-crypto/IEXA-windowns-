// The janitor exists because two of this project's own behaviours fill %TEMP%:
// the portable exe extracts ~690 MB per launch and only removes it on a clean
// exit, and each browser test leaves a Chrome profile behind when Windows holds
// a handle. The script must stay conservative: only its own prefixes, only old
// enough, and a dry run that changes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'clean-temp.cjs');
const source = fs.readFileSync(script, 'utf8');

test('the janitor only claims prefixes this project creates', () => {
  const owned = source.slice(source.indexOf('const OWNED'), source.indexOf('const args'));
  assert.match(owned, /\^ns\[A-Za-z0-9\]\+\\\.tmp\$/, 'portable/NSIS extraction');
  assert.match(owned, /\^iexa-/, 'browser-test scratch');
  assert.match(owned, /\^pm-/, 'process probes');
  assert.match(owned, /\^tk-/, 'taskkill probes');
  // It must never touch the whole temp directory or user data.
  assert.doesNotMatch(owned, /\^\.\*\$/, 'no catch-all pattern');
  assert.doesNotMatch(owned, /\^frida/, 'frida directories belong to other tooling');
  assert.match(source, /minAgeMinutes/, 'an age guard keeps live runs safe');
  assert.match(source, /--dry-run/, 'a dry run is available');
});

test('a dry run reports without deleting, and respects the age guard', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-janitor-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* locked */ } });

  // The script uses os.tmpdir(), so point it at a scratch HOME via TMP/TEMP.
  const old = path.join(tmp, 'iexa-old-fixture');
  const fresh = path.join(tmp, 'iexa-new-fixture');
  const foreign = path.join(tmp, 'nsomething-else');
  for (const dir of [old, fresh, foreign]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'payload.bin'), Buffer.alloc(2048));
  }
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const dir of [old, foreign]) fs.utimesSync(dir, longAgo, longAgo);

  const run = (extra) => spawnSync(process.execPath, [script, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: tmp, TMP: tmp },
  });

  const dry = run(['--dry-run', '--min-age-minutes', '60']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would free/, dry.stdout);
  assert.ok(fs.existsSync(old), 'a dry run deletes nothing');

  const real = run(['--min-age-minutes', '60']);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(fs.existsSync(old), false, 'the old scratch directory is gone');
  assert.equal(fs.existsSync(fresh), true, 'a recent directory is left alone');
  assert.equal(fs.existsSync(foreign), true, 'an unrelated name is never touched');
});
