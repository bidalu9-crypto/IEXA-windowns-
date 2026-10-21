'use strict';
// The pet HTTP surface: snapshot, sprite bytes, model download, config patch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-pet-route-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, endpoint, token;

function png(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test.before(async () => {
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
});

test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

const auth = () => ({ Authorization: 'Bearer ' + token });

test('a fresh workspace reports no sprite and safe defaults', async () => {
  const response = await fetch(endpoint + '/api/pet', { headers: auth() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.hasSprite, false);
  assert.equal(body.width, 0);
  assert.deepEqual(body.config, {
    visible: false, scale: 1, alwaysOnTop: true, wander: true, shadow: true, reactions: true,
  });
});

test('the segmentation model is served whole', async () => {
  const response = await fetch(endpoint + '/api/pet/model', { headers: auth() });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 4_000_000, 'u2netp is ~4.4 MB: ' + bytes.length);
  assert.equal(bytes.readUInt32BE(0) & 0x08061207, bytes.readUInt32BE(0) & 0x08061207);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '08061207', 'ONNX protobuf header');
});

test('uploading a PNG stores it and bumps the version', async () => {
  const before = (await (await fetch(endpoint + '/api/pet', { headers: auth() })).json()).spriteVersion;
  const upload = await fetch(endpoint + '/api/pet/sprite', {
    method: 'POST', headers: { ...auth(), 'Content-Type': 'image/png' }, body: png(256, 200),
  });
  assert.equal(upload.status, 200);
  const result = await upload.json();
  assert.equal(result.width, 256);
  assert.equal(result.height, 200);
  assert.equal(result.snapshot.hasSprite, true);
  assert.notEqual(result.snapshot.spriteVersion, before);

  const sprite = await fetch(endpoint + '/api/pet/sprite', { headers: auth() });
  assert.equal(sprite.status, 200);
  assert.equal(sprite.headers.get('content-type'), 'image/png');
  assert.equal((await sprite.arrayBuffer()).byteLength, 33);
});

test('a body that is not a PNG is refused', async () => {
  const response = await fetch(endpoint + '/api/pet/sprite', {
    method: 'POST', headers: { ...auth(), 'Content-Type': 'image/png' }, body: Buffer.from('GIF89a not png'),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /PNG/);
});

test('PATCH clamps the config and keeps visible honest', async () => {
  const response = await fetch(endpoint + '/api/pet', {
    method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 9, wander: false, visible: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.config.scale, 2);
  assert.equal(body.config.wander, false);
  assert.equal(body.config.visible, true, 'a sprite exists, so visible sticks');

  const off = await fetch(endpoint + '/api/pet', {
    method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: false }),
  });
  assert.equal((await off.json()).config.visible, false);
});

test('deleting the sprite hides the pet and keeps the settings', async () => {
  const response = await fetch(endpoint + '/api/pet/sprite', { method: 'DELETE', headers: auth() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.snapshot.hasSprite, false);
  assert.equal(body.snapshot.config.visible, false);
  assert.equal(body.snapshot.config.scale, 2, 'scale survived the delete');

  const missing = await fetch(endpoint + '/api/pet/sprite', { headers: auth() });
  assert.equal(missing.status, 404);
});

test('an unsupported method is rejected, not silently accepted', async () => {
  const response = await fetch(endpoint + '/api/pet/sprite', { method: 'PUT', headers: auth(), body: 'x' });
  assert.equal(response.status, 405);
});
