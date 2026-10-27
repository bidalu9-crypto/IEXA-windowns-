// The speech cache is disposable audio, so it is capped and evicted oldest-first.
// These tests run against a real directory: the point is the actual file set left
// behind, not a mocked call count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { trimCache, CACHE_LIMIT_BYTES } = require('../dist/main/api/TtsRoutes');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-tts-trim-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } });
  return dir;
}

/** Write a clip of `kib` KiB and backdate it so ordering is explicit. */
function clip(dir, name, kib, minutesAgo) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(kib * 1024, 7));
  const when = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(file, when, when);
  return file;
}

test('the cap is 200 MiB', () => {
  assert.equal(CACHE_LIMIT_BYTES, 200 * 1024 * 1024);
});

test('a cache under the cap is left alone', (t) => {
  const dir = scratch(t);
  const a = clip(dir, 'a.mp3', 4, 30);
  const b = clip(dir, 'b.mp3', 4, 10);
  assert.equal(trimCache(dir, 1024 * 1024), 0);
  assert.ok(fs.existsSync(a) && fs.existsSync(b), 'nothing is deleted while there is room');
});

test('the oldest clips go first, and only until the total fits', (t) => {
  const dir = scratch(t);
  // 6 x 4 KiB = 24 KiB against a 12 KiB budget: the three oldest must go.
  const oldest = clip(dir, 'oldest.mp3', 4, 60);
  const older = clip(dir, 'older.mp3', 4, 45);
  const old = clip(dir, 'old.mp3', 4, 30);
  const recent = clip(dir, 'recent.mp3', 4, 15);
  const newer = clip(dir, 'newer.mp3', 4, 5);
  const newest = clip(dir, 'newest.mp3', 4, 1);

  const removed = trimCache(dir, 12 * 1024);

  assert.equal(removed, 3, 'exactly enough files were evicted');
  for (const gone of [oldest, older, old]) assert.equal(fs.existsSync(gone), false, `${path.basename(gone)} evicted`);
  for (const kept of [recent, newer, newest]) assert.equal(fs.existsSync(kept), true, `${path.basename(kept)} kept`);

  const total = fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  assert.ok(total <= 12 * 1024, 'the result fits the budget: ' + total);
});

test('ordering is by last use, not by name', (t) => {
  const dir = scratch(t);
  // `zzz` is alphabetically last but the most recently used, so it must survive.
  clip(dir, 'aaa.mp3', 8, 60);
  clip(dir, 'mmm.mp3', 8, 30);
  clip(dir, 'zzz.mp3', 8, 1);

  trimCache(dir, 16 * 1024);

  assert.deepEqual(fs.readdirSync(dir).sort(), ['mmm.mp3', 'zzz.mp3']);
});

test('a clip larger than the whole budget is still evicted', (t) => {
  const dir = scratch(t);
  const only = clip(dir, 'only.mp3', 8, 1);
  // A 1 KiB budget cannot fit an 8 KiB clip. Keeping it would mean the cap is
  // advisory and the directory grows without bound, so it goes.
  trimCache(dir, 1024);
  assert.equal(fs.existsSync(only), false, 'the cap is enforced even for a single file');
});

test('non-mp3 leftovers do not confuse the total', (t) => {
  const dir = scratch(t);
  clip(dir, 'keep.mp3', 4, 1);
  fs.writeFileSync(path.join(dir, 'stale.txt'), Buffer.alloc(64 * 1024));
  assert.equal(trimCache(dir, 8 * 1024), 0, 'the .txt is not counted and nothing is removed');
  assert.ok(fs.existsSync(path.join(dir, 'stale.txt')));
});

test('a missing directory is not an error', () => {
  assert.equal(trimCache(path.join(os.tmpdir(), 'iexa-tts-does-not-exist-' + Date.now())), 0);
});
