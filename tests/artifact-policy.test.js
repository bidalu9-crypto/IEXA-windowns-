'use strict';
// Restored artifact cards must reflect what is actually on disk: scratch files
// are shown but never kept, and a card whose file vanished is dropped instead
// of painting an empty frame after a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const { isTransientArtifact, isServableArtifact, resolveArtifactPath } = require('../dist/main/agent/ArtifactPolicy');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-artifact-policy-'));
const workspace = path.join(directory, 'workspace');
fs.mkdirSync(path.join(workspace, '.tmp'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'attachments'), { recursive: true });
const scratch = path.join(workspace, '.tmp', 'probe.png');
const delivered = path.join(workspace, 'attachments', 'chart.png');
fs.writeFileSync(scratch, 'png');
fs.writeFileSync(delivered, 'png');
process.env.IEXA_WORKSPACE = workspace;

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('scratch files are transient without hiding the delivered ones', () => {
  assert.equal(isTransientArtifact(workspace, scratch), true);
  assert.equal(isTransientArtifact(workspace, '.tmp/nested/frame.png'), true);
  assert.equal(isTransientArtifact(workspace, delivered), false);
  assert.equal(isTransientArtifact(workspace, 'attachments/chart.png'), false);
  assert.equal(isTransientArtifact(workspace, path.join(directory, 'outside.png')), false);
});

test('only files that still exist can be served', () => {
  assert.equal(isServableArtifact(workspace, scratch), true);
  assert.equal(isServableArtifact(workspace, delivered), true);
  assert.equal(isServableArtifact(workspace, 'attachments/chart.png'), true);
  assert.equal(isServableArtifact(workspace, path.join(workspace, '.tmp', 'gone.png')), false);
  assert.equal(resolveArtifactPath(workspace, 'attachments/chart.png'), delivered);
});

test('restoring a session drops artifacts whose file is gone', async () => {
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const token = backend.getServerCredentials(server).token;
  try {
    const created = await fetch(endpoint + '/api/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const sessionId = created.session.id;

    const missing = path.join(workspace, 'attachments', 'deleted.png');
    const messages = [{
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
      toolCalls: [{
        id: 'call_display', name: 'display_file', args: {},
        result: {
          output: 'displayed', success: true,
          artifacts: [
            { kind: 'image', path: delivered, mimeType: 'image/png', size: 3, url: '/api/artifacts/stale-live-id' },
            { kind: 'image', path: missing, mimeType: 'image/png', size: 3, url: '/api/artifacts/stale-missing-id' },
          ],
        },
      }],
    }];
    fs.writeFileSync(path.join(workspace, '.iexa-sessions', sessionId + '.json'), JSON.stringify(messages));

    const payload = await fetch(endpoint + '/api/sessions/' + sessionId, {
      headers: { Authorization: 'Bearer ' + token },
    }).then((r) => r.json());
    const artifacts = payload.messages[0].toolCalls[0].result.artifacts;
    assert.equal(artifacts.length, 1, 'the deleted file must not survive a restore');
    assert.equal(artifacts[0].path, delivered);
    assert.match(artifacts[0].url, /^\/api\/artifacts\/artifact_[a-f0-9]{64}$/);

    const served = await fetch(endpoint + artifacts[0].url, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(served.status, 200, 'the surviving artifact still resolves');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
