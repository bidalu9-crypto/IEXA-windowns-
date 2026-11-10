'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { make, remove } = require('./helpers/temp-dir');
const { FileWorkspace } = require('../dist/main/ide/FileWorkspace');
const { CodeFormatter, IDEFormatError, BUNDLED_RUFF_VERSION } = require('../dist/main/ide/CodeFormatter');

const bundled = path.resolve(__dirname, '../resources/formatters', process.platform === 'win32' ? 'ruff.exe' : 'ruff');
const ruff = process.env.IEXA_TEST_RUFF_EXECUTABLE || (fs.existsSync(bundled) ? bundled : undefined);
function findPython() {
  for (const name of ['python', 'python3', ...(process.platform === 'win32' ? ['py'] : [])]) {
    const prefix = name === 'py' ? ['-3'] : [];
    const result = spawnSync(name, [...prefix, '-I', '-B', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', timeout: 2500, windowsHide: true });
    if (result.status === 0) return { executable: result.stdout.trim(), prefix: [] };
  }
}
const python = findPython();
const blackPython = process.env.IEXA_TEST_BLACK_PYTHON;
function fixture(t, options = {}) {
  const directory = make('iexa-formatter-'), root = path.join(directory, "中文 project & $ user's");
  fs.mkdirSync(root);
  const files = new FileWorkspace(), project = files.authorize(root);
  const sourcePath = path.join(root, 'long code.py'), diskContent = 'print("disk content stays unchanged")\n';
  fs.writeFileSync(sourcePath, diskContent);
  const formatter = new CodeFormatter(files, { bundledRuffPath: ruff || null, env: { PATH: '', IEXA_PYTHON_EXECUTABLE: undefined, IEXA_RUFF_EXECUTABLE: undefined }, ...options });
  t.after(() => { files.dispose(); remove(directory); });
  return { root, files, project, formatter, sourcePath, diskContent, format: (content, extra = {}) => formatter.format(project.id, 'long code.py', content, { modelVersion: 7, ...extra }) };
}
function code(expected) { return error => { assert.equal(error.code, expected); return true; }; }
function pythonRun(script, input) {
  assert.ok(python, 'Python required for AST and actual-execution acceptance');
  const result = spawnSync(python.executable, ['-I', '-B', '-X', 'utf8', '-c', script], { input: JSON.stringify(input), encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function longProgram() {
  const lines = [
    'import json', 'from functools import wraps', '',
    'def tagged(fn):', '  @wraps(fn)', '  def wrapped(*args,**kwargs):', '    return fn(*args, **kwargs)', '  return wrapped', '',
    'TEXT = """first line', '    indentation inside a multiline string stays meaningful', '\tactual tab in text', '        final indented line', '"""', '',
    'class Box:', '  def __init__(self, value):', '    self.value=value', '  def resolve(self):', '    def nested(multiplier):', '      return self.value*multiplier', '    return nested(2)', '',
  ];
  for (let index = 0; index < 110; index++) lines.push(
    '@tagged', `def calc_${index}(value: int):`, '  total=0', '  settings={', '      "weights":[1,2,3,4],', '      "label":"a long Unicode 中文 string that must survive formatting exactly without whitespace damage",', '  }',
    '  for offset, weight in enumerate(settings["weights"]):', '    if offset%2==0:', '      total += (', '          value*weight', '          +offset', '      )', '    else:', '      try:', '        total += value//weight', '      except ZeroDivisionError:', '        total += 0',
    '  pairs=[(number,number*number) for number in range(4) if number>=0]', '  return total + sum(pair[1] for pair in pairs)', '',
  );
  lines.push('if __name__=="__main__":', `  print(json.dumps({"total":sum([${Array.from({ length: 110 }, (_, i) => `calc_${i}(${i})`).join(',')}]),"text":TEXT,"box":Box(21).resolve()},ensure_ascii=False,sort_keys=True))`, '');
  // Mixed physical line endings, including within the triple-quoted string.
  return lines.map((line, index) => line + (index % 3 === 0 ? '\r\n' : '\n')).join('');
}

test('formatter authorizes paths and validates language, version, limits and options before spawning', async t => {
  const f = fixture(t, { bundledRuffPath: null });
  await assert.rejects(() => f.formatter.format('unknown', 'long code.py', 'x=1', { modelVersion: 1 }), code('IDE_WORKSPACE'));
  await assert.rejects(() => f.formatter.format(f.project.id, '../outside.py', 'x=1', { modelVersion: 1 }));
  await assert.rejects(() => f.formatter.format(f.project.id, f.sourcePath, 'x=1', { modelVersion: 1 }), code('IDE_PATH'));
  await assert.rejects(() => f.formatter.format(f.project.id, 'notes.txt', 'x=1', { modelVersion: 1 }), code('IDE_FORMAT_LANGUAGE'));
  await assert.rejects(() => f.format('x=1', { modelVersion: 0 }), code('IDE_FORMAT_VERSION'));
  await assert.rejects(() => f.format('x=1', { modelVersion: 1.5 }), code('IDE_FORMAT_VERSION'));
  await assert.rejects(() => f.format('\0'), code('IDE_FORMAT_SIZE'));
  await assert.rejects(() => f.format('x'.repeat(4 * 1024 * 1024 + 1)), code('IDE_FORMAT_SIZE'));
  await assert.rejects(() => f.format('x=1', { lineLength: 0 }), code('IDE_FORMAT_OPTIONS'));
  await assert.rejects(() => f.format('x=1', { timeoutMs: 60000 }), code('IDE_FORMAT_OPTIONS'));
});

test('missing formatter reports an actionable environment error and leaves the file intact', async t => {
  const f = fixture(t, { bundledRuffPath: null });
  await assert.rejects(() => f.format('x=1'), error => {
    assert.ok(error instanceof IDEFormatError);
    assert.equal(error.code, 'IDE_FORMAT_ENVIRONMENT');
    assert.match(error.message, /python -m pip install ruff/);
    assert.deepEqual(error.diagnostics, []);
    return true;
  });
  assert.equal(fs.readFileSync(f.sourcePath, 'utf8'), f.diskContent);
});

test('bundled Ruff has a pinned version, executable hash and retained upstream MIT license', { skip: !fs.existsSync(bundled) }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(bundled), 'manifest.json'), 'utf8'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(manifest.version, BUNDLED_RUFF_VERSION);
  assert.equal(hash(bundled), manifest.executable.sha256);
  assert.equal(hash(path.join(path.dirname(bundled), manifest.license.path)), manifest.license.sha256);
  assert.match(fs.readFileSync(path.join(path.dirname(bundled), manifest.license.path), 'utf8'), /MIT License/);
  assert.match(manifest.wheel.url, /^https:\/\/files\.pythonhosted\.org\//);
});

test('long Python formats nested scopes, decorators and mixed EOLs; AST and execution are identical and output is idempotent', { skip: !ruff || !python, timeout: 20000 }, async t => {
  const f = fixture(t), original = longProgram();
  assert.ok(original.split('\n').length > 2000);
  const started = performance.now();
  const formatted = await f.format(original);
  assert.equal(formatted.modelVersion, 7);
  assert.equal(formatted.workspaceId, f.project.id);
  assert.equal(formatted.path, 'long code.py');
  assert.equal(formatted.inputHash, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(formatted.changed, true);
  assert.equal(formatted.formatter.name, 'ruff');
  assert.equal(formatted.formatter.version, BUNDLED_RUFF_VERSION);
  assert.deepEqual(formatted.diagnostics, []);
  assert.match(formatted.content, /def calc_0\(value: int\):\r?\n {4}total = 0/);
  const comparison = pythonRun(`import ast,sys,json,contextlib,io
data=json.load(sys.stdin)
def run(source):
 stream=io.StringIO()
 with contextlib.redirect_stdout(stream):
  exec(compile(source,'<formatter-test>','exec'),{'__name__':'__main__'})
 return stream.getvalue()
print(json.dumps({'astEqual':ast.dump(ast.parse(data[0]))==ast.dump(ast.parse(data[1])),'before':run(data[0]),'after':run(data[1])}))`, [original, formatted.content]);
  assert.equal(comparison.astEqual, true, 'syntax tree must retain semantics and multiline string contents');
  assert.equal(comparison.after, comparison.before, 'actual Python execution output is unchanged');
  const again = await f.format(formatted.content, { modelVersion: 8 });
  assert.equal(again.content, formatted.content);
  assert.equal(again.changed, false);
  assert.equal(again.modelVersion, 8);
  assert.equal(fs.readFileSync(f.sourcePath, 'utf8'), f.diskContent, 'unsaved input never replaces the disk version');
  assert.deepEqual(fs.readdirSync(f.root), ['long code.py'], 'no source temp file, .ruff_cache or __pycache__');
  t.diagnostic(JSON.stringify({ inputLines: original.split('\n').length, inputBytes: Buffer.byteLength(original), outputBytes: Buffer.byteLength(formatted.content), durationMs: Math.round(performance.now() - started), astEqual: comparison.astEqual, executionEqual: comparison.after === comparison.before }));
});

test('invalid indentation and syntax give precise diagnostics without changing source or returning fake success', { skip: !ruff }, async t => {
  const f = fixture(t);
  for (const [source, expectedLine] of [['def bad():\n    print(1)\n   print(2)\n', 3], ['def missing_colon()\n    return 1\n', 1]]) {
    await assert.rejects(() => f.format(source), error => {
      assert.equal(error.code, 'IDE_FORMAT_SYNTAX');
      assert.equal(error.diagnostics.length, 1);
      assert.equal(error.diagnostics[0].line, expectedLine);
      assert.ok(error.diagnostics[0].column >= 1);
      assert.equal(error.diagnostics[0].severity, 'error');
      assert.equal(Object.hasOwn(error, 'content'), false);
      return true;
    });
  }
  assert.equal(fs.readFileSync(f.sourcePath, 'utf8'), f.diskContent);
});

test('formatting legal tabs preserves multiline literal contents and never executes user code', { skip: !ruff || !python }, async t => {
  const f = fixture(t), sideEffect = path.join(f.root, 'SHOULD_NOT_EXIST');
  const input = `def tabbed():\n\tvalue=1\n\treturn value\ntext = r'''    keep  spaces\n\tkeep tab and \\slashes\n'''\nopen(${JSON.stringify(sideEffect)},'w').write('executed')\n`;
  const formatted = await f.format(input);
  assert.equal(pythonRun('import ast,sys,json\na,b=json.load(sys.stdin)\nprint(json.dumps(ast.dump(ast.parse(a))==ast.dump(ast.parse(b))))', [input, formatted.content]), true);
  assert.equal(fs.existsSync(sideEffect), false);
});

test('project virtualenv Ruff takes precedence over the bundled fallback and respects project config', { skip: !ruff }, async t => {
  const f = fixture(t);
  const bin = path.join(f.root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const localRuff = path.join(bin, process.platform === 'win32' ? 'ruff.exe' : 'ruff');
  fs.copyFileSync(ruff, localRuff);
  if (process.platform !== 'win32') fs.chmodSync(localRuff, 0o755);
  fs.writeFileSync(path.join(f.root, 'pyproject.toml'), '[tool.ruff]\nline-length = 48\n[tool.ruff.format]\nquote-style = "single"\n');
  const formatted = await f.format('message="hello"\n');
  assert.equal(formatted.formatter.source, 'project');
  assert.match(formatted.content, /message = 'hello'/);
  assert.equal(fs.existsSync(path.join(f.root, '.ruff_cache')), false);
});

test('cancellation and deadline failures are bounded, return no replacement, and subsequent formats still work', { skip: !ruff, timeout: 10000 }, async t => {
  const f = fixture(t), pre = new AbortController();
  pre.abort();
  await assert.rejects(() => f.format('x=1', { signal: pre.signal }), code('IDE_FORMAT_CANCELLED'));
  const active = new AbortController(), started = performance.now();
  const cancelled = f.format(longProgram(), { signal: active.signal });
  active.abort();
  await assert.rejects(() => cancelled, code('IDE_FORMAT_CANCELLED'));
  assert.ok(performance.now() - started < 2000, 'abort must settle promptly including process cleanup');
  await assert.rejects(() => f.format(longProgram(), { timeoutMs: 1 }), code('IDE_FORMAT_TIMEOUT'));
  const retry = await f.format('x=1\n');
  assert.equal(retry.content.trim(), 'x = 1');
  assert.equal(fs.readFileSync(f.sourcePath, 'utf8'), f.diskContent);
});

test('cancelling a large live formatting process settles promptly and preserves the on-disk source', { skip: !ruff, timeout: 10000 }, async t => {
  const f = fixture(t), controller = new AbortController();
  const source = 'values=[]\n' + Array.from({ length: 40000 }, (_, index) => `values.append({"index":${index},"data":[1,2,3,4,5,6,7,8]})\n`).join('');
  assert.ok(Buffer.byteLength(source) < 4 * 1024 * 1024);
  const started = performance.now();
  const pending = f.format(source, { signal: controller.signal });
  const abortTimer = setTimeout(() => controller.abort(), 120);
  try { await assert.rejects(() => pending, code('IDE_FORMAT_CANCELLED')); }
  finally { clearTimeout(abortTimer); }
  assert.ok(performance.now() - started < 2000);
  assert.equal(fs.readFileSync(f.sourcePath, 'utf8'), f.diskContent);
  assert.deepEqual(fs.readdirSync(f.root), ['long code.py']);
});

test('concurrent work is bounded and every returned edit retains its own input version and hash', { skip: !ruff }, async t => {
  const f = fixture(t);
  const first = f.format('first=1\n', { modelVersion: 11 });
  const second = f.format('second=2\n', { modelVersion: 12 });
  await assert.rejects(() => f.format('third=3\n', { modelVersion: 13 }), code('IDE_FORMAT_BUSY'));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.modelVersion), [11, 12]);
  assert.notEqual(results[0].inputHash, results[1].inputHash);
});

test('optional Black Python environment preserves Unicode, avoids project module shadowing and returns parser indentation ranges', { skip: !blackPython }, async t => {
  const f = fixture(t, { bundledRuffPath: null, env: { PATH: '', IEXA_RUFF_EXECUTABLE: undefined, IEXA_PYTHON_EXECUTABLE: blackPython } });
  fs.writeFileSync(path.join(f.root, 'black.py'), "raise RuntimeError('project module must never run')\n");
  fs.writeFileSync(path.join(f.root, 'ruff.py'), "raise RuntimeError('project module must never run')\n");
  const result = await f.format('message="中文 Unicode"\n');
  assert.equal(result.formatter.name, 'black');
  assert.equal(result.formatter.source, 'system');
  assert.match(result.content, /message = "中文 Unicode"/);
  await assert.rejects(() => f.format('def bad():\n    print(1)\n   print(2)\n'), error => {
    assert.equal(error.code, 'IDE_FORMAT_SYNTAX');
    assert.equal(error.diagnostics[0].line, 3);
    assert.equal(error.diagnostics[0].column, 12, 'actual CPython IndentationError offset');
    return true;
  });
  assert.equal(fs.readFileSync(f.sourcePath, 'utf8'), f.diskContent);
  assert.equal(fs.existsSync(path.join(f.root, '__pycache__')), false);
});
