'use strict';
/**
 * Regression tests for the Windows termination paths.
 *
 * The defect these lock down: libuv resolves `taskkill.exe` through PATH and
 * throws synchronously when the resolved file cannot be executed. The old code
 * caught that, resolved immediately, and killed only the direct child — so a
 * cancelled command's real work (cmd.exe's grandchildren) kept running while
 * the caller was told it had been cancelled.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProcessManager } = require('../dist/main/tools/shell/ProcessManager');

const windowsOnly = process.platform !== 'win32' ? { skip: 'Windows-only behaviour' } : {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function waitForDeath(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return false;
}

const commandTempDirs = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('iexa-cmd-'));

/**
 * A fixture that reports its own PID and its child's, and keeps running. The
 * child inherits stdout on purpose so the pipe stays open after the parent
 * dies — the case where 'close' arrives late.
 */
function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-terminate-'));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* locked */ }
  });
  const marker = path.join(root, 'pids.json');
  const script = path.join(root, 'fixture.cjs');
  fs.writeFileSync(script, [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore','inherit','inherit'], windowsHide: true });",
    `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));`,
    'setInterval(()=>{},1000);',
  ].join('\n'));
  return { root, marker, command: `"${process.execPath}" "${script}"` };
}

async function readPids(marker) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { await sleep(25); }
  }
  throw new Error('fixture never reported its process ids');
}

async function runAndTerminate(t, { policy, cancelAfterMs, command }) {
  const fixture = createFixture(t);
  const before = commandTempDirs().length;
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = new ProcessManager().run(command || fixture.command, fixture.root, controller.signal, policy, 'cmd');
  const pids = await readPids(fixture.marker);
  if (cancelAfterMs != null) setTimeout(() => controller.abort(), cancelAfterMs);
  const result = await pending;
  const elapsed = Date.now() - startedAt;
  const deaths = [];
  for (const pid of pids) deaths.push(await waitForDeath(pid, 5000));
  await sleep(500);
  return { result, elapsed, pids, deaths, leftoverTempDirs: commandTempDirs().length - before };
}

test('a plain command is unaffected', windowsOnly, async (t) => {
  const fixture = createFixture(t);
  const result = await new ProcessManager().run('echo IEXA_TERMINATION_OK', fixture.root,
    new AbortController().signal, { timeoutMs: 15000, maxOutputBytes: 4096, killGracePeriodMs: 1000 }, 'cmd');
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /IEXA_TERMINATION_OK/);
});

test('cancellation ends the running command and its child', windowsOnly, async (t) => {
  const { result, deaths, leftoverTempDirs } = await runAndTerminate(t, {
    policy: { timeoutMs: 20000, maxOutputBytes: 1_000_000, killGracePeriodMs: 1500 },
    cancelAfterMs: 300,
  });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, -1);
  assert.equal(result.output, 'Command cancelled.');
  assert.deepEqual(deaths, [true, true], 'the fixture parent and its child must both be gone');
  assert.equal(leftoverTempDirs, 0, 'the CMD temp directory is removed');
});

test('a timeout ends the tree and marks the result', windowsOnly, async (t) => {
  const { result, elapsed, deaths, leftoverTempDirs } = await runAndTerminate(t, {
    policy: { timeoutMs: 900, maxOutputBytes: 1_000_000, killGracePeriodMs: 1500 },
  });
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.deepEqual(deaths, [true, true]);
  assert.equal(leftoverTempDirs, 0);
  assert.ok(elapsed < 8000, 'the promise settles promptly, took ' + elapsed + 'ms');
});

test('reaching the output limit truncates and still ends the tree', windowsOnly, async (t) => {
  const fixture = createFixture(t);
  const chatty = path.join(fixture.root, 'chatty.cjs');
  fs.writeFileSync(chatty, "const chunk='x'.repeat(4096);setInterval(()=>process.stdout.write(chunk),10);setInterval(()=>{},1000);");
  const before = commandTempDirs().length;
  const result = await new ProcessManager().run(`"${process.execPath}" "${chatty}"`, fixture.root,
    new AbortController().signal, { timeoutMs: 20000, maxOutputBytes: 8192, killGracePeriodMs: 1200 }, 'cmd');
  await sleep(500);
  assert.equal(result.success, false);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= 8192, 'output stays within the limit');
  assert.equal(commandTempDirs().length - before, 0);
});

test('a cancel arriving after the command finished does not fabricate a failure', windowsOnly, async (t) => {
  const fixture = createFixture(t);
  const controller = new AbortController();
  const result = await new ProcessManager().run('exit /b 0', fixture.root, controller.signal,
    { timeoutMs: 15000, maxOutputBytes: 4096, killGracePeriodMs: 800 }, 'cmd');
  controller.abort();
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('a taskkill that cannot start still ends the tree', windowsOnly, async (t) => {
  const fixture = createFixture(t);
  // libuv resolves the bare name through PATH; this file resolves but cannot be
  // executed, which makes spawn throw synchronously (never an 'error' event).
  const fakeBin = path.join(fixture.root, 'fakebin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'taskkill.exe'), 'this is not a PE image');

  const unhandled = [];
  const onUncaught = (error) => unhandled.push('uncaught: ' + error.message);
  const onRejection = (error) => unhandled.push('unhandled: ' + (error && error.message));
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  const savedPath = process.env.PATH;
  const before = commandTempDirs().length;
  process.env.PATH = fakeBin + ';' + savedPath;
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = new ProcessManager().run(fixture.command, fixture.root, controller.signal,
      { timeoutMs: 20000, maxOutputBytes: 1_000_000, killGracePeriodMs: 1500 }, 'cmd');
    const pids = await readPids(fixture.marker);
    controller.abort();
    const result = await pending;
    const elapsed = Date.now() - startedAt;

    assert.equal(result.success, false);
    assert.equal(result.output, 'Command cancelled.');
    assert.ok(elapsed < 8000, 'the promise settles instead of waiting forever, took ' + elapsed + 'ms');

    const deaths = [];
    for (const pid of pids) deaths.push(await waitForDeath(pid, 5000));
    assert.deepEqual(deaths, [true, true],
      'the fallback must end the whole tree, not just cmd.exe');
  } finally {
    process.env.PATH = savedPath;
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  }

  await sleep(500);
  assert.deepEqual(unhandled, [], 'no unhandled child-process error escapes');
  assert.equal(commandTempDirs().length - before, 0);
});
