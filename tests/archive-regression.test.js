const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-archive-'));
process.env.IEXA_WORKSPACE = path.join(fixture, 'workspace');
fs.mkdirSync(process.env.IEXA_WORKSPACE);
const backend = require('../dist/main/server');
const { sanitizeSyncContent } = require('../dist/main/sync/SyncDataProtection');
let server, port, token;
function request(route, method = 'GET', body, auth = true) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, data: JSON.parse(text) }); });
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
const file = name => path.join(process.env.IEXA_WORKSPACE, name);
const hash = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
test.before(async () => { server = await backend.startServer(0, false); port = server.address().port; token = backend.getServerCredentials(server).token; });
test.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(fixture, { recursive: true, force: true }); });

test('archive/restore is durable, idempotent, and leaves messages and context byte-identical', async () => {
  const made = await request('/api/sessions', 'POST'); assert.equal(made.status, 200);
  const session = made.data.session, route = `/api/sessions/${session.id}`;
  const messages = [{ role: 'user', content: '中文😀'.repeat(600), timestamp: 123 }, { role: 'assistant', content: 'answer', timestamp: 124 }];
  const transcript = file(`.iexa-sessions/${session.id}.json`);
  fs.writeFileSync(transcript, JSON.stringify(messages));
  const before = hash(transcript);
  const storedBefore = JSON.parse(fs.readFileSync(file('.iexa-sessions.json'), 'utf8'));
  const result = await request(route, 'PATCH', { archived: true });
  assert.equal(result.status, 200); assert.equal(result.data.session.archived, true);
  assert.equal(result.data.activeSessionId, session.id);
  assert.equal(hash(transcript), before);
  assert.deepEqual((await request(route)).data.messages, messages);
  let disk = JSON.parse(fs.readFileSync(file('.iexa-sessions.json'), 'utf8'));
  assert.equal(disk.sessions.find(s => s.id === session.id).archived, true);
  assert.equal(disk.sessions.find(s => s.id === session.id).updated, storedBefore.sessions.find(s => s.id === session.id).updated);
  assert.equal((await request('/api/sessions')).data.sessions.find(s => s.id === session.id).archived, true);
  const metadataHash = hash(file('.iexa-sessions.json'));
  assert.equal((await request(route, 'PATCH', { archived: true })).status, 200);
  assert.equal(hash(file('.iexa-sessions.json')), metadataHash);
  const restore = await request(route, 'PATCH', { archived: false });
  assert.equal(restore.status, 200); assert.equal(restore.data.session.archived, false);
  assert.equal(hash(transcript), before);
  assert.equal((await request(route)).data.session.archived, false);
});

test('archive request validates identity, JSON schema and missing sessions without changing metadata', async () => {
  const { data } = await request('/api/sessions', 'POST'); const route = `/api/sessions/${data.session.id}`;
  const before = hash(file('.iexa-sessions.json'));
  assert.equal((await request(route, 'PATCH', { archived: true }, false)).status, 401);
  for (const body of [null, {}, [], { archived: 'true' }, { archived: 1 }, { archived: true, title: 'injected' }, '{']) {
    assert.equal((await request(route, 'PATCH', body)).status, 400);
  }
  assert.equal((await request('/api/sessions/sess_missing', 'PATCH', { archived: true })).status, 404);
  assert.equal(hash(file('.iexa-sessions.json')), before);
});

test('deleting the active conversation never selects an archived conversation', async () => {
  const { data: initial } = await request('/api/sessions');
  for (const s of initial.sessions) await request(`/api/sessions/${s.id}`, 'PATCH', { archived: true });
  const { data } = await request('/api/sessions', 'POST');
  const result = await request(`/api/sessions/${data.session.id}`, 'DELETE');
  assert.equal(result.status, 200); assert.equal(result.data.activeSessionId, '');
});

test('sync preserves archive metadata and accepts legacy indexes while rejecting malformed flags', () => {
  const session = { id: 'sess_a', title: 'test', created: 1, updated: 2, messageCount: 3 };
  const content = value => JSON.stringify({ activeSessionId: 'sess_a', sessions: [value] });
  assert.equal(JSON.parse(sanitizeSyncContent('sessions_index', content(session))).sessions[0].archived, undefined);
  for (const archived of [true, false]) assert.equal(JSON.parse(sanitizeSyncContent('sessions_index', content({ ...session, archived }))).sessions[0].archived, archived);
  for (const archived of ['false', 1, null, {}]) assert.throws(() => sanitizeSyncContent('sessions_index', content({ ...session, archived })));
});
