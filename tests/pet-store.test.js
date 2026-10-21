'use strict';
// The pet store owns one sprite and a small config; these pin the guards that
// keep a broken file from leaving an invisible window on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PetStore, normalizePetConfig } = require('../dist/main/pet/PetStore');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-pet-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimal PNG header: signature plus IHDR width/height. */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('config is clamped instead of trusted', () => {
  const config = normalizePetConfig({ scale: 99, visible: 'yes', wander: false, shadow: 1 });
  assert.equal(config.scale, 2, 'scale is clamped to 2');
  assert.equal(config.visible, false, 'a non-boolean flag falls back');
  assert.equal(config.wander, false);
  assert.equal(config.shadow, true, 'only real booleans are honoured');
  assert.equal(normalizePetConfig({ scale: 0.1 }).scale, 0.5);
  assert.equal(normalizePetConfig({ scale: Number.NaN }).scale, 1);
});

test('a store without a sprite never reports itself visible', (t) => {
  const dir = tempDir(t);
  const store = new PetStore(dir);
  assert.equal(store.hasSprite(), false);
  assert.equal(store.updateConfig({ visible: true }).visible, false, 'visible is refused without a sprite');
});

test('writing a sprite records its real size and version', (t) => {
  const dir = tempDir(t);
  const store = new PetStore(dir);
  const size = store.writeSprite(pngHeader(320, 240));
  assert.deepEqual(size, { width: 320, height: 240 });
  const snapshot = store.snapshot();
  assert.equal(snapshot.hasSprite, true);
  assert.equal(snapshot.width, 320);
  assert.equal(snapshot.height, 240);
  assert.match(snapshot.spriteVersion, /^33-\d+-\d+$/);

  // Replacing bumps the version so the window reloads the image.
  const before = store.spriteVersion();
  store.writeSprite(pngHeader(300, 200));
  assert.notEqual(store.spriteVersion(), before);
});

test('invalid sprites are rejected before anything is written', (t) => {
  const dir = tempDir(t);
  const store = new PetStore(dir);
  assert.throws(() => store.writeSprite(Buffer.from('not a png')), /PNG/);
  assert.throws(() => store.writeSprite(pngHeader(8, 8)), /太小/);
  assert.throws(() => store.writeSprite(pngHeader(4096, 4096)), /2048/);
  assert.equal(store.hasSprite(), false);
});

test('config survives a restart and clearing keeps the settings', (t) => {
  const dir = tempDir(t);
  const store = new PetStore(dir);
  store.writeSprite(pngHeader(200, 200));
  store.updateConfig({ scale: 1.4, wander: false, visible: true });

  const reopened = new PetStore(dir);
  assert.equal(reopened.getConfig().scale, 1.4);
  assert.equal(reopened.getConfig().wander, false);
  assert.equal(reopened.getConfig().visible, true, 'a sprite exists, so visible is allowed');

  reopened.clearSprite();
  assert.equal(reopened.hasSprite(), false);
  assert.equal(reopened.getConfig().visible, false, 'clearing hides the pet');
  assert.equal(reopened.getConfig().scale, 1.4, 'other settings survive');
});
