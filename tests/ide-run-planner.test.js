'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { make, remove } = require('./helpers/temp-dir');
const { FileWorkspace } = require('../dist/main/ide/FileWorkspace');
const { ProjectRunPlanner, quotePowerShellArgument } = require('../dist/main/ide/ProjectRunPlanner');

function fixture(t, options) {
  const parent = make('iexa-run-plan-'), root = path.join(parent, "中文 project & $ cash's");
  fs.mkdirSync(root); const files = new FileWorkspace(); const project = files.authorize(root);
  const planner = new ProjectRunPlanner(files, options);
  t.after(() => { files.dispose(); remove(parent); });
  const write = (file, content) => { const target = path.join(project.root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target; };
  return { root: project.root, files, project, write, plan: request => planner.plan(project.id, request) };
}
function code(expected) { return error => { assert.equal(error.code, expected); return true; }; }
function runtime(name) {
  const entries = (Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '').split(path.delimiter);
  for (const entry of entries) for (const suffix of process.platform === 'win32' ? ['.exe', ''] : ['']) {
    const file = path.join(entry.replace(/^"|"$/g, ''), name + suffix);
    try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
  }
}
function fakeEnvironments(t) {
  const directory = make('iexa-run-tools-'); t.after(() => remove(directory));
  const tool = name => { const file = path.join(directory, name + (process.platform === 'win32' ? '.exe' : '')); fs.writeFileSync(file, 'test-only-not-executable'); return fs.realpathSync.native(file); };
  const tools = Object.fromEntries(['node', 'python', 'dotnet', 'go', 'cargo', 'cmake', 'ctest', 'powershell', 'pwsh'].map(name => [name, tool(name)]));
  const npm = path.join(directory, 'node_modules/npm/bin/npm-cli.js'); fs.mkdirSync(path.dirname(npm), { recursive: true }); fs.writeFileSync(npm, '// plan-only');
  return { tools, env: { PATH: directory } };
}

test('PowerShell literals preserve Chinese, spaces, ampersands, dollars, backticks and apostrophes', () => {
  assert.equal(quotePowerShellArgument("中文 space & $() ` ' quote"), "'中文 space & $() ` '' quote'");
  assert.throws(() => quotePowerShellArgument('bad\0arg'), code('IDE_RUN_ARGUMENT'));
});

test('plans only authorized existing text files; unknown kind, root, traversal and binary fail explicitly', t => {
  const f = fixture(t, { env: { PATH: '' } });
  f.write('main.py', 'print(1)'); f.write('binary.py', Buffer.from([0, 1, 2])); f.write('notes.md', '# notes');
  assert.throws(() => f.plan({ kind: 'wat' }), code('IDE_RUN_KIND'));
  assert.throws(() => new ProjectRunPlanner(f.files).plan('not-authorized', { kind: 'file', path: 'main.py' }), code('IDE_WORKSPACE'));
  assert.throws(() => f.plan({ kind: 'file', path: '../outside.py' }));
  assert.throws(() => f.plan({ kind: 'file', path: path.join(f.root, 'main.py') }), code('IDE_PATH'));
  assert.throws(() => f.plan({ kind: 'file', path: 'binary.py' }), code('IDE_BINARY'));
  assert.throws(() => f.plan({ kind: 'file', path: 'missing.py' }));
  assert.throws(() => f.plan({ kind: 'file', path: 'notes.md' }), code('IDE_RUN_FILE_TYPE'));
  assert.throws(() => f.plan({ kind: 'file', path: 'main.py' }), code('IDE_RUN_ENVIRONMENT'));
  assert.throws(() => f.plan({ kind: 'file' }), code('IDE_RUN_PATH'));
  assert.throws(() => f.plan({ kind: 'file', path: 'main.py', script: 'ignored' }), code('IDE_RUN_SCRIPT'));
});

test('Node requires a system/configured executable and never falls back to the Electron executable', t => {
  const base = fixture(t, { env: { PATH: '' } }); base.write('main.js', 'console.log(1)');
  assert.throws(() => base.plan({ kind: 'file', path: 'main.js' }), code('IDE_RUN_ENVIRONMENT'));
  const electron = base.write('electron.exe', 'not-node');
  const planner = new ProjectRunPlanner(base.files, { env: { PATH: '', IEXA_NODE_EXECUTABLE: electron } });
  assert.throws(() => planner.plan(base.project.id, { kind: 'file', path: 'main.js' }), code('IDE_RUN_ENVIRONMENT'));
  const node = runtime('node'); assert.ok(node, 'Node available for this Node test suite');
  const configured = new ProjectRunPlanner(base.files, { env: { PATH: '', IEXA_NODE_EXECUTABLE: node } }).plan(base.project.id, { kind: 'file', path: 'main.js' });
  assert.equal(configured.executable, node); assert.equal(configured.cwd, base.root); assert.equal(configured.shell, 'powershell');
});

test('package tasks retain exact script argv and command, require explicit entry and do not start preview', t => {
  const { tools, env } = fakeEnvironments(t), f = fixture(t, { env });
  const name = "build & $literal's";
  f.write('package.json', JSON.stringify({ scripts: { [name]: 'node compile.js --no-web', build: 'node build.js', test: 'node test.js' } }));
  assert.throws(() => f.plan({ kind: 'project' }), code('IDE_RUN_SCRIPT'));
  const plan = f.plan({ kind: 'project', script: name });
  assert.equal(plan.executable, tools.node); assert.equal(plan.args.at(-1), name); assert.equal(plan.scriptCommand, 'node compile.js --no-web');
  assert.equal(plan.script, name); assert.equal(plan.language, 'node'); assert.match(plan.command, /build & \$literal''s/);
  assert.equal(f.plan({ kind: 'build' }).script, 'build'); assert.equal(f.plan({ kind: 'test' }).script, 'test');
  assert.throws(() => f.plan({ kind: 'project', script: 'missing' }), code('IDE_RUN_SCRIPT'));
  assert.throws(() => f.plan({ kind: 'project', script: 'bad\0name' }), code('IDE_RUN_SCRIPT'));
  f.write('package.json', JSON.stringify({ scripts: { dev: 'node server.js' } })); assert.equal(f.plan({ kind: 'project' }).script, 'dev');
  assert.equal(fs.readdirSync(f.root).length, 1, 'planning does not generate outputs or receipts');
});

test('TypeScript uses only the project local tsx runner and gives an environment hint when absent', t => {
  const { env } = fakeEnvironments(t), f = fixture(t, { env }); f.write('src/main.ts', 'console.log(1)');
  assert.throws(() => f.plan({ kind: 'file', path: 'src/main.ts' }), code('IDE_RUN_TYPESCRIPT'));
  const runner = f.write('node_modules/tsx/dist/cli.mjs', '// local runner'), entry = path.join(f.root, 'src/main.ts');
  const plan = f.plan({ kind: 'file', path: 'src/main.ts' }); assert.deepEqual(plan.args, [runner, entry]); assert.equal(plan.language, 'typescript');
});

test('.NET, Go, Rust and CMake project build/test plans use the selected manifests and root cwd', t => {
  const { env } = fakeEnvironments(t), f = fixture(t, { env });
  f.write('nested/app.csproj', '<Project />'); f.write('nested/go.mod', 'module example\n'); f.write('nested/Cargo.toml', '[package]\n'); f.write('nested/CMakeLists.txt', 'project(App)');
  for (const kind of ['project', 'build', 'test']) {
    const dotnet = f.plan({ kind, path: 'nested/app.csproj' }); assert.equal(dotnet.language, 'dotnet'); assert.equal(dotnet.args[0], kind === 'project' ? 'run' : kind); assert.equal(dotnet.cwd, f.root);
    const go = f.plan({ kind, path: 'nested/go.mod' }); assert.deepEqual(go.args.slice(0, 2), ['-C', path.join(f.root, 'nested')]); assert.equal(go.args[2], kind === 'project' ? 'run' : kind);
    const rust = f.plan({ kind, path: 'nested/Cargo.toml' }); assert.deepEqual(rust.args, [kind === 'project' ? 'run' : kind, '--manifest-path', path.join(f.root, 'nested/Cargo.toml')]);
  }
  assert.throws(() => f.plan({ kind: 'project', path: 'nested/CMakeLists.txt' }), code('IDE_RUN_ENTRY'));
  assert.throws(() => f.plan({ kind: 'build', path: 'nested/CMakeLists.txt' }), code('IDE_RUN_CMAKE'));
  fs.mkdirSync(path.join(f.root, 'nested/build'));
  assert.deepEqual(f.plan({ kind: 'build', path: 'nested/CMakeLists.txt' }).args, ['--build', path.join(f.root, 'nested/build')]);
  assert.deepEqual(f.plan({ kind: 'test', path: 'nested/CMakeLists.txt' }).args, ['--test-dir', path.join(f.root, 'nested/build'), '--output-on-failure']);
  f.write('a.csproj', '<Project/>'); f.write('b.csproj', '<Project/>'); assert.throws(() => f.plan({ kind: 'project' }), code('IDE_RUN_ENTRY'));
});

test('Python project entry, explicit pyproject scripts, build and test plans are concrete', t => {
  const { env } = fakeEnvironments(t), f = fixture(t, { env }); f.write('__main__.py', 'print(1)');
  assert.equal(f.plan({ kind: 'project' }).entry, '__main__.py');
  assert.throws(() => f.plan({ kind: 'build' }), code('IDE_RUN_ENTRY'));
  f.write('pyproject.toml', '[project]\nname="demo"\n[project.scripts]\nfirst="demo:main"\nsecond="demo:run"\n[tool.pytest.ini_options]\n');
  fs.unlinkSync(path.join(f.root, '__main__.py')); assert.throws(() => f.plan({ kind: 'project' }), code('IDE_RUN_ENTRY'));
  const plan = f.plan({ kind: 'project', script: 'first' }); assert.equal(plan.args.at(-1), 'demo:main'); assert.equal(plan.script, 'first');
  assert.throws(() => f.plan({ kind: 'build', script: 'first' }), code('IDE_RUN_SCRIPT'));
  assert.deepEqual(f.plan({ kind: 'build' }).args.slice(0, 4), ['-u', '-m', 'build', f.root]);
  assert.deepEqual(f.plan({ kind: 'test' }).args, ['-u', '-m', 'pytest', f.root]);
  f.write('pyproject.toml', '[project.scripts]\nonly = "demo:main"\n'); assert.equal(f.plan({ kind: 'project' }).script, 'only');
  f.write('pyproject.toml', '[project]\nname="demo"\n'); assert.deepEqual(f.plan({ kind: 'test' }).args, ['-u', '-m', 'unittest', 'discover', '-s', f.root]);
});

test('Python prefers an existing project virtual environment and Go/PS1 files are concrete argv', t => {
  const { tools, env } = fakeEnvironments(t), f = fixture(t, { env }); f.write('hello.py', 'print(1)');
  const venv = f.write(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', 'test-only');
  assert.equal(f.plan({ kind: 'file', path: 'hello.py' }).executable, venv);
  const go = f.write('hello.go', 'package main'); assert.deepEqual(f.plan({ kind: 'file', path: 'hello.go' }).args, ['run', go]);
  const ps = f.write('hello.ps1', 'Write-Output 1'); const plan = f.plan({ kind: 'file', path: 'hello.ps1' });
  assert.deepEqual(plan.args, ['-NoProfile', '-File', ps]); assert.equal(plan.executable, process.platform === 'win32' ? tools.powershell : tools.pwsh);
});

test('plain Python projects use the explicit root main.py convention without guessing arbitrary files or tasks', t => {
  const { env } = fakeEnvironments(t), f = fixture(t, { env }); f.write('main.py', "print('entry')");
  const plan = f.plan({ kind: 'project' }); assert.equal(plan.language, 'python'); assert.equal(plan.entry, 'main.py'); assert.deepEqual(plan.args, ['-u', path.join(f.root, 'main.py')]);
  assert.throws(() => f.plan({ kind: 'build' }), code('IDE_RUN_ENTRY')); assert.throws(() => f.plan({ kind: 'test' }), code('IDE_RUN_ENTRY'));
  fs.unlinkSync(path.join(f.root, 'main.py')); f.write('arbitrary.py', 'print(1)'); assert.throws(() => f.plan({ kind: 'project' }), code('IDE_RUN_ENTRY'));
  f.write('main.py', 'print(1)'); f.write('pyproject.toml', '[project]\nname="entry-required"'); assert.throws(() => f.plan({ kind: 'project' }), code('IDE_RUN_ENTRY'));
});

test('real Node structured argv prints stdout/stderr and preserves exit9 under a special-character root', t => {
  const f = fixture(t), entry = "folder & $()/hello's.js";
  f.write(entry, "console.log('IEXA_NODE_RECEIPT:' + process.cwd()); console.error('IEXA_NODE_FAILURE'); process.exit(9);");
  const plan = f.plan({ kind: 'file', path: entry }), result = spawnSync(plan.executable, plan.args, { cwd: plan.cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.status, 9); assert.match(result.stdout, /IEXA_NODE_RECEIPT:/); assert.ok(result.stdout.includes(f.root)); assert.match(result.stderr, /IEXA_NODE_FAILURE/);
});

test('real Python structured argv and pyproject callable preserve stdout and nonzero exit', t => {
  const python = runtime('python') || runtime('python3'); if (!python) return t.skip('Python not installed');
  const f = fixture(t, { env: { ...process.env, IEXA_PYTHON_EXECUTABLE: python } });
  f.write("folder & $()/hello's.py", "import os,sys\nprint('IEXA_PYTHON_RECEIPT', flush=True)\nprint('IEXA_PYTHON_FAILURE',file=sys.stderr)\nsys.exit(7)\n");
  const plan = f.plan({ kind: 'file', path: "folder & $()/hello's.py" }), result = spawnSync(plan.executable, plan.args, { cwd: plan.cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.status, 7); assert.match(result.stdout, /IEXA_PYTHON_RECEIPT/); assert.match(result.stderr, /IEXA_PYTHON_FAILURE/);
  f.write('nested/pyproject.toml', '[project.scripts]\nhello = "receipt:main"\n');
  f.write('nested/receipt.py', "def main():\n print('IEXA_CALLABLE_RECEIPT')\n return 3\n");
  const project = f.plan({ kind: 'project', path: 'nested/pyproject.toml' }), call = spawnSync(project.executable, project.args, { cwd: project.cwd, encoding: 'utf8' });
  assert.equal(call.status, 3, call.stderr); assert.match(call.stdout, /IEXA_CALLABLE_RECEIPT/);
});

test('real PowerShell executes literal Node/Python arguments and reports actual exit markers without injection', t => {
  const powershell = runtime('powershell') || runtime('pwsh'); if (!powershell) return t.skip('PowerShell not installed');
  const f = fixture(t), nodeEntry = "folder & $()/hello's.js";
  f.write(nodeEntry, "console.log('IEXA_LITERAL_NODE_RECEIPT'); process.exit(9)");
  const python = runtime('python') || runtime('python3');
  const plans = [f.plan({ kind: 'file', path: nodeEntry })];
  if (python) {
    f.write("folder & $()/hello's.py", "import sys\nprint('IEXA_LITERAL_PYTHON_RECEIPT')\nsys.exit(7)\n");
    const planner = new ProjectRunPlanner(f.files, { env: { ...process.env, IEXA_PYTHON_EXECUTABLE: python } });
    plans.push(planner.plan(f.project.id, { kind: 'file', path: "folder & $()/hello's.py" }));
    f.write('nested/pyproject.toml', '[project.scripts]\nhello = "receipt:main"\n'); f.write('nested/receipt.py', "def main():\n print('IEXA_LITERAL_CALLABLE_RECEIPT')\n return 3\n");
    plans.push(planner.plan(f.project.id, { kind: 'project', path: 'nested/pyproject.toml' }));
  }
  for (const plan of plans) {
    const encoded = Buffer.from(plan.command + '; exit $LASTEXITCODE', 'utf16le').toString('base64');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 20000 });
    const expected = plan.language === 'javascript' ? 9 : plan.kind === 'project' ? 3 : 7;
    assert.equal(result.error, undefined); assert.equal(result.status, expected, result.stdout + result.stderr); assert.match(result.stdout, new RegExp('IEXA_IDE_EXIT_CODE=' + expected)); assert.match(result.stdout, /IEXA_LITERAL_/);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'injected')), false);
});

test('real npm finite build/test scripts run through Node argv and preserve failure', t => {
  const f = fixture(t); f.write('package.json', JSON.stringify({ scripts: { build: 'node build.js', test: 'node fail.js' } }));
  f.write('build.js', "console.log('IEXA_NPM_BUILD_RECEIPT')"); f.write('fail.js', "console.error('IEXA_NPM_TEST_FAILURE'); process.exit(5)");
  for (const kind of ['build', 'test']) {
    const plan = f.plan({ kind }), result = spawnSync(plan.executable, plan.args, { cwd: plan.cwd, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.error, undefined); assert.equal(result.status, kind === 'build' ? 0 : 5, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, kind === 'build' ? /IEXA_NPM_BUILD_RECEIPT/ : /IEXA_NPM_TEST_FAILURE/);
  }
});

test('real PowerShell reports exit1 if the planned executable disappears and preserves the native error policy exit', t => {
  const powershell = runtime('powershell') || runtime('pwsh'); if (!powershell) return t.skip('PowerShell not installed');
  const f = fixture(t), fakeNode = f.write('fake-node.exe', 'test-only'); f.write('main.js', "console.log('must not run')");
  const planner = new ProjectRunPlanner(f.files, { env: { PATH: '', IEXA_NODE_EXECUTABLE: fakeNode } });
  const plan = planner.plan(f.project.id, { kind: 'file', path: 'main.js' }); fs.unlinkSync(fakeNode);
  const encoded = Buffer.from(plan.command + '; exit $LASTEXITCODE', 'utf16le').toString('base64');
  const failed = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 20000 });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr); assert.match(failed.stdout, /IEXA_IDE_EXIT_CODE=1/); assert.doesNotMatch(failed.stdout, /must not run/);
  const pwsh = runtime('pwsh'); if (!pwsh) return;
  f.write('fail.js', 'process.exit(9)'); const native = f.plan({ kind: 'file', path: 'fail.js' });
  const enabled = Buffer.from("$PSNativeCommandUseErrorActionPreference=$true; $ErrorActionPreference='Stop'; " + native.command + '; exit $LASTEXITCODE', 'utf16le').toString('base64');
  const actual = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enabled], { encoding: 'utf8', timeout: 20000 });
  assert.equal(actual.status, 9, actual.stdout + actual.stderr); assert.match(actual.stdout, /IEXA_IDE_EXIT_CODE=9/);
});
