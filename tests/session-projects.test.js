'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-session-projects-'));
process.env.IEXA_WORKSPACE = path.join(fixture, 'workspace');
fs.mkdirSync(process.env.IEXA_WORKSPACE);
const projectA = path.join(fixture, 'project-a');
const projectB = path.join(fixture, 'project-b');
fs.mkdirSync(projectA); fs.mkdirSync(projectB);
const backend = require('../dist/main/server');
let server, port, token;
function request(route, method = 'GET', body, auth = true) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json',
    } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, data: text ? JSON.parse(text) : {} });
    }); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test.before(async () => { server = await backend.startServer(0, false); port = server.address().port; token = backend.getServerCredentials(server).token; });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(fixture, { recursive: true, force: true }); });

test('projects own multiple conversations and pin metadata persists', async () => {
  let response = await request('/api/project', 'POST', { root: projectA }); assert.equal(response.status, 200);
  const a1 = (await request('/api/sessions', 'POST', {})).data.session;
  const a2 = (await request('/api/sessions', 'POST', {})).data.session;
  assert.equal(a1.projectRoot, fs.realpathSync.native(projectA)); assert.equal(a2.projectRoot, a1.projectRoot);
  assert.equal(a1.projectName, 'project-a'); assert.equal(a2.pinned, false);

  response = await request(`/api/sessions/${a1.id}`, 'PATCH', { pinned: true });
  assert.equal(response.status, 200); assert.equal(response.data.session.pinned, true); assert.ok(response.data.session.pinnedAt > 0);
  const invalid = await request(`/api/sessions/${a1.id}`, 'PATCH', { pinned: true, archived: false });
  assert.equal(invalid.status, 400);

  await request('/api/project', 'POST', { root: projectB });
  const b1 = (await request('/api/sessions', 'POST', {})).data.session;
  assert.equal(b1.projectRoot, fs.realpathSync.native(projectB));
  const index = (await request('/api/sessions')).data;
  assert.equal(index.sessions.filter(session => session.projectRoot === a1.projectRoot).length, 2);
  assert.equal(index.sessions.filter(session => session.projectRoot === b1.projectRoot).length, 1);
  assert.equal(index.sessions.find(session => session.id === a1.id).pinned, true);

  const opened = await request(`/api/sessions/${a2.id}`);
  assert.equal(opened.status, 200); assert.ok(Array.isArray(opened.data.messages));
  const activated = await request(`/api/sessions/${a2.id}/activate`, 'POST', {});
  assert.equal(activated.status, 200); assert.equal(activated.data.project.root, a1.projectRoot);
  assert.equal((await request('/api/project')).data.root, a1.projectRoot);
  assert.equal((await request('/api/sessions')).data.activeSessionId, a2.id);
});

test('legacy session metadata migrates to the current project without losing fields', async () => {
  const projectRoot = fs.realpathSync.native(projectA);
  await request('/api/project', 'POST', { root: projectRoot });
  const legacy = { id: 'sess_legacy', title: '旧对话', created: 1, updated: 2, messageCount: 0 };
  fs.writeFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions.json'), JSON.stringify({ sessions: [legacy], activeSessionId: legacy.id }));
  const data = (await request('/api/sessions')).data;
  assert.equal(data.sessions[0].projectRoot, projectRoot);
  assert.equal(data.sessions[0].projectName, 'project-a');
  assert.equal(data.sessions[0].pinned, false);
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions.json'), 'utf8'));
  assert.equal(stored.sessions[0].projectRoot, projectRoot);
});

test('standalone trustLoopback mode removes login only for real non-TLS loopback requests', async () => {
  const trusted = await backend.startServer(0, false, '127.0.0.1', { trustLoopback: true });
  const trustedPort = trusted.address().port;
  const anonymous = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: trustedPort, path: '/api/appearance' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(anonymous, 200);
  const root = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: trustedPort, path: '/' }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })); }).on('error', reject);
  });
  assert.equal(root.status, 200); assert.match(root.body, /src="app\.js"/); assert.doesNotMatch(root.body, /auth-login\.js/);
  trusted.closeAllConnections(); await new Promise(resolve => trusted.close(resolve));
  assert.equal((await request('/api/appearance', 'GET', undefined, false)).status, 401, 'default test/API server keeps explicit identity');
});
