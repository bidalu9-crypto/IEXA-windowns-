'use strict';
// Read-only application review. Only these tests are added; all filesystem
// mutations below are confined to a fresh temporary fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { LocalApiAuth, DESKTOP_COOKIE, isTLS, isLoopback } = require('../dist/main/security/LocalApiAuth');
const { UploadRoutes } = require('../dist/main/api/UploadRoutes');
const tick = () => new Promise(resolve => setImmediate(resolve));
const MIB = 1024 * 1024;
const DECLARED_SIZE = 8 * MIB + 1;
const status = value => error => error.status === value;

function request(overrides = {}) {
  return {
    method: 'POST', url: '/api/auth/bootstrap',
    headers: { host: '127.0.0.1:32123', ...overrides.headers },
    socket: { localPort: 32123, remoteAddress: '127.0.0.1', ...overrides.socket },
  };
}
function response() {
  return {
    statusCode: 0, headers: {}, body: '', destroyed: false, writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(body) { this.body = String(body || ''); this.writableEnded = true; },
  };
}
function fixtures(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-auth-upload-')));
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  const closers = [];
  t.after(() => {
    for (const close of closers.reverse()) close();
    assert.equal(path.dirname(base), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('iexa-auth-upload-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, workspace, outside, routes() { const routes = new UploadRoutes(workspace); closers.push(() => routes.close()); return routes; } };
}
function startRequest(routes, route, owner = 'owner', headers = {}) {
  const req = new PassThrough(); req.method = 'POST'; req.headers = headers;
  const res = response();
  const result = routes.handle(req, res, new URL(route, 'http://fixture.invalid'), owner)
    .then(handled => ({ status: res.statusCode, body: res.body && JSON.parse(res.body), handled }),
      error => ({ status: error.status || 500, error }));
  return { req, res, result };
}
async function invoke(routes, route, body, owner = 'owner') {
  const call = startRequest(routes, route, owner);
  call.req.complete = true;
  call.req.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  return call.result;
}
async function init(routes, sessionId = 'session', owner = 'owner') {
  return invoke(routes, '/api/uploads/init', { sessionId, name: 'fixture.bin', size: DECLARED_SIZE }, owner);
}
async function fill(routes, id, owner = 'owner') {
  for (const [offset, length] of [[0, 4 * MIB], [4 * MIB, 4 * MIB], [8 * MIB, 1]]) {
    const chunk = await invoke(routes, `/api/uploads/chunk?uploadId=${id}&offset=${offset}`, Buffer.alloc(length, 65), owner);
    assert.equal(chunk.status, 200);
  }
}
function link(target, alias) { fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }

test('auth: startup begins anonymous; creating a bootstrap does not authenticate a request', () => {
  const auth = new LocalApiAuth(); const req = request();
  auth.validateRequest(req);
  assert.equal(auth.authenticated(req), false);
  assert.equal(auth.acceptBootstrap(req, ''), false);
  assert.equal(auth.acceptBootstrap(req, 'unissued'), false);
  const bootstrap = auth.createBootstrap();
  assert.equal(auth.authenticated(req), false);
  assert.equal(auth.acceptBootstrap(req, auth.token), false);
  assert.equal(auth.acceptBootstrap(req, bootstrap), true);
  assert.equal(auth.acceptBootstrap(req, bootstrap), false);
  assert.equal(auth.authenticated(req), false, 'bootstrap consumption alone does not inject a request identity');
});

test('auth: desktop credential and bootstrap are rejected on TLS, including loopback TLS', () => {
  const auth = new LocalApiAuth(); const bootstrap = auth.createBootstrap();
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.42']) {
    const req = request({ socket: { remoteAddress, encrypted: true }, headers: { authorization: `Bearer ${auth.token}`, cookie: `${DESKTOP_COOKIE}_32123=${auth.token}` } });
    assert.equal(isTLS(req), true);
    assert.equal(auth.authenticated(req), false, remoteAddress);
    assert.equal(auth.acceptBootstrap(req, bootstrap), false, remoteAddress);
  }
  assert.equal(auth.acceptBootstrap(request(), bootstrap), true, 'failed mobile/TLS redemption must not consume the desktop code');
});

test('auth: forwarded headers do not promote a LAN client or fake a TLS socket', () => {
  const auth = new LocalApiAuth();
  const req = request({ socket: { remoteAddress: '192.168.1.42' }, headers: { authorization: `Bearer ${auth.token}`, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' } });
  assert.equal(isTLS(req), false); assert.equal(isLoopback(req), false); assert.equal(auth.authenticated(req), false);
  assert.equal(auth.authenticated(request({ headers: { authorization: `Bearer ${auth.token}` } })), true);
});

test('auth: cookie attributes, malformed cookies and listener-specific credential names', () => {
  const auth = new LocalApiAuth(); const res = response(); auth.setCookie(res, 32123);
  assert.match(res.headers['set-cookie'], /HttpOnly/); assert.match(res.headers['set-cookie'], /SameSite=Strict/);
  assert.equal(auth.authenticated(request({ headers: { cookie: res.headers['set-cookie'].split(';')[0] } })), true);
  assert.equal(auth.authenticated(request({ socket: { localPort: 32124 }, headers: { cookie: res.headers['set-cookie'].split(';')[0] } })), false);
  assert.equal(auth.authenticated(request({ headers: { cookie: `${DESKTOP_COOKIE}_32123=%E0%A4` } })), false);
  assert.equal(auth.authenticated(request({ headers: { authorization: `Bearer ${auth.token}x` } })), false);
});

test('auth: Host, Origin and Fetch Metadata fail closed, including a fake mobile origin', () => {
  const auth = new LocalApiAuth();
  for (const headers of [
    { host: 'attacker.invalid:32123' }, { host: '127.0.0.1:32124' },
    { host: '127.0.0.1:32123@attacker.invalid' }, { host: '127.0.0.1:32123/path' },
    { origin: 'http://127.0.0.1:32124' }, { origin: 'https://127.0.0.1:32123' },
    { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) assert.throws(() => auth.validateRequest(request({ headers })), status(403), JSON.stringify(headers));
  assert.doesNotThrow(() => auth.validateRequest(request({ headers: { origin: 'http://127.0.0.1:32123', 'sec-fetch-site': 'same-origin' } })));
  assert.doesNotThrow(() => auth.validateRequest(request({ socket: { encrypted: true }, headers: { origin: 'https://127.0.0.1:32123' } })));
});

test('auth: bootstrap expiration, bounded issuance and per-operation rate limiting', t => {
  let now = 1_000_000; t.mock.method(Date, 'now', () => now);
  const auth = new LocalApiAuth(); const req = request();
  const expired = auth.createBootstrap(); now += 300001;
  assert.equal(auth.acceptBootstrap(req, expired), false);
  const oldest = auth.createBootstrap(); for (let i = 0; i < 8; i++) auth.createBootstrap();
  assert.equal(auth.acceptBootstrap(req, oldest), false);
  for (let i = 0; i < 10; i++) auth.rateLimit(req, 'bootstrap');
  assert.throws(() => auth.rateLimit(req, 'bootstrap'), status(429));
  assert.doesNotThrow(() => auth.rateLimit(req, 'pair'));
  now += 60001; assert.doesNotThrow(() => auth.rateLimit(req, 'bootstrap'));
});

test('upload: correct transfer completes once and preserves owner binding', async t => {
  const f = fixtures(t); const routes = f.routes(); const created = await init(routes);
  assert.equal(created.status, 200); const id = created.body.uploadId;
  assert.equal((await invoke(routes, `/api/uploads/chunk?uploadId=${id}&offset=0`, Buffer.from('x'), 'other')).status, 404);
  await fill(routes, id);
  assert.equal((await invoke(routes, '/api/uploads/complete', { uploadId: id }, 'other')).status, 404);
  assert.equal((await invoke(routes, '/api/uploads/complete', { uploadId: id, sha256: 'wrong' })).status, 409);
  const completed = await invoke(routes, '/api/uploads/complete', { uploadId: id });
  assert.equal(completed.status, 200); assert.match(completed.body.sha256, /^[a-f0-9]{64}$/);
  assert.match(completed.body.savedPath, /^uploads\/session\//);
  assert.equal(fs.statSync(path.join(f.workspace, completed.body.savedPath)).size, DECLARED_SIZE);
  assert.equal((await invoke(routes, '/api/uploads/complete', { uploadId: id })).status, 404);
});

test('upload: per-owner reservation quota is enforced and released by close', async t => {
  const f = fixtures(t); const routes = f.routes();
  for (let i = 0; i < 8; i++) assert.equal((await init(routes)).status, 200);
  assert.equal((await init(routes)).status, 429);
  assert.equal((await init(routes, 'second', 'other')).status, 200);
  routes.close();
  assert.equal(fs.readdirSync(path.join(f.workspace, 'uploads', 'session', '.chunks')).length, 0);
});

test('upload: inflight body slots are bounded and released on body abort', async t => {
  const f = fixtures(t); const routes = f.routes(); const created = await init(routes); assert.equal(created.status, 200);
  const route = `/api/uploads/chunk?uploadId=${created.body.uploadId}&offset=0`;
  const active = Array.from({ length: 8 }, () => startRequest(routes, route));
  try {
    const rejected = await invoke(routes, route, Buffer.from('x'));
    assert.equal(rejected.status, 429);
    active[0].req.emit('aborted'); assert.equal((await active[0].result).status, 400);
    assert.equal((await invoke(routes, route, Buffer.from('x'))).status, 200);
  } finally {
    for (const call of active) { call.req.emit('aborted'); call.req.destroy(); }
    await Promise.all(active.map(call => call.result));
  }
});

test('upload: completed bodies queued behind a commit lock must still consume inflight quota', async t => {
  const f = fixtures(t); const routes = f.routes(); const created = await init(routes); assert.equal(created.status, 200);
  const id = created.body.uploadId; const pending = []; let release;
  // A slow completion hash holds this same production lock. Hold it explicitly
  // to make the admission-versus-commit race deterministic without large memory.
  const held = routes.lock(id, () => new Promise(resolve => { release = resolve; }));
  await tick();
  try {
    for (let i = 0; i < 9; i++) {
      pending.push(invoke(routes, `/api/uploads/chunk?uploadId=${id}&offset=0`, Buffer.from('x')));
      await tick();
    }
  } finally { release(); await held; }
  const outcomes = await Promise.all(pending);
  t.diagnostic(`queued chunk responses: ${outcomes.map(item => item.status).join(',')}`);
  assert.equal(outcomes[8].status, 429, 'the ninth buffered/queued request must not evade the per-owner bound');
});

test('upload: init rejects an outside folder alias before creating outside .chunks', async t => {
  const f = fixtures(t); const routes = f.routes();
  fs.mkdirSync(path.join(f.workspace, 'uploads')); link(f.outside, path.join(f.workspace, 'uploads', 'alias'));
  const outcome = await init(routes, 'alias');
  assert.equal(outcome.status, 403);
  assert.equal(fs.existsSync(path.join(f.outside, '.chunks')), false, 'validation must precede recursive mkdir');
});

test('upload: a .chunks alias to workspace root must not promote completion into the workspace parent', async t => {
  const f = fixtures(t); const routes = f.routes();
  const session = path.join(f.workspace, 'uploads', 'alias'); fs.mkdirSync(session, { recursive: true });
  link(f.workspace, path.join(session, '.chunks'));
  const created = await init(routes, 'alias');
  if (created.status === 403) return; // Correct early rejection is also valid.
  assert.equal(created.status, 200); const id = created.body.uploadId;
  await fill(routes, id);
  const completed = await invoke(routes, '/api/uploads/complete', { uploadId: id });
  if (completed.status === 403) return;
  assert.equal(completed.status, 200);
  t.diagnostic(`alias completion savedPath: ${completed.body.savedPath}`);
  assert.match(completed.body.savedPath, /^uploads\/alias\//, 'canonical .chunks parent depth must not define the final destination');
});

test('upload: startup cleanup must not follow an uploads root alias outside the workspace', t => {
  const f = fixtures(t); const chunks = path.join(f.outside, 'session', '.chunks'); fs.mkdirSync(chunks, { recursive: true });
  const marker = path.join(chunks, 'upl_12345678-abcd.part'); fs.writeFileSync(marker, 'outside fixture marker');
  const old = new Date(Date.now() - 3 * 60 * 60_000); fs.utimesSync(marker, old, old);
  link(f.outside, path.join(f.workspace, 'uploads'));
  let constructionError;
  try { f.routes(); } catch (error) { constructionError = error; }
  assert.equal(fs.existsSync(marker), true, 'startup cleanup must preserve outside data even if construction is rejected');
  if (constructionError) assert.ok(constructionError instanceof Error);
});

for (const endpoint of ['init', 'complete']) {
  test(`upload: ${endpoint} body readers must participate in the global inflight bound`, async t => {
    const f = fixtures(t); const routes = f.routes();
    // Empty, unfinished streams model authenticated slow-body requests. No
    // large payload or actual socket is needed to check admission control.
    const calls = Array.from({ length: 33 }, (_, index) => startRequest(routes, `/api/uploads/${endpoint}`, `owner-${index}`));
    let admitted;
    try {
      await tick();
      admitted = calls.filter(call => call.req.listenerCount('data') > 0).length;
      t.diagnostic(`${endpoint} simultaneous admitted body readers: ${admitted}`);
    } finally {
      for (const call of calls) { call.req.emit('aborted'); call.req.destroy(); }
      await Promise.all(calls.map(call => call.result));
    }
    assert.ok(admitted <= 32, 'the chunk-only gate must not leave other upload bodies unbounded');
  });
}
