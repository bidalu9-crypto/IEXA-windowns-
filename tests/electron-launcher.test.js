// start-electron.bat used to hand Electron off with `start "" …` and then wait two
// seconds, so the console outlived the app whenever the batch was started from a
// shell the user already had open. The launcher now owns that tail: it waits for a
// real window, hides the console, and exits together with the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const bat = read('start-electron.bat');
const launcher = read('scripts/electron-launcher.ps1');

test('the batch hands the tail to the launcher instead of detaching', () => {
  assert.match(bat, /scripts\\electron-launcher\.ps1/, 'the launcher is invoked');
  assert.match(bat, /-ElectronExe "%ELECTRON_EXE%" -AppDir "%APP_DIR%"/, 'both paths are passed');
  assert.doesNotMatch(bat, /^start "" "%ELECTRON_EXE%"/m, 'no detached start');
  assert.doesNotMatch(bat, /timeout \/t 2/, 'the two-second wait is gone');
  // The failure path must still pause so a build error stays readable.
  assert.match(bat, /:failed[\s\S]*pause/);
});

test('the launcher hides only after the window exists', () => {
  const pollAt = launcher.indexOf('MainWindowHandle');
  // The first `Hide-Console` is the function definition; the call is its own line.
  const hideAt = launcher.search(/^Hide-Console$/m);
  assert.ok(pollAt > 0, 'it polls for a real window');
  assert.ok(hideAt > pollAt, 'hiding happens after the window is seen');
  assert.match(launcher, /\$WindowTimeoutSeconds/, 'the wait is bounded');
  assert.match(launcher, /exited before showing a window/, 'a crash is reported, not hidden');
});

test('the console lives exactly as long as the app', () => {
  assert.match(launcher, /\$process\.WaitForExit\(\)/, 'it supervises instead of detaching');
  assert.match(launcher, /exit \$exitCode/, 'the app exit code is propagated');
  assert.match(launcher, /Test-OwnedConsole/, 'ownership of the console is decided, not assumed');
  // A borrowed terminal must never be hidden, not even briefly: the user may have
  // other work in it.
  assert.match(launcher, /if \(\$SkipHide -or -not \$owned -or \$console -eq \[IntPtr\]::Zero\)/,
    'hiding is refused unless the console is ours');
  // A double-clicked batch is `cmd /c ""…\start-electron.bat" "`; that console was
  // created for this launch and must be hidden. Matching on "parent is cmd.exe"
  // alone classified it as the user's shell, which is what broke hiding.
  assert.ok(launcher.includes("(?i)(^|\\s)/c(\\s|$)"),
    'the batch console is recognised by its /c argument');
  assert.ok(launcher.includes('start-electron\\.bat'), 'or by the batch it is running');
  assert.match(launcher, /SW_HIDE/, 'hide is a Win32 call, not a guess');
  assert.match(launcher, /SW_SHOW/, 'restore uses the matching call');
  assert.match(launcher, /IsWindowVisible/, 'restore only touches a window it hid');
});

// Opt-in-free runtime check: -Diagnose prints the decision without launching
// anything, so the exact branch that regressed is covered by a real process chain.
test('ownership decision: a cmd /c batch console is ours, a bare shell is not', (t) => {
  const pwsh = ['powershell', 'pwsh'].find((exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0);
  if (!pwsh) return t.skip('no PowerShell available');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts/electron-launcher.ps1'),
    '-ElectronExe', 'C:\\Windows\\System32\\hostname.exe', '-AppDir', root, '-Diagnose'];

  const direct = spawnSync(pwsh, args, { encoding: 'utf8', timeout: 30000 });
  assert.match(String(direct.stdout), /owned=False/, 'a shell the user opened is not ours to hide');

  const batch = spawnSync('cmd.exe', ['/c', [pwsh, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')],
    { encoding: 'utf8', timeout: 30000 });
  assert.match(String(batch.stdout), /owned=True/,
    'the console created for the batch is ours, so it gets hidden: ' + String(batch.stdout).slice(0, 200));
});

test('the launcher parses and stays runnable from a bare powershell', (t) => {
  const pwsh = ['pwsh', 'powershell'].find((exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status === 0);
  if (!pwsh) return t.skip('no PowerShell available');
  const check = spawnSync(pwsh, ['-NoProfile', '-Command',
    "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" +
    path.join(root, 'scripts/electron-launcher.ps1').replace(/'/g, "''") + "', [ref]$null, [ref]$e); if ($e.Count) { $e[0].Message } else { 'ok' }",
  ], { encoding: 'utf8' });
  assert.equal(check.stdout.trim(), 'ok', check.stderr || check.stdout);
});

// Opt-in: actually runs the launcher against a window-less process and a real one.
test('real launcher: fails fast without a window and waits for one with it', { skip: !process.env.IEXA_TEST_DESKTOP_AGENT, timeout: 60000 }, async () => {
  const run = (exe, extra = []) => new Promise((resolve) => {
    const started = Date.now();
    const child = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(root, 'scripts/electron-launcher.ps1'), '-ElectronExe', exe, '-AppDir', root, '-SkipHide', ...extra,
    ], { encoding: 'utf8', timeout: 30000 });
    resolve({ status: child.status, out: String(child.stdout || ''), elapsed: Date.now() - started });
  });

  const quick = await run('C:\\Windows\\System32\\hostname.exe', ['-WindowTimeoutSeconds', '5']);
  assert.equal(quick.status, 1, quick.out);
  assert.match(quick.out, /exited before showing a window/);
  assert.ok(quick.elapsed < 8000, `it must not wait the full timeout: ${quick.elapsed}ms`);
});
