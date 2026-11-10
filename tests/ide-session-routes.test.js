'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const temp = require('./helpers/temp-dir');
const { setIDEContext, clearIDEContext } = require('../dist/main/ide/IDEContext');
const root = temp.make('iexa-ide-sessions-');
process.env.IEXA_WORKSPACE = path.join(root, 'app-data');
const project = path.join(root, 'ide-project'), chatProject = path.join(root, 'chat-project');
fs.mkdirSync(project); fs.mkdirSync(chatProject);
const backend = require('../dist/main/server');
let server, port, token;
async function request(route, method = 'GET', data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
test.before(async () => { server = await backend.startServer(0, false); port = server.address().port; token = backend.getServerCredentials(server).token; });
test.after(async () => { clearIDEContext(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); temp.remove(root); });

test('IDE creates a chat in its authorized project without retargeting the original conversation', async () => {
  await request('/api/project', 'POST', { root: chatProject });
  const original = (await request('/api/sessions', 'POST', {})).data.session;
  const rejected = await request('/api/sessions', 'POST', { ideProjectRoot: project });
  assert.equal(rejected.status, 400);
  setIDEContext(project, { activeFile: 'main.js', selectedCode: 'PROJECT_CONTEXT' });
  const response = await request('/api/sessions', 'POST', { ideProjectRoot: project });
  assert.equal(response.status, 200);
  assert.equal(response.data.session.projectRoot, fs.realpathSync.native(project));
  const sessions = (await request('/api/sessions')).data.sessions;
  assert.equal(sessions.find(session => session.id === original.id).projectRoot, fs.realpathSync.native(chatProject));
  assert.equal((await request('/api/project')).data.root, fs.realpathSync.native(chatProject));
  clearIDEContext(project);
  assert.equal((await request('/api/sessions', 'POST', { ideProjectRoot: project })).status, 400);
});
