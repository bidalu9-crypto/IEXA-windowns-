const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeAgentTools } = require('../dist/main/tools/ToolDefinitions');
const { DesktopAgent, formatDesktopResult } = require('../dist/main/tools/DesktopAgent');

test('desktop_control exposes non-vision semantic actions', () => {
  const tool = makeAgentTools(true).find((x) => x.name === 'desktop_control');
  assert.ok(tool);
  for (const action of ['observe', 'activate', 'minimize', 'bind_window', 'session_state', 'click_element', 'type_element', 'find_element', 'read_focused', 'wait_change', 'batch']) {
    assert.ok(tool.parameters.action.enumValues.includes(action));
  }
  assert.ok(tool.parameters.includeOcr);
  assert.ok(tool.parameters.includeRegions);
  assert.ok(tool.parameters.elementId);
  assert.ok(tool.parameters.observationToken);
  assert.ok(tool.parameters.relativeX);
  assert.ok(tool.parameters.relativeY);
});

test('desktop agent owns input lifetime and guards window-closing hotkeys', async () => {
  const source = await require('node:fs').promises.readFile(path.join(__dirname, '..', 'desktop-agent', 'Program.cs'), 'utf8');
  assert.match(source, /sealed class InputLease : IDisposable/);
  assert.match(source, /InputLease\.ReleaseActive\(\)/);
  assert.match(source, /ALT\+F4 is blocked/);
  assert.doesNotMatch(source, /mouse_event\(/);
  assert.doesNotMatch(source, /keybd_event\(/);
});

test('desktop agent returns structured local perception', async () => {
  const agent = new DesktopAgent(path.resolve(__dirname, '..'));
  const result = await agent.execute({ action: 'observe', detail: 'raw', includeElements: true, includeOcr: true, includeRegions: true, captureFrame: false, limit: 30 });
  assert.equal(result.success, true, result.output);
  const body = JSON.parse(result.output);
  assert.equal(body.ok, true);
  assert.equal(body.data.mode, 'structured-local-perception-v2');
  assert.ok(body.data.frame.hash);
  assert.ok(Array.isArray(body.data.elements));
  assert.ok(body.data.ocr.status);
  assert.equal(body.data.session.bound, true);
  assert.ok(body.data.session.observationToken);
  assert.equal(result.imageData, undefined);
});

test('desktop agent exposes a low-latency frame action and drag coordinates', () => {
  const tool = makeAgentTools(true).find((x) => x.name === 'desktop_control');
  assert.ok(tool.parameters.action.enumValues.includes('frame'));
  assert.ok(tool.parameters.action.enumValues.includes('drag'));
  for (const key of ['toX', 'toY', 'toRelativeX', 'toRelativeY']) assert.ok(tool.parameters[key]);
});

test('desktop agent routes both parent cancellation and local timeout through the native cancel endpoint', async () => {
  const source = await require('node:fs').promises.readFile(path.join(__dirname, '..', 'src', 'main', 'tools', 'DesktopAgent.ts'), 'utf8');
  assert.match(source, /fetch\(`\$\{ENDPOINT\}\/cancel`/);
  assert.match(source, /const timeout = setTimeout\(abortParent, actionTimeout\)/);
});

test('desktop agent accepts tray-hidden windows when resolving an explicit process or title', async () => {
  const source = await require('node:fs').promises.readFile(path.join(__dirname, '..', 'desktop-agent', 'Program.cs'), 'utf8');
  assert.match(source, /Background apps such as Weixin keep their logged-in main window/);
  assert.match(source, /var visible = IsWindowVisible\(h\)/);
});

test('compact desktop feedback keeps actionable IDs without window-list noise', () => {
  const output = formatDesktopResult({ ok: true, action: 'observe', elapsedMs: 25, data: {
    session: { observationToken: 'token' }, elements: [{ id: 'edit1', role: 'edit', text: 'Input', bounds: { left: 10 } }],
    windows: Array(200).fill({ title: 'noise' }),
  } });
  assert.match(output, /edit1/);
  assert.match(output, /token/);
  assert.doesNotMatch(output, /noise/);
});

test('desktop adapter treats native failure and missed waits as failures', async () => {
  const originalFetch = global.fetch;
  try {
    for (const payload of [{ ok: false, error: 'blocked' }, { ok: true, action: 'wait', data: { found: false } }]) {
      global.fetch = async (url) => String(url).endsWith('/health')
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify(payload), { status: 200 });
      const result = await new DesktopAgent(path.resolve(__dirname, '..')).execute({ action: 'wait', text: 'target' });
      assert.equal(result.success, false);
    }
  } finally { global.fetch = originalFetch; }
});

test('native pause persists and batch failures stop execution', async () => {
  const source = await require('node:fs').promises.readFile(path.join(__dirname, '..', 'desktop-agent', 'Program.cs'), 'utf8');
  assert.match(source, /Volatile\.Read\(ref Paused\) != 0/);
  assert.match(source, /cancellationAtQueue != Interlocked\.Read\(ref CancellationEpoch\)/);
  assert.match(source, /actions\.Count > 24/);
  assert.match(source, /Batch input completed but verification text was not found/);
  assert.match(source, /includeOcr.*false/);
});
