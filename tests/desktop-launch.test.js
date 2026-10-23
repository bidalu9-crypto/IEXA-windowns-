// Guards for the launch path. Every case here is a real failure observed while
// driving Weixin: a full path that got replaced by a guessed install, a client
// timeout shorter than the helper's own window wait, and a bind to a tray/IME
// helper instead of the app window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('a full path wins over the friendly-name table', () => {
  const source = read('desktop-agent/Program.cs');
  const resolve = source.slice(source.indexOf('static (string FileName, string Arguments, string ExpectedProcess) ResolveLaunchSpec'));
  const body = resolve.slice(0, resolve.indexOf('static string ResolveFirstExisting'));
  // The direct-path branch must come before the name lookup; otherwise
  // D:\Apps\Weixin\Weixin.exe is reduced to "weixin" and rerouted to Program Files.
  const directAt = body.indexOf('Path.IsPathRooted(direct) && File.Exists(direct)');
  const tableAt = body.indexOf('var key = Path.GetFileNameWithoutExtension(app)');
  assert.ok(directAt > 0, 'the direct-path branch exists');
  assert.ok(tableAt > 0, 'the name table exists');
  assert.ok(directAt < tableAt, 'the direct path is checked before the name table');
});

test('launch reuses a running instance instead of waiting for a new window', () => {
  const source = read('desktop-agent/Program.cs');
  assert.match(source, /reason = "already-running"/, 'an existing window is reported as reused');
  assert.match(source, /reason = "revealed-existing"/, 'a single-instance app that only reveals its window is handled');
  assert.match(source, /FindReusableWindow/, 'reuse goes through the strict finder');
  assert.match(source, /var forceNew = req\["forceNew"\]/, 'callers can opt out');
});

test('tray, IME and message-only windows are never chosen as the target', () => {
  const source = read('desktop-agent/Program.cs');
  const helper = source.slice(source.indexOf('static bool LooksLikeHelperWindow'), source.indexOf('static IntPtr FindReusableWindow'));
  for (const marker of ['TrayIcon', 'CandidateWindow', 'Mode Indicator', 'Default IME', 'MessageWindow']) {
    assert.ok(helper.includes(marker), `helper filter knows ${marker}`);
  }
  // Every place that can pick a window for launch must consult it.
  assert.match(source, /static bool IsUsableAppWindow/, 'one shared predicate exists');
  const pickAt = source.indexOf('h = FindWindow(title, process, pid);');
  assert.ok(pickAt > 0, 'the launch poll picks a window by process');
  const guard = source.slice(pickAt, pickAt + 400);
  assert.match(guard, /!IsUsableAppWindow\(h\)/, 'the launch poll rejects helper windows right after picking');
  assert.match(source, /h = FindNewWindow\(before, process\)/, 'the new-window scan is process aware');
});

test('the client timeout follows waitForWindowMs for a launch', () => {
  const source = read('src/main/tools/DesktopAgent.ts');
  assert.match(source, /const requestedWait = Number\(args\.waitForWindowMs \|\| 0\)/);
  const branch = source.slice(source.indexOf("action === 'launch'"), source.indexOf(': Math.max(5000'));
  assert.match(branch, /requestedWait \|\| 15000\) \+ 10000/,
    'the launch budget must exceed the helper wait, or a started app is reported as a timeout');
});

test('forceNew is declared and whitelisted so it reaches the helper', () => {
  const source = read('src/main/tools/ToolDefinitions.ts');
  assert.match(source, /forceNew: \{ type: 'boolean'/, 'the parameter is documented');
  const ordering = source.slice(source.indexOf("propertyOrdering: ['tool_title', 'action'"));
  assert.match(ordering.slice(0, 600), /'forceNew'/, 'and accepted by the argument whitelist');
});

// Opt-in integration run: needs a visible desktop and starts Notepad.
test('real agent: cold launch and reuse agree on the same window', { skip: !process.env.IEXA_TEST_DESKTOP_AGENT, timeout: 90000 }, async (t) => {
  const { spawn } = require('node:child_process');
  const exe = path.join(root, 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe');
  if (!fs.existsSync(exe)) return t.skip('agent not built');
  const port = 18771;
  const child = spawn(exe, [], {
    stdio: ['pipe', 'ignore', 'ignore', 'ignore'], windowsHide: true,
    env: { ...process.env, IEXA_DESKTOP_PORT: String(port), IEXA_DESKTOP_OWNER_PIPE: 'stdin-v1' },
  });
  t.after(() => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await sleep(100);
  }
  const call = async (payload) => JSON.parse(await (await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })).text());

  const first = await call({ action: 'launch', app: 'C:\\Windows\\System32\\notepad.exe', waitForWindowMs: 20000 });
  assert.equal(first.data?.launched !== false, true, JSON.stringify(first));
  assert.match(first.data?.window?.title || '', /记事本|Notepad/i);
  const handle = first.data?.window?.handle;

  const second = await call({ action: 'launch', app: 'C:\\Windows\\System32\\notepad.exe', waitForWindowMs: 20000 });
  assert.equal(second.data?.reused, true, JSON.stringify(second));
  assert.equal(second.data?.window?.handle, handle, 'reuse binds the same window');
  await call({ action: 'window_command', handle, command: 'close' }).catch(() => {});
});
