const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const secrets = require('../dist/main/security/SecretStore');
const sync = require('../dist/main/webdav-sync');
const protection = require('../dist/main/sync/SyncDataProtection');
const { WebDAVConflictStore } = require('../dist/main/sync/WebDAVConflictStore');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-secret-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function codec() {
  const key = crypto.randomBytes(32); // Tests only; key is never written to disk.
  return {
    id: 'test-aes-256-gcm',
    encrypt(data) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(data), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(data) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    },
  };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function diskContents(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? diskContents(path.join(root, entry.name)) : [fs.readFileSync(path.join(root, entry.name), 'utf8')]).join('\n');
}
function fakeClient() {
  const files = new Map(), listings = new Map(), uploads = [];
  return {
    files, listings, uploads,
    exists: async () => true, createDirectory: async () => {},
    getDirectoryContents: async remote => listings.get(remote) || [],
    stat: async remote => {
      const file = files.get(remote);
      if (!file) throw Object.assign(new Error('not found'), { status: 404 });
      return { type: 'file', size: Buffer.byteLength(file.content), lastmod: new Date(file.time).toUTCString() };
    },
    createReadStream: remote => {
      const file = files.get(remote);
      return file ? Readable.from([Buffer.from(file.content)]) : Readable.from((async function* () { throw new Error('missing'); })());
    },
    putFileContents: async (remote, content) => {
      uploads.push({ remote, content: String(content) });
      files.set(remote, { content: String(content), time: Date.now() });
      return true;
    },
  };
}
const cfg = () => ({ url: 'https://webdav.invalid/', username: 'fixture', password: '', enabled: true, autoSync: false, lastSync: 0 });

test('recursive vault roundtrip, stable references, PEM container, and no on-disk key', t => {
  const root = fixture(t), file = path.join(root, 'settings.json'), store = secrets.createProtectedSettingsStore(codec());
  const input = { profiles: [{ apiKey: 'fake-only-api-value', password: 'fake-only-password' }], nested: { list: [{ API_KEY: 'fake-nested-key' }] }, password: '-----BEGIN PRIVATE KEY-----\nsynthetic-fixture\n-----END PRIVATE KEY-----', permissionMode: 'risk' };
  store.saveProtectedSettings(file, input);
  const first = JSON.parse(fs.readFileSync(file));
  assert.equal(typeof first.profiles[0].apiKey.$secretRef, 'string');
  assert.deepEqual(store.loadProtectedSettings(file, () => ({})), input);
  store.saveProtectedSettings(file, { ...input, thinkingLevel: 'high' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).profiles, first.profiles);
  const disk = diskContents(root);
  for (const secret of ['fake-only-api-value', 'fake-only-password', 'fake-nested-key', 'synthetic-fixture', 'BEGIN PRIVATE KEY']) assert.ok(!disk.includes(secret));
  assert.ok(fs.readdirSync(root).every(name => !name.endsWith('.key') && !name.endsWith('.tmp')));
});

test('load migrates BOTH primary and historical .bak, preserves each generation and is idempotent', t => {
  const root = fixture(t), file = path.join(root, 'settings.json'), store = secrets.createProtectedSettingsStore(codec());
  write(file, { apiKey: 'fake-new-secret', password: 'fake-new-password' });
  write(file + '.bak', { apiKey: 'fake-old-secret', password: 'fake-old-password' });
  assert.equal(store.loadProtectedSettings(file, () => ({})).apiKey, 'fake-new-secret');
  const before = diskContents(root);
  for (const value of ['fake-new-secret', 'fake-new-password', 'fake-old-secret', 'fake-old-password']) assert.ok(!before.includes(value));
  const backup = fs.readFileSync(file + '.bak');
  store.loadProtectedSettings(file, () => ({}));
  assert.equal(diskContents(root), before);
  fs.writeFileSync(file, backup);
  assert.equal(store.loadProtectedSettings(file, () => ({})).apiKey, 'fake-old-secret');
});

test('save migrates legacy backup without copying plaintext and corrupt primary recovers from .bak', t => {
  const root = fixture(t), file = path.join(root, 'settings.json'), store = secrets.createProtectedSettingsStore(codec());
  fs.writeFileSync(file, '{"apiKey":"fake-corrupt-secret');
  write(file + '.bak', { password: 'fake-recovered-secret' });
  assert.equal(store.loadProtectedSettings(file, () => ({})).password, 'fake-recovered-secret');
  assert.ok(!diskContents(root).includes('fake-corrupt-secret'));
  write(file + '.bak', { password: 'fake-legacy-backup' });
  store.saveProtectedSettings(file, { password: 'fake-replacement-secret' });
  assert.ok(!diskContents(root).includes('fake-legacy-backup'));
  assert.equal(store.loadProtectedSettings(file, () => ({})).password, 'fake-replacement-secret');
});

test('no-secret objects never call codec; protection failures and missing vault fail closed', t => {
  const root = fixture(t), file = path.join(root, 'settings.json');
  const broken = { id: 'broken', encrypt() { throw new Error('unavailable'); }, decrypt() { throw new Error('unavailable'); } };
  const noSecrets = secrets.createProtectedSettingsStore(broken);
  noSecrets.saveProtectedSettings(file, { value: 1, nested: { password: '' } });
  assert.equal(noSecrets.loadProtectedSettings(file, () => ({})).value, 1);
  assert.equal(fs.existsSync(file + '.vault'), false);
  assert.throws(() => noSecrets.saveProtectedSettings(file, { password: 'fake-secret' }));
  assert.ok(!diskContents(root).includes('fake-secret'));
  const store = secrets.createProtectedSettingsStore(codec());
  store.saveProtectedSettings(file, { password: 'fake-protected' });
  fs.unlinkSync(file + '.vault');
  assert.throws(() => store.loadProtectedSettings(file, () => ({ password: 'fallback' })));
});

test('foreign, moved and tampered references fail closed without filesystem mutation', t => {
  const root = fixture(t), store = secrets.createProtectedSettingsStore(codec());
  const a = path.join(root, 'a.json'), b = path.join(root, 'b.json');
  store.saveProtectedSettings(a, { nested: { password: 'fake-reference-test' } });
  const stored = JSON.parse(fs.readFileSync(a));
  const before = diskContents(root);
  assert.throws(() => store.saveProtectedSettings(a, { password: stored.nested.password }));
  assert.throws(() => store.saveProtectedSettings(b, stored));
  assert.equal(diskContents(root), before);
  assert.throws(() => secrets.createProtectedSettingsStore(codec()).loadProtectedSettings(a, () => ({})));
});

test('DTO allowlist ignores remote profiles, credentials, refs and permission changes', () => {
  const local = { profiles: [{ id: 'local', baseURL: 'https://local.invalid', apiKey: { $secretRef: 'local:opaque' } }], permissionMode: 'risk', security: { enabled: true }, activeProfileId: 'local', thinkingLevel: 'low' };
  const remote = { profiles: [{ id: 'local', baseURL: 'https://attacker.invalid', apiKey: 'fake-remote-credential' }], password: 'fake-remote-password', permissionMode: 'full', security: { enabled: false }, activeProfileId: 'evil', thinkingLevel: 'high' };
  const dto = sync.toSettingsSyncDTO(remote);
  assert.deepEqual(Object.keys(dto.preferences), ['thinkingLevel']);
  const merged = sync.mergeSettingsSyncDTO(local, remote);
  assert.equal(merged.profiles, local.profiles);
  assert.equal(merged.permissionMode, 'risk');
  assert.equal(merged.activeProfileId, 'local');
  assert.equal(merged.security.enabled, true);
  assert.equal(merged.thinkingLevel, 'high');
  assert.ok(!JSON.stringify(dto).includes('fake-remote'));
  for (const bad of [null, [], { thinkingLevel: 'admin' }, { contextCompactionLimit: 1e99 }, { kind: 'iexa-settings', version: 2, preferences: {} }]) assert.throws(() => sync.toSettingsSyncDTO(bad));
});

test('reject Windows separator traversal, ADS, encoded paths and device basenames', () => {
  for (const name of ['../evil.json', '..\\evil.json', 'a/b.json', 'a\\b.json', 'C:evil.json', '\\server\\share', 'a.json:stream', 'CON.json', 'com1.json', 'LPT².md', 'a.json.', 'a.json ', 'a%2fsecret.json', 'nul', '.', '..', 'a\0b.json']) assert.throws(() => sync.assertRemoteBasename(name), name);
  for (const name of ['chat-123.json', 'memory.md', 'skill-name', '中文.json', 'space name.json', 'hash#tag.md']) sync.assertRemoteBasename(name);
});

test('sync uploads DTO only and download preserves local vault references/policy', async t => {
  const root = fixture(t), file = path.join(root, 'settings.json'), store = secrets.createProtectedSettingsStore(codec()), client = fakeClient();
  sync.setConfigFile('');
  const local = { profiles: [{ id: 'mine', apiKey: 'fake-local-key', baseURL: 'https://local.invalid' }], password: 'fake-local-password', permissionMode: 'risk', thinkingLevel: 'low' };
  store.saveProtectedSettings(file, local);
  const reference = JSON.parse(fs.readFileSync(file)).profiles[0].apiKey;
  const deps = { settingsStore: store, clientFactory: () => client };
  let result = await sync.syncAll(cfg(), root, path.join(root, 'sessions'), file, path.join(root, 'sessions-store.json'), deps);
  assert.equal(result.ok, true, result.error);
  assert.equal(client.uploads.length, 1);
  assert.deepEqual(JSON.parse(client.uploads[0].content), sync.toSettingsSyncDTO(local));
  client.files.set('/IEXA/settings.json', { content: JSON.stringify({ permissionMode: 'full', profiles: [{ apiKey: 'fake-remote-key', baseURL: 'https://evil.invalid' }], thinkingLevel: 'high' }), time: Date.now() + 60_000 });
  result = await sync.syncAll(cfg(), root, path.join(root, 'sessions'), file, path.join(root, 'sessions-store.json'), deps);
  assert.equal(result.ok, true, result.error);
  const hydrated = store.loadProtectedSettings(file, () => ({}));
  assert.equal(hydrated.profiles[0].apiKey, 'fake-local-key');
  assert.equal(hydrated.profiles[0].baseURL, 'https://local.invalid');
  assert.equal(hydrated.permissionMode, 'risk');
  assert.equal(hydrated.thinkingLevel, 'high');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).profiles[0].apiKey, reference);
  assert.ok(!diskContents(root).includes('fake-remote-key'));
});

test('settings conflicts redact legacy copies, preview hides local secrets, remote resolution merges preferences only', async t => {
  const root = fixture(t), file = path.join(root, 'settings.json'), store = secrets.createProtectedSettingsStore(codec()), client = fakeClient();
  store.saveProtectedSettings(file, { apiKey: 'fake-local-conflict-secret', permissionMode: 'risk', thinkingLevel: 'low' });
  const conflicts = new WebDAVConflictStore(root);
  const record = conflicts.preserve('settings', file, '/IEXA/settings.json', Buffer.from(JSON.stringify({ apiKey: 'fake-remote-conflict-secret', permissionMode: 'full', thinkingLevel: 'high' })));
  // Simulate a pre-upgrade conflict copy and historical copy backup.
  write(record.remoteCopyPath, { password: 'fake-old-conflict-secret', thinkingLevel: 'high' });
  write(record.remoteCopyPath + '.bak', { apiKey: 'fake-old-backup-secret', thinkingLevel: 'low' });
  const preview = sync.previewSyncConflict(root, record.id);
  assert.equal(preview.mergeable, false);
  assert.equal(preview.localContent, undefined);
  assert.ok(!diskContents(root).includes('fake-old-conflict-secret'));
  assert.ok(!diskContents(root).includes('fake-old-backup-secret'));
  const resolved = await sync.resolveSyncConflict(cfg(), root, record.id, 'remote', undefined, { settingsStore: store, clientFactory: () => client });
  assert.equal(resolved.status, 'resolved');
  const loaded = store.loadProtectedSettings(file, () => ({}));
  assert.equal(loaded.apiKey, 'fake-local-conflict-secret');
  assert.equal(loaded.permissionMode, 'risk');
  assert.equal(loaded.thinkingLevel, 'high');
});

test('local conflict upload is DTO-only and settings manual merge is rejected', async t => {
  const root = fixture(t), file = path.join(root, 'settings.json'), store = secrets.createProtectedSettingsStore(codec()), client = fakeClient();
  store.saveProtectedSettings(file, { apiKey: 'fake-local-winner-secret', thinkingLevel: 'low' });
  const conflicts = new WebDAVConflictStore(root);
  const record = conflicts.preserve('settings', file, '/IEXA/settings.json', Buffer.from('{"thinkingLevel":"high"}'));
  const deps = { settingsStore: store, clientFactory: () => client };
  await assert.rejects(sync.resolveSyncConflict(cfg(), root, record.id, 'merge', '{"password":"fake-injected"}', deps));
  await sync.resolveSyncConflict(cfg(), root, record.id, 'local', undefined, deps);
  assert.ok(!client.uploads[0].content.includes('fake-local-winner-secret'));
  assert.ok(!client.uploads[0].content.includes('$secretRef'));
});

test('malicious remote listing fails before download for all synced directories', async t => {
  for (const [remote, type] of [['/IEXA/sessions', 'file'], ['/IEXA/memory', 'file'], ['/IEXA/skills', 'directory']]) {
    const root = fixture(t), client = fakeClient();
    client.listings.set(remote, [{ type, basename: '..\\escaped.json', size: 10 }]);
    let reads = 0;
    client.createReadStream = () => { reads++; return Readable.from([]); };
    const result = await sync.syncAll(cfg(), root, path.join(root, 'sessions'), path.join(root, 'settings.json'), path.join(root, 'sessions-store.json'), { clientFactory: () => client });
    assert.equal(result.ok, false);
    assert.equal(reads, 0);
    assert.ok(!fs.existsSync(path.join(root, 'escaped.json')));
  }
});

test('download validation rejects malformed schemas, prototype pollution, oversize and invalid UTF8 streams', async () => {
  for (const text of ['{', '{"__proto__":{"polluted":true}}', JSON.stringify({ content: 'not an array' })]) assert.throws(() => protection.sanitizeSyncContent('session:x.json', text));
  assert.throws(() => protection.sanitizeSyncContent('sessions_index', '{"sessions":[{"id":"..\\\\escape","title":"x","created":1,"updated":1,"messageCount":0}],"activeSessionId":""}'));
  assert.throws(() => protection.parseBoundedJSON('['.repeat(55) + '0' + ']'.repeat(55)));
  const oversized = { createReadStream: () => Readable.from([Buffer.alloc(protection.MAX_SYNC_BYTES), Buffer.from('x')]) };
  await assert.rejects(protection.readRemoteSyncText(oversized, '/file'));
  await assert.rejects(protection.readRemoteSyncText({ createReadStream: () => Readable.from([Buffer.from([0xff])]) }, '/file'));
  assert.equal({}.polluted, undefined);
});

test('WebDAV config uses injected protected store', t => {
  const root = fixture(t), file = path.join(root, 'webdav.json'), store = secrets.createProtectedSettingsStore(codec());
  sync.setConfigFile(file); t.after(() => sync.setConfigFile(''));
  const config = { ...cfg(), password: 'fake-webdav-secret' };
  sync.saveConfig(config, store);
  assert.deepEqual(sync.loadConfig(store), config);
  assert.ok(!diskContents(root).includes('fake-webdav-secret'));
});

test('native import loads installed webdav ESM without issuing network requests', async () => {
  const module = await new Function('return import("webdav")')();
  assert.equal(typeof module.createClient, 'function');
  const client = module.createClient('https://webdav.invalid/', { username: '', password: '' });
  assert.equal(typeof client.createReadStream, 'function');
});

test('Windows default helper uses DPAPI for synthetic credentials', { skip: process.platform !== 'win32' }, t => {
  const root = fixture(t), file = path.join(root, 'dpapi.json');
  secrets.saveProtectedSettings(file, { password: 'synthetic-dpapi-roundtrip' });
  assert.equal(secrets.loadProtectedSettings(file, () => ({})).password, 'synthetic-dpapi-roundtrip');
  const envelope = JSON.parse(fs.readFileSync(file + '.vault'));
  assert.equal(envelope.codec, 'windows-dpapi-current-user-v1');
  assert.ok(!diskContents(root).includes('synthetic-dpapi-roundtrip'));
});

test('unsupported platform and Electron basic_text explicitly fail closed', () => {
  const vm = require('node:vm');
  const code = fs.readFileSync(require.resolve('../dist/main/security/SecretStore'), 'utf8');
  for (const safe of [undefined, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }]) {
    const context = { exports: {}, require: name => name === 'electron' ? { safeStorage: safe } : require(name), process: { platform: 'linux' }, Buffer };
    vm.runInNewContext(code, context);
    assert.throws(() => context.exports.createPlatformSecretCodec());
  }
});

test('webdav 5 bounded adapter parses real DAV XML, caps XML before parsing, and rejects href traversal', async () => {
  const { boundWebDAVClient } = require('../dist/main/sync/BoundedWebDAVClient');
  const dav = await import('webdav');
  const response = href => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength><d:getlastmodified>Sun, 13 Sep 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const xml = href => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${response(href)}</d:multistatus>`;
  let content = xml('/dav/IEXA/sessions/chat%20one.json');
  let closed = false;
  const client = boundWebDAVClient({ customRequest: async () => ({ headers: new Map(), body: Readable.from([Buffer.from(content)]) }) }, dav, 'https://webdav.invalid/dav');
  const files = await client.getDirectoryContents('/IEXA/sessions');
  assert.equal(files[0].basename, 'chat one.json');
  assert.equal(files[0].size, 10);
  const stat = await client.stat('/IEXA/sessions/chat one.json');
  assert.equal(stat.type, 'file');
  for (const href of ['/dav/IEXA/sessions/..%5cescape.json', '/dav/IEXA/sessions/nested%2fevil.json', '/outside.json', 'https://other.invalid/dav/IEXA/sessions/x.json']) {
    content = xml(href);
    await assert.rejects(client.getDirectoryContents('/IEXA/sessions'));
  }
  content = '<!DOCTYPE dav [<!ENTITY x "value">]>' + xml('/dav/IEXA/sessions/x.json');
  await assert.rejects(client.getDirectoryContents('/IEXA/sessions'));
  const overflow = boundWebDAVClient({ customRequest: async () => ({ headers: new Map(), body: Readable.from((async function* () {
    try { yield Buffer.alloc(4 * 1024 * 1024); yield Buffer.from('x'); }
    finally { closed = true; }
  })()) }) }, { parseXML() { assert.fail('Oversized XML reached parser'); } }, 'https://webdav.invalid');
  await assert.rejects(overflow.getDirectoryContents('/IEXA'));
  assert.equal(closed, true);
});

test('bounded GET propagates source errors and cancels oversized stream', async () => {
  const { boundWebDAVClient } = require('../dist/main/sync/BoundedWebDAVClient');
  let aborted;
  const client = boundWebDAVClient({ customRequest: async (remote, options) => {
    options.signal.addEventListener('abort', () => { aborted = true; });
    return { headers: new Map(), body: Readable.from([Buffer.alloc(protection.MAX_SYNC_BYTES), Buffer.from('overflow')]) };
  } }, {}, 'https://webdav.invalid');
  await assert.rejects(protection.readRemoteSyncText(client, '/IEXA/file'));
  assert.equal(aborted, true);
  const broken = boundWebDAVClient({ customRequest: async () => ({ headers: new Map(), body: Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('fixture transport failure'); })()) }) }, {}, 'https://webdav.invalid');
  await assert.rejects(protection.readRemoteSyncText(broken, '/IEXA/file'));
});

test('unchanged sync is a no-op despite local/server clock skew', async t => {
  const root = fixture(t), file = path.join(root, 'settings.json'), store = secrets.createProtectedSettingsStore(codec()), client = fakeClient();
  sync.setConfigFile('');
  store.saveProtectedSettings(file, { thinkingLevel: 'low' });
  const deps = { settingsStore: store, clientFactory: () => client };
  const run = () => sync.syncAll(cfg(), root, path.join(root, 'sessions'), file, path.join(root, 'sessions-store.json'), deps);
  assert.equal((await run()).ok, true);
  const result = await run();
  assert.equal(result.ok, true);
  assert.equal(result.uploaded, 0);
  assert.equal(result.downloaded, 0);
  assert.equal(client.uploads.length, 1);
});
