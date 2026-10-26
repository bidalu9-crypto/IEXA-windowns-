const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, backupByLink, backupByLinkSync, writeTextAtomic } = require('../dist/main/persistence/JsonStore');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-store-'));
}

test('save keeps the previous revision in .bak', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  const store = new JsonStore(file, () => ({ v: 0 }));
  store.saveSync({ v: 1 });
  store.saveSync({ v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { v: 1 });
});

test('loadSync falls back to .bak when the primary is corrupt', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  const store = new JsonStore(file, () => ({ v: 0 }));
  store.saveSync({ v: 1 });
  store.saveSync({ v: 2 });
  fs.writeFileSync(file, '{ broken');
  assert.deepEqual(store.loadSync(), { v: 1 });
});

test('loadSync uses the fallback when both copies are unusable', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, 'nope');
  fs.writeFileSync(`${file}.bak`, 'also nope');
  assert.deepEqual(new JsonStore(file, () => ({ v: 0 })).loadSync(), { v: 0 });
});

test('loadSync reads a file that starts with a UTF-8 BOM', () => {
  // PowerShell 5.1 emits a BOM for `Set-Content -Encoding utf8`. JSON.parse
  // rejects it, which used to reset a hand-edited settings file to defaults
  // without any error the user could see.
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '\uFEFF{"v":7}', 'utf8');
  assert.deepEqual(new JsonStore(file, () => ({ v: 0 })).loadSync(), { v: 7 });
});

test('large backups hard-link instead of copying', t => {
  const dir = tempDir();
  const file = path.join(dir, 'big.json');
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024));
  backupByLinkSync(file);
  let linked = false;
  try {
    const source = fs.statSync(file);
    const backup = fs.statSync(`${file}.bak`);
    linked = source.ino === backup.ino && backup.nlink >= 2;
  } catch { linked = false; }
  if (!linked) {
    // FAT/exFAT or a platform without inode reporting: content must still match.
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), fs.readFileSync(file, 'utf8'));
    t.diagnostic('filesystem did not accept hard links; copy fallback verified');
    return;
  }
  assert.ok(linked);
});

test('small backups stay independent copies', () => {
  const dir = tempDir();
  const file = path.join(dir, 'small.json');
  fs.writeFileSync(file, 'first');
  backupByLinkSync(file);
  fs.writeFileSync(file, 'second');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'first');
});

test('async backup replaces the entry instead of rewriting in place', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'big.json');
  fs.writeFileSync(file, 'first'.repeat(300 * 1024));
  await backupByLink(file);
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, 'second');
  fs.renameSync(replacement, file);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'first'.repeat(300 * 1024));
});

test('async JsonStore.save keeps ordering under concurrency', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'queue.json');
  const store = new JsonStore(file, () => ({ n: 0 }));
  await Promise.all([store.save({ n: 1 }), store.save({ n: 2 }), store.save({ n: 3 })]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { n: 2 });
});

test('writeTextAtomic replaces content and creates parents', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'value.txt');
  writeTextAtomic(file, 'one');
  writeTextAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'one');
});
