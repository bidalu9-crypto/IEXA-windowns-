const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DesktopLiveState } = require('../dist/main/tools/desktop/DesktopLiveState');

function result(backend, endpoint, extra = {}) {
  return { success: true, output: '{}', metadata: {
    ...(backend === 'chromium-cdp' ? { cdpEndpoint: endpoint } : { endpoint }),
    desktop: { control: { mode: 'background', backend, physicalInput: false, noForegroundFallback: true } },
  }, ...extra };
}
async function helper(t, label) {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ product: 'IEXA Desktop Agent', cachedPreview: true })); }
    else { res.setHeader('Content-Type', 'image/png'); res.setHeader('X-IEXA-Frame-Mode', 'cached-observation'); res.end(label); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, paths };
}

test('before an operation, live status and frame do not start or contact a helper', async () => {
  const state = new DesktopLiveState();
  assert.equal(state.status().observed, false);
  assert.equal((await state.readFrame()).status, 404);
});
test('native-isolated live preview follows its actual helper instead of the primary desktop', async t => {
  const primary = await helper(t, 'primary'), isolated = await helper(t, 'isolated');
  const state = new DesktopLiveState();
  state.recordControlResult(result('native', primary.endpoint), 'chat-a');
  state.recordControlResult(result('native-isolated', isolated.endpoint), 'chat-a');
  assert.equal(await (await state.readFrame()).text(), 'isolated');
  assert.deepEqual(primary.paths, []);
  assert.equal(isolated.paths.length, 2);
  assert.match(isolated.paths[1], /cached=1/);
});
test('CDP preview reuses the existing observation without any browser call and preserves capture time', async () => {
  const state = new DesktopLiveState();
  const endpoint = 'http://127.0.0.1:9222';
  state.recordTransportPreview({ success: true, output: JSON.stringify({ data: { frame: { capturedAt: 123456 } } }), imageData: Buffer.from('browser-pixels'), imageMimeType: 'image/png' }, { backend: 'chromium-cdp', endpoint });
  state.recordControlResult(result('chromium-cdp', endpoint), 'chat-b');
  const frame = await state.readFrame();
  assert.equal(await frame.text(), 'browser-pixels');
  assert.equal(frame.headers.get('x-captured-at'), '123456');
  assert.equal(state.status().control.backend, 'chromium-cdp');
  assert.equal(state.status().control.physicalInput, false);
  state.recordControlResult(result('chromium-cdp', 'http://127.0.0.1:9333'), 'chat-b');
  assert.equal((await state.readFrame()).status, 404);
});
test('changing owner or backend clears old target pixels rather than showing a different task', async () => {
  const state = new DesktopLiveState();
  const endpoint = 'http://127.0.0.1:9222';
  state.recordTransportPreview({ success: true, output: '{}', imageData: Buffer.from('pixels'), imageMimeType: 'image/png' }, { backend: 'chromium-cdp', endpoint });
  state.recordControlResult(result('chromium-cdp', endpoint), 'first');
  assert.equal((await state.readFrame()).status, 200);
  state.recordControlResult(result('chromium-cdp', endpoint), 'second');
  assert.equal((await state.readFrame()).status, 404);
  state.recordControlResult(result('native-isolated', undefined, { success: false }), 'second');
  assert.equal(state.status().success, false);
  assert.equal((await state.readFrame()).status, 404);
});
test('invalid native preview sources and missing controls never cause arbitrary fetches', async () => {
  const state = new DesktopLiveState();
  state.recordControlResult(result('native', 'https://example.com'), 'chat');
  assert.equal((await state.readFrame()).status, 404);
  state.recordControlResult({ success: true, output: '{}', metadata: {} }, 'chat');
  assert.equal((await state.readFrame()).status, 404);
});
test('failed CDP retargeting cannot display pixels from the prior page', async () => {
  const state = new DesktopLiveState();
  const endpoint = 'http://127.0.0.1:9222';
  state.recordTransportPreview({ success: true, output: '{}', imageData: Buffer.from('old-target'), imageMimeType: 'image/png' }, { backend: 'chromium-cdp', endpoint, targetId: 'old' });
  const previous = result('chromium-cdp', endpoint); previous.metadata.cdpTargetId = 'old';
  state.recordControlResult(previous, 'chat');
  assert.equal((await state.readFrame()).status, 200);
  const failure = result('chromium-cdp', undefined, { success: false });
  state.recordControlResult(failure, 'chat');
  assert.equal((await state.readFrame()).status, 404);
  assert.equal(state.status().hasFrame, false);
});

test('cached CDP frame results preserve observation time rather than claiming a new capture', async () => {
  const state = new DesktopLiveState(), endpoint = 'http://127.0.0.1:9222';
  state.recordTransportPreview({ success: true, output: JSON.stringify({ data: { capturedAt: 123456 } }), imageData: Buffer.from('cached-existing-pixels'), imageMimeType: 'image/png' }, { backend: 'chromium-cdp', endpoint, targetId: 'existing' });
  const response = result('chromium-cdp', endpoint); response.metadata.cdpTargetId = 'existing';
  state.recordControlResult(response, 'same-owner');
  assert.equal(state.status().capturedAt, 123456);
  assert.equal((await state.readFrame()).headers.get('x-captured-at'), '123456');
});
