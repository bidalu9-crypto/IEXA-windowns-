const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
  assert.ok(tool.parameters.forcePointer);
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
        ? new Response(JSON.stringify({ product: 'IEXA Desktop Agent', protocolVersion: 4, automationEngine: 'FlaUI 5', instanceNonce: '0123456789abcdef' }), { status: 200 })
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

test('FlaUI native agent performs 20 stable pattern-based fixture interactions', { timeout: 120_000, skip: process.platform !== 'win32' }, async (t) => {
  const root = path.resolve(__dirname, '..');
  const workspaceKey = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
  const cache = path.join(os.tmpdir(), `iexa-flaui-test-cache-${workspaceKey}`);
  const publish = path.join(cache, 'agent');
  const fixturePublish = path.join(cache, 'fixture');
  const logPath = path.join(os.tmpdir(), `iexa-flaui-fixture-${process.pid}.jsonl`);
  fs.mkdirSync(cache, { recursive: true });
  fs.rmSync(logPath, { force: true });
  const port = 24000 + Math.floor(Math.random() * 12000);
  const title = `IEXA FlaUI Fixture ${process.pid}-${Date.now()}`;
  const buildAgent = spawnSync('dotnet', [
    'publish', path.join(root, 'desktop-agent', 'Iexa.DesktopAgent.csproj'),
    '-c', 'Release', '-o', publish, '--no-self-contained',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(buildAgent.status, 0, `${buildAgent.stdout}\n${buildAgent.stderr}`);
  const buildFixture = spawnSync('dotnet', [
    'publish', path.join(root, 'desktop-agent', 'PerceptionFixture.csproj'),
    '-c', 'Release', '-o', fixturePublish, '--no-self-contained',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(buildFixture.status, 0, `${buildFixture.stdout}\n${buildFixture.stderr}`);

  const fixtureExe = path.join(fixturePublish, 'PerceptionFixture.exe');
  const agentExe = path.join(publish, 'Iexa.DesktopAgent.exe');
  const fixture = spawn(fixtureExe, [logPath, title], { cwd: root, stdio: 'ignore' });
  const agent = spawn(agentExe, [], {
    cwd: root,
    env: { ...process.env, IEXA_DESKTOP_PORT: String(port) },
    stdio: 'ignore',
  });
  const endpoint = `http://127.0.0.1:${port}`;

  const waitFor = async (probe, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await probe();
        if (value) return value;
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw lastError || new Error(`Condition timed out after ${timeoutMs} ms.`);
  };
  const post = async (body) => {
    const response = await fetch(`${endpoint}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.ok, true, JSON.stringify(value));
    assert.equal(value.ok, true, JSON.stringify(value));
    return value.data;
  };
  const stop = async (child) => {
    const isAlive = () => {
      try { process.kill(child.pid, 0); return true; }
      catch { return false; }
    };
    const waitUntilGone = async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (isAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    if (!isAlive()) return;
    child.kill();
    await waitUntilGone(1500);
    if (isAlive()) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      await waitUntilGone(3000);
    }
    assert.equal(isAlive(), false, `Child process ${child.pid} did not exit.`);
  };

  try {
    const health = await waitFor(async () => {
      const response = await fetch(`${endpoint}/health`);
      return response.ok ? response.json() : null;
    });
    assert.equal(health.product, 'IEXA Desktop Agent');
    assert.equal(health.protocolVersion, 4);
    assert.equal(health.automationEngine, 'FlaUI 5');
    assert.ok(health.instanceNonce.length >= 16);

    const capabilities = await (await fetch(`${endpoint}/capabilities`)).json();
    assert.equal(capabilities.automationEngine, 'FlaUI 5');
    assert.equal(capabilities.primaryBackend, 'UIA3');
    assert.equal(capabilities.fallbackBackend, 'UIA2');
    assert.equal(capabilities.stableSelectors, true);
    assert.equal(capabilities.patternActions, true);

    await waitFor(async () => {
      try { return await post({ action: 'activate', window: title }); }
      catch { return null; }
    });

    const messages = [];
    const durations = [];
    for (let index = 0; index < 20; index++) {
      const started = Date.now();
      const message = `IEXA-FLAUI-${String(index + 1).padStart(2, '0')}-${Date.now()}`;
      messages.push(message);

      const observation = await post({ action: 'observe', includeElements: true, limit: 100 });
      assert.equal(observation.automation.backend, 'uia3');
      assert.deepEqual(observation.automation.diagnostics, []);
      const input = observation.elements.find((element) => element.selector?.automationId === 'messageInput');
      const send = observation.elements.find((element) => element.selector?.automationId === 'sendButton');
      assert.ok(input?.selector?.runtimeId?.length, 'Stable selector for messageInput is missing.');
      assert.ok(send?.selector?.runtimeId?.length, 'Stable selector for sendButton is missing.');

      const typed = await post({
        action: 'type_element',
        elementId: input.id,
        observationToken: observation.session.observationToken,
        text: message,
        replace: true,
      });
      assert.equal(typed.method, 'uia_value');
      assert.equal(typed.automation.backend, 'uia3');

      if (index === 0) {
        const staleResponse = await fetch(`${endpoint}/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'click_element',
            elementId: send.id,
            observationToken: observation.session.observationToken,
          }),
        });
        const stale = await staleResponse.json();
        assert.equal(staleResponse.ok, false);
        assert.match(stale.error, /stale|not found/i);
      }

      const afterType = await post({ action: 'observe', includeElements: true, limit: 100 });
      const currentSend = afterType.elements.find((element) => element.selector?.automationId === 'sendButton');
      assert.ok(currentSend);
      const clicked = await post({
        action: 'click_element',
        elementId: currentSend.id,
        observationToken: afterType.session.observationToken,
        settleMs: 30,
      });
      assert.equal(clicked.method, 'uia_invoke');
      assert.equal(clicked.automation.backend, 'uia3');
      assert.equal(clicked.effectObserved, true);
      durations.push(Date.now() - started);
      assert.ok(durations.at(-1) < 20_000, `Iteration ${index + 1} exceeded 20 seconds.`);
    }

    const records = await waitFor(() => {
      if (!fs.existsSync(logPath)) return null;
      const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      return lines.length === messages.length ? lines.map((line) => JSON.parse(line)) : null;
    });
    assert.deepEqual(records.map((record) => record.text), messages);
    const p95 = [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1];
    assert.ok(p95 < 20_000, `p95 ${p95} ms exceeded the 20 second requirement.`);
    t.diagnostic(`20/20 messages verified; p95=${p95} ms; max=${Math.max(...durations)} ms`);
  } finally {
    const cleanup = await Promise.allSettled([stop(agent), stop(fixture)]);
    try { fs.rmSync(logPath, { force: true, maxRetries: 10, retryDelay: 50 }); }
    finally {
      const failed = cleanup.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
});
