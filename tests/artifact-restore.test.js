// Restored conversations used to hand the browser an artifact URL that 404'd:
// the registry stored the raw relative path, and FileRoutes checks it with
// fs.existsSync, which resolves against the process cwd rather than the workspace.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sharp = require('sharp');

test('a restored artifact is served from the workspace, not the process cwd', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-artifact-restore-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'attachments'), { recursive: true });
  const image = path.join(workspace, 'attachments', 'probe.png');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 12, g: 200, b: 90 } } }).png().toFile(image);
  const bytes = fs.statSync(image).size;

  const at = Date.now();
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    sessions: [{ id: 's_art', title: '出图', created: at, updated: at, messageCount: 2, projectRoot: '', projectName: '无项目' }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', 's_art.json'), JSON.stringify([
    { role: 'user', content: '看图', timestamp: at },
    {
      role: 'assistant', content: '好了', status: 'done', timestamp: at + 1,
      toolCalls: [{
        id: 'c1', name: 'display_file', args: { path: 'attachments/probe.png' },
        result: { success: true, output: 'shown', artifacts: [{ path: 'attachments/probe.png', kind: 'image', mimeType: 'image/png' }] },
      }],
    },
  ]));

  process.env.IEXA_WORKSPACE = workspace;
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const token = backend.getServerCredentials(server).token;
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  });

  const session = await (await fetch(endpoint + '/api/sessions/s_art', {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  const artifact = session.messages[1].toolCalls[0].result.artifacts[0];
  assert.ok(artifact.url && artifact.url.startsWith('/api/artifacts/'), 'the URL is generated: ' + artifact.url);

  const response = await fetch(endpoint + artifact.url, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200, 'the restored artifact is served');
  assert.equal(response.headers.get('content-type'), 'image/png');
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, bytes, 'the served bytes match the file on disk');
  assert.equal(body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'and they are the PNG itself');
});
