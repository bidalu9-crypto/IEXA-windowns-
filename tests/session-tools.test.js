const test = require('node:test');
const assert = require('node:assert/strict');
const { ShellSessionTools, stripTerminalControl, parseSessionOutput, stripCommandEcho } = require('../dist/main/tools/ShellSessionTools');

test('terminal control is stripped without losing text', () => {
  const raw = '\u001b[2J\u001b[H\u001b]0;C:\\windows\\SYSTEM32\\cmd.exe\u0007hello\u001b[41X\r\nsecond';
  assert.equal(stripTerminalControl(raw), 'hello\r\nsecond');
});

test('marker parsing ignores the echoed control line and reads the exit code', () => {
  const raw = [
    'E:\\work>echo __IEXA_BEGIN_abc__',
    '__IEXA_BEGIN_abc__',
    'E:\\work>echo hello',
    'hello',
    'E:\\work>echo __IEXA_END_abc__%ERRORLEVEL%',
    '__IEXA_END_abc__0',
    '',
    'E:\\work>',
  ].join('\r\n');
  const parsed = parseSessionOutput(raw, '__IEXA_BEGIN_abc__', '__IEXA_END_abc__');
  assert.equal(parsed.found, true);
  assert.equal(parsed.exitCode, 0);
  assert.deepEqual(parsed.lines.slice(0, 3), ['E:\\work>echo hello', 'hello', 'E:\\work>echo __IEXA_END_abc__%ERRORLEVEL%']);
});

test('the echoed command is removed even when the prompt is glued to it', () => {
  assert.deepEqual(stripCommandEcho(['E:\\work>echo a', 'b', 'c'], 'echo a'), ['b', 'c']);
  assert.deepEqual(stripCommandEcho(['PS E:\\work> write-host one', 'write-host two', 'one', 'two'], 'write-host one\nwrite-host two'), ['one', 'two']);
  // Output that merely mentions the command later must survive.
  assert.deepEqual(stripCommandEcho(['E:\\work>echo a', 'echo a', 'tail'], 'echo a'), ['echo a', 'tail']);
});

test('a real cmd session keeps cwd, strips framing and reports exit codes', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {  const tools = new ShellSessionTools(process.cwd());
  let id;
  try {
    const opened = await tools.execute('open', { shell: 'cmd' }, 'owner-a', undefined, process.cwd());
    assert.equal(opened.success, true, opened.output);
    id = opened.metadata.sessionId;
    assert.ok(id);

    const cd = await tools.execute('send', { session_id: id, command: 'cd /d "%TEMP%"' }, 'owner-a');
    assert.equal(cd.success, true, cd.output);

    const pwd = await tools.execute('send', { session_id: id, command: 'cd' }, 'owner-a');
    assert.equal(pwd.success, true, pwd.output);
    assert.match(pwd.output, /temp/i);
    assert.doesNotMatch(pwd.output, /__IEXA_/);
    assert.doesNotMatch(pwd.output, /%TEMP%/);

    const failed = await tools.execute('send', { session_id: id, command: 'cmd /c exit 3' }, 'owner-a');
    assert.equal(failed.metadata.exitCode, 3, failed.output);
    assert.equal(failed.success, false);

    const foreign = await tools.execute('read', { session_id: id }, 'owner-b');
    assert.equal(foreign.success, false);
    assert.match(foreign.output, /另一个对话/);
  } finally {
    if (id) await tools.execute('close', { session_id: id }, 'owner-a').catch(() => {});
    tools.shutdownSync();
  }
});

test('a real powershell session keeps location and reports native exit codes', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const tools = new ShellSessionTools(process.cwd());
  let id;
  try {
    const opened = await tools.execute('open', { shell: 'powershell' }, 'owner-pwsh', undefined, process.cwd());
    assert.equal(opened.success, true, opened.output);
    id = opened.metadata.sessionId;

    const moved = await tools.execute('send', { session_id: id, command: 'Set-Location $env:TEMP' }, 'owner-pwsh');
    assert.equal(moved.success, true, moved.output);

    const where = await tools.execute('send', { session_id: id, command: 'Get-Location' }, 'owner-pwsh');
    assert.equal(where.success, true, where.output);
    assert.match(where.output, /temp/i);
    assert.doesNotMatch(where.output, /__IEXA_/);
    assert.doesNotMatch(where.output, /Write-Output/);

    const failed = await tools.execute('send', { session_id: id, command: 'cmd /c exit 7' }, 'owner-pwsh');
    assert.equal(failed.metadata.exitCode, 7, failed.output);
    assert.equal(failed.success, false);
  } finally {
    if (id) await tools.execute('close', { session_id: id }, 'owner-pwsh').catch(() => {});
    tools.shutdownSync();
  }
});

test('the task center sees only its own shells and can close one by id', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const tools = new ShellSessionTools(process.cwd());
  let id;
  try {
    assert.deepEqual(tools.summaries('owner-a'), []);
    const opened = await tools.execute('open', { shell: 'cmd' }, 'owner-a', undefined, process.cwd());
    assert.equal(opened.success, true, opened.output);
    id = opened.metadata.sessionId;

    const mine = tools.summaries('owner-a');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, id);
    assert.equal(mine[0].shell, 'cmd');
    assert.equal(mine[0].running, true);
    assert.equal(typeof mine[0].createdAt, 'number');
    // A summary is a projection, not the tty buffer.
    assert.equal(Object.prototype.hasOwnProperty.call(mine[0], 'cursor'), false);
    assert.deepEqual(tools.summaries('owner-b'), [], 'another conversation must not enumerate this shell');

    const closed = await tools.close(id, 'owner-a');
    assert.equal(closed.success, true, closed.output);
    id = undefined;
    assert.deepEqual(tools.summaries('owner-a'), []);
  } finally {
    if (id) await tools.execute('close', { session_id: id }, 'owner-a').catch(() => {});
    tools.shutdownSync();
  }
});

