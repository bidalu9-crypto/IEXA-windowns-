const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { PathSandbox } = require('../dist/main/security/PathSandbox');
const { NetworkPolicy } = require('../dist/main/security/NetworkPolicy');
const { BudgetManager } = require('../dist/main/runtime/BudgetManager');
const { LoopDetector } = require('../dist/main/runtime/LoopDetector');
const { ProcessManager } = require('../dist/main/tools/shell/ProcessManager');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
const { ArtifactStore } = require('../dist/main/context/ArtifactStore');
const { AgentRuntime } = require('../dist/main/runtime/AgentRuntime');
const { PermissionManager, PermissionBroker } = require('../dist/main/security/PermissionManager');
const { MemoryRetriever } = require('../dist/main/memory/MemoryRetriever');
const { SkillValidator } = require('../dist/main/skills/SkillValidator');
const { SessionManager } = require('../dist/main/session/SessionManager');
const { TraceStore } = require('../dist/main/observability/TraceStore');
const { hasSyncConflict } = require('../dist/main/webdav-sync');
const { ToolScheduler } = require('../dist/main/runtime/ToolScheduler');
const { ContextManager } = require('../dist/main/context/ContextManager');
const { estimateCostUsd } = require('../dist/main/observability/CostTracker');
const { JsonStore } = require('../dist/main/persistence/JsonStore');
const { WebDAVConflictStore } = require('../dist/main/sync/WebDAVConflictStore');
const { GitService } = require('../dist/main/git/GitService');
const { TerminalManager } = require('../dist/main/terminals/TerminalManager');
const { McpManager } = require('../dist/main/mcp/McpManager');
const { OpenAIProvider } = require('../dist/main/providers/OpenAIProvider');
const { FileTools, ShellExecutor } = require('../dist/main/tools/ToolExecutors');
const { SoulStore, parseSoulMarkdown, soulTokenCount, checkSoulBodyLimit, buildSoulPromptSection } = require('../dist/main/agent/SoulStore');
const { PluginManager } = require('../dist/main/plugins/PluginManager');
const { MobileBridgeManager } = require('../dist/main/mobile/MobileBridgeManager');

async function tempWorkspace() { return fs.mkdtemp(path.join(os.tmpdir(), 'iexa-runtime-')); }
const execFileAsync = promisify(execFile);
async function git(cwd, args) { await execFileAsync('git', args, { cwd, windowsHide: true }); }
async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for expected terminal output');
}

test('MobileBridgeManager pairs once, authenticates, changes capability, and revokes sessions', async () => {
  const root = await tempWorkspace();
  const manager = new MobileBridgeManager(root);
  manager.setPort(19840);
  assert.equal(manager.status().enabled, false);
  assert.throws(() => manager.createPairToken('192.168.1.10'), /开启手机桥接/);

  manager.configure({ enabled: true, defaultCapability: 'chat' });
  const pair = manager.createPairToken('192.168.1.10');
  assert.match(pair.url, /^http:\/\/192\.168\.1\.10:19840\/\?pair=/);
  const connected = manager.pair(pair.token, 'Test Phone');
  assert.ok(connected);
  assert.equal(connected.device.capability, 'chat');
  assert.equal(manager.pair(pair.token, 'Replay Phone'), null);
  assert.equal(manager.authenticate(connected.sessionToken)?.name, 'Test Phone');
  assert.equal(manager.setCapability(connected.device.id, 'files')?.capability, 'files');
  assert.equal(manager.authenticate(connected.sessionToken)?.capability, 'files');
  assert.equal(manager.revoke(connected.device.id), true);
  assert.equal(manager.authenticate(connected.sessionToken), null);

  const persisted = JSON.parse(await fs.readFile(path.join(root, '.iexa-mobile-bridge.json'), 'utf8'));
  assert.equal(persisted.enabled, true);
  assert.equal(typeof persisted.secret, 'string');
  assert.equal(persisted.devices.length, 0);
});

test('Windows launchers bootstrap dependencies and keep actionable failures visible', async () => {
  const [serverBat, electronBat, installerBat, dependencyHelper, electronHelper] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'start.bat'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'start-electron.bat'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'build-installer.bat'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'scripts', 'ensure-node-deps.bat'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'scripts', 'ensure-electron-runtime.bat'), 'utf8'),
  ]);

  for (const launcher of [serverBat, electronBat, installerBat]) {
    assert.match(launcher, /ensure-node-deps\.bat/i);
    assert.match(launcher, /if errorlevel 1 goto failed/i);
    assert.match(launcher, /\bpause\b/i);
  }
  assert.match(dependencyHelper, /where node\.exe/i);
  assert.match(dependencyHelper, /where npm\.cmd/i);
  assert.match(dependencyHelper, /NODE_MAJOR% LSS 20/i);
  assert.match(dependencyHelper, /npm\.cmd ci/i);
  assert.match(dependencyHelper, /npm\.cmd install/i);
  assert.match(dependencyHelper, /node_modules\\typescript\\bin\\tsc/i);
  assert.match(electronBat, /ensure-electron-runtime\.bat/i);
  assert.match(installerBat, /ensure-electron-runtime\.bat/i);
  assert.match(electronHelper, /Expand-Archive/i);
  assert.match(electronHelper, /resources\\default_app\.asar/i);
  assert.doesNotMatch(electronBat, /extract_electron\.js/i);
});

test('Electron uses IPv4 loopback for its local health check and window URL', async () => {
  const electronEntry = await fs.readFile(path.join(__dirname, '..', 'electron-entry.js'), 'utf8');
  assert.match(electronEntry, /const LOOPBACK_HOST = '127\.0\.0\.1'/);
  assert.match(electronEntry, /http:\/\/\$\{LOOPBACK_HOST\}:\$\{PORT\}\//);
  assert.match(electronEntry, /mainWindow\.loadURL\(url\)/);
});

test('distribution builder includes the Electron preload bridge', async () => {
  const builder = await fs.readFile(path.join(__dirname, '..', 'build-dist.js'), 'utf8');
  assert.match(builder, /fs\.copyFileSync\(path\.join\(ROOT, 'preload\.js'\), path\.join\(APP, 'preload\.js'\)\)/);
});

test('PathSandbox resolves workspace and explicitly addressed local paths', async () => {
  const root = await tempWorkspace();
  const externalRoot = await tempWorkspace();
  const sandbox = new PathSandbox();
  const inside = await sandbox.resolve('nested/../file.txt', { workspaceDir: root, allowMissing: true });
  assert.equal(path.basename(inside.path), 'file.txt');
  const parentRelative = await sandbox.resolve('../outside.txt', { workspaceDir: root, allowMissing: true });
  assert.equal(parentRelative.path, path.resolve(root, '../outside.txt'));
  const absolute = await sandbox.resolve(path.join(externalRoot, 'external.txt'), { workspaceDir: root, allowMissing: true });
  assert.equal(absolute.path, path.join(externalRoot, 'external.txt'));
  await assert.rejects(() => sandbox.resolve('\\\\server\\share\\secret.txt', { workspaceDir: root, allowMissing: true }), /UNC|设备/);
  await assert.rejects(() => sandbox.resolve('\\\\?\\C:\\secret.txt', { workspaceDir: root, allowMissing: true }), /UNC|设备/);
});

test('NetworkPolicy rejects local and private targets before network I/O', async () => {
  const policy = new NetworkPolicy();
  await assert.rejects(() => policy.assertAllowed('https://127.0.0.1/admin'), /不允许访问/);
  await assert.rejects(() => policy.assertAllowed('https://192.168.1.1'), /不允许访问/);
  await assert.rejects(() => policy.assertAllowed('http://example.com'), /HTTPS/);
});

test('BudgetManager enforces turn and tool limits', () => {
  const budget = new BudgetManager({ maxTurns: 1, maxToolCalls: 1 });
  budget.beginTurn(); budget.recordTool();
  assert.throws(() => budget.beginTurn(), /最大执行轮数/);
  assert.throws(() => budget.recordTool(), /最大工具调用数/);
});

test('BudgetManager defaults support long-running project tasks', () => {
  const budget = new BudgetManager().snapshot();
  assert.equal(budget.maxTurns, 2000);
  assert.equal(budget.maxToolCalls, 5000);
  assert.equal(budget.maxRuntimeMs, 24 * 60 * 60_000);
  assert.equal(budget.maxInputTokens, 10_000_000);
});

test('BudgetManager only enforces cumulative input limit when explicitly configured', () => {
  const defaults = new BudgetManager();
  defaults.recordInputTokens(10_000_001);
  assert.equal(defaults.snapshot().inputTokens, 10_000_001);

  const limited = new BudgetManager({ maxInputTokens: 100 });
  limited.recordInputTokens(60);
  assert.throws(() => limited.recordInputTokens(41), /上下文预算/);
});

test('LoopDetector stops repeated equivalent tool calls', () => {
  const detector = new LoopDetector(2, 8);
  detector.record('file_read', { path: 'a.txt' }); detector.record('file_read', { path: 'a.txt' });
  assert.throws(() => detector.record('file_read', { path: 'a.txt' }), /重复调用/);
});

test('ProcessManager cancellation settles a running shell process', async () => {
  const root = await tempWorkspace();
  const controller = new AbortController();
  const running = new ProcessManager().run('ping -n 6 127.0.0.1 > nul', root, controller.signal, { timeoutMs: 10_000, maxOutputBytes: 1024, killGracePeriodMs: 50 });
  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.success, false);
  assert.match(result.output, /cancelled/i);
});

test('ProcessManager preserves quoted Windows CMD and PowerShell commands', { skip: process.platform !== 'win32' }, async () => {
  const root = await tempWorkspace();
  const policy = { timeoutMs: 10_000, maxOutputBytes: 1024, killGracePeriodMs: 50 };
  const manager = new ProcessManager();
  const signal = new AbortController().signal;
  const windowsDir = process.env.SystemRoot || 'C:\\Windows';

  const cmd = await manager.run(`dir "${windowsDir}" > nul`, root, signal, policy);
  assert.equal(cmd.success, true, cmd.output);

  const powershell = await manager.run(
    `powershell -NoProfile -Command "Write-Output 'powershell-quoted-ok'"`,
    root,
    signal,
    policy,
  );
  assert.equal(powershell.success, true, powershell.output);
  assert.match(powershell.output, /powershell-quoted-ok/);
});

test('ShellExecutor reads UTF-8 PowerShell source without corrupting Chinese text', { skip: process.platform !== 'win32' }, async () => {
  const root = await tempWorkspace();
  const sourcePath = path.join(root, 'utf8-no-bom.py');
  const expected = "print('你好，世界')\n# 中文注释";
  await fs.writeFile(sourcePath, expected, 'utf8');

  const result = await new ShellExecutor(root).execute(
    `powershell -NoProfile -Command "$c = Get-Content -Raw -LiteralPath '${sourcePath.replace(/'/g, "''")}'; $c"`,
    10,
    new AbortController().signal,
  );

  assert.equal(result.success, true, result.output);
  assert.equal(result.output.replace(/\r\n/g, '\n'), expected);
});

test('ProcessManager recovers from a stale ComSpec path', { skip: process.platform !== 'win32' }, async () => {
  const root = await tempWorkspace();
  const previousComSpec = process.env.ComSpec;
  const previousCOMSPEC = process.env.COMSPEC;
  process.env.ComSpec = 'C:\\missing-iexa\\cmd.exe';
  process.env.COMSPEC = 'C:\\missing-iexa\\cmd.exe';
  try {
    const result = await new ProcessManager().run(
      'echo cmd-fallback-ok',
      root,
      new AbortController().signal,
      { timeoutMs: 10_000, maxOutputBytes: 1024, killGracePeriodMs: 50 },
    );
    assert.equal(result.success, true, result.output);
    assert.match(result.output, /cmd-fallback-ok/);
  } finally {
    if (previousComSpec === undefined) delete process.env.ComSpec; else process.env.ComSpec = previousComSpec;
    if (previousCOMSPEC === undefined) delete process.env.COMSPEC; else process.env.COMSPEC = previousCOMSPEC;
  }
});

test('ProcessManager executes every line of a Windows CMD command', { skip: process.platform !== 'win32' }, async () => {
  const root = await tempWorkspace();
  const policy = { timeoutMs: 10_000, maxOutputBytes: 1024, killGracePeriodMs: 50 };
  const manager = new ProcessManager();

  const result = await manager.run(
    'setlocal\r\nset "IEXA_MULTI_LINE=works"\r\necho first:%IEXA_MULTI_LINE%\r\necho second:%IEXA_MULTI_LINE%',
    root,
    new AbortController().signal,
    policy,
  );

  assert.equal(result.success, true, result.output);
  assert.match(result.output, /first:works/);
  assert.match(result.output, /second:works/);
});

test('ProcessManager preserves a multi-line CMD script exit code', { skip: process.platform !== 'win32' }, async () => {
  const root = await tempWorkspace();
  const result = await new ProcessManager().run(
    'echo before-exit\r\nexit /b 23',
    root,
    new AbortController().signal,
    { timeoutMs: 10_000, maxOutputBytes: 1024, killGracePeriodMs: 50 },
  );

  assert.equal(result.success, false);
  assert.equal(result.exitCode, 23);
  assert.match(result.output, /before-exit/);
});

test('ShellExecutor runs a multi-line Python -c body through CMD', { skip: process.platform !== 'win32' }, async () => {
  const root = await tempWorkspace();
  const result = await new ShellExecutor(root).execute(
    'python -c "\nfrom pathlib import Path\nPath(\'inline-python.txt\').write_text(\'created\', encoding=\'utf-8\')\nprint(\'inline-python-ok\')\n"',
    10,
    new AbortController().signal,
  );

  assert.equal(result.success, true, result.output);
  assert.match(result.output, /inline-python-ok/);
  assert.equal(await fs.readFile(path.join(root, 'inline-python.txt'), 'utf8'), 'created');
});

test('GitService returns structured changes, diffs, and staged state', async () => {
  const root = await tempWorkspace();
  const service = new GitService();
  const nonRepository = await service.status(root);
  assert.equal(nonRepository.available, true);
  assert.equal(nonRepository.repository, false);
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'IEXA Test']);
  await git(root, ['config', 'user.email', 'iexa@example.test']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'before\n', 'utf8');
  await git(root, ['add', 'tracked.txt']);
  await git(root, ['-c', 'user.name=IEXA Test', '-c', 'user.email=iexa@example.test', 'commit', '-m', 'baseline']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'after\n', 'utf8');
  await fs.writeFile(path.join(root, 'new.txt'), 'new\n', 'utf8');

  const status = await service.status(root);
  assert.equal(status.repository, true, status.error);
  assert.deepEqual(status.files.map((file) => file.path).sort(), ['new.txt', 'tracked.txt']);
  assert.equal(status.files.find((file) => file.path === 'tracked.txt').workTree, 'M');

  const diff = await service.diff(root, 'tracked.txt');
  assert.match(diff.content, /-before/);
  assert.match(diff.content, /\+after/);

  const branches = await service.branches(root);
  assert.equal(branches.filter((branch) => branch.current).length, 1);
  await service.createBranch(root, 'feature/workbench');
  assert.equal((await service.status(root)).branch, 'feature/workbench');

  await service.stage(root, ['new.txt']);
  const staged = await service.status(root);
  assert.equal(staged.files.find((file) => file.path === 'new.txt').index, 'A');
  await service.unstage(root, ['new.txt']);
  await service.stageAll(root);
  await service.commit(root, 'add workbench fixture');
  const log = await service.log(root);
  assert.equal(log[0].subject, 'add workbench fixture');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'restore me\n', 'utf8');
  await service.restore(root, ['tracked.txt']);
  assert.equal((await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'after\n');
  await assert.rejects(() => service.createBranch(root, '../invalid'), /分支名称无效/);
  await assert.rejects(() => service.diff(root, '../outside.txt'), /超出项目目录/);
});

test('TerminalManager keeps shell state and streams command output', async () => {
  const root = await tempWorkspace();
  const manager = new TerminalManager();
  const shell = process.platform === 'win32' ? 'cmd' : 'bash';
  const session = manager.create(root, shell);
  let after = 0;
  let output = '';
  const read = () => {
    const next = manager.output(session.id, after);
    after = next.lastSeq;
    output += next.chunks.map((chunk) => chunk.text).join('');
  };
  try {
    manager.write(session.id, process.platform === 'win32' ? 'set IEXA_TERMINAL_STATE=alive' : 'export IEXA_TERMINAL_STATE=alive', true);
    manager.write(session.id, process.platform === 'win32' ? 'echo state:%IEXA_TERMINAL_STATE%' : 'echo state:$IEXA_TERMINAL_STATE', true);
    await waitFor(() => { read(); return /state:alive/.test(output); });
    assert.match(output, /state:alive/);
    manager.terminate(session.id);
    await waitFor(() => !manager.output(session.id, after).running);
  } finally {
    manager.terminate(session.id);
  }
});

test('McpManager connects to a stdio server and calls its tools', async () => {
  const root = await tempWorkspace();
  const fixture = path.join(root, 'mcp-fixture.js');
  await fs.writeFile(fixture, `
process.stdin.setEncoding('utf8'); let buffer = '';
process.stdin.on('data', (chunk) => { buffer += chunk; let index; while ((index = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue; const req = JSON.parse(line); if (req.id == null) continue; let result = {}; if (req.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture' }, capabilities: {} }; if (req.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object' } }] }; if (req.method === 'resources/list') result = { resources: [{ uri: 'fixture://note', name: 'Note' }] }; if (req.method === 'resources/read') result = { contents: [{ uri: req.params.uri, text: 'resource-ok' }] }; if (req.method === 'tools/call') result = { content: [{ type: 'text', text: String(req.params.arguments.value) }] }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n'); } });
`, 'utf8');
  const manager = new McpManager(path.join(root, 'mcp.json'));
  const added = manager.add({ name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture], enabled: true });
  const connected = await manager.connect(added.id);
  assert.equal(connected.status, 'connected', connected.error);
  assert.equal(connected.tools[0].name, 'echo');
  assert.equal(connected.resources[0].uri, 'fixture://note');
  const result = await manager.callTool(added.id, 'echo', { value: 'mcp-ok' });
  assert.equal(result.content[0].text, 'mcp-ok');
  const resource = await manager.readResource(added.id, 'fixture://note');
  assert.equal(resource.contents[0].text, 'resource-ok');
  assert.equal(manager.disconnect(added.id).status, 'disconnected');
  manager.remove(added.id);
});

test('PluginManager installs, visualizes, invokes, disables, and removes a real plugin', async () => {
  const root = await tempWorkspace();
  const source = path.join(root, 'source-plugin');
  await fs.mkdir(path.join(source, 'ui'), { recursive: true });
  await fs.writeFile(path.join(source, 'iexa-plugin.json'), JSON.stringify({
    id: 'fixture-plugin', name: 'Fixture Plugin', version: '1.0.0', description: 'Runtime fixture',
    main: 'index.cjs', ui: 'ui/index.html',
    tools: [{ name: 'echo', description: 'Echo input', parameters: { value: { type: 'string', description: 'Value' } }, required: ['value'] }],
  }), 'utf8');
  await fs.writeFile(path.join(source, 'index.cjs'), "module.exports.tools={echo:async(args,ctx)=>({output:`${args.value}|${require('path').basename(ctx.dataDir)}`,success:true})};", 'utf8');
  await fs.writeFile(path.join(source, 'ui', 'index.html'), '<!doctype html><title>Fixture UI</title>', 'utf8');

  const manager = new PluginManager(path.join(root, 'workspace'));
  const installed = manager.install(source);
  assert.equal(installed.enabled, true);
  assert.equal(installed.hasUI, true);
  assert.equal(manager.list().length, 1);
  assert.match(manager.bindings()[0].definition.name, /^plugin_fixture_plugin_[a-f0-9]{6}_echo$/);
  const result = await manager.invoke('fixture-plugin', 'echo', { value: '真实调用' });
  assert.equal(result.success, true, result.output);
  assert.equal(result.output, '真实调用|fixture-plugin');
  assert.equal(manager.resolveUiAsset('fixture-plugin').html, true);
  assert.match(await fs.readFile(manager.resolveUiAsset('fixture-plugin').path, 'utf8'), /Fixture UI/);

  manager.setEnabled('fixture-plugin', false);
  assert.equal(manager.bindings().length, 0);
  assert.equal((await manager.invoke('fixture-plugin', 'echo', { value: 'blocked' })).success, false);
  manager.remove('fixture-plugin');
  assert.equal(manager.list().length, 0);
});

test('ToolRuntime uses registry, sandbox, and artifact storage', async () => {
  const root = await tempWorkspace();
  const externalRoot = await tempWorkspace();
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory') });
  runtime.registerDefaults(); await runtime.initialize();
  const signal = new AbortController().signal;
  const write = await runtime.execute('file_write', { tool_title: 'write', path: 'safe.txt', content: 'hello', create_dirs: false }, { signal, sessionId: 'session_1', toolCallId: 'call_1', workspaceDir: root });
  assert.equal(write.success, true);
  const read = await runtime.execute('file_read', { tool_title: 'read', path: 'safe.txt' }, { signal, sessionId: 'session_1', toolCallId: 'call_2', workspaceDir: root });
  assert.equal(read.success, true); assert.match(read.output, /hello/);
  const externalPath = path.join(externalRoot, 'external.txt');
  const externalWrite = await runtime.execute('file_write', { tool_title: 'write external', path: externalPath, content: 'outside', create_dirs: false }, { signal, sessionId: 'session_1', toolCallId: 'call_3', workspaceDir: root });
  assert.equal(externalWrite.success, true, externalWrite.output);
  const externalRead = await runtime.execute('file_read', { tool_title: 'read external', path: externalPath }, { signal, sessionId: 'session_1', toolCallId: 'call_4', workspaceDir: root });
  assert.equal(externalRead.success, true, externalRead.output); assert.match(externalRead.output, /outside/);
  const externalEdit = await runtime.execute('file_edit', { tool_title: 'edit external', path: externalPath, old_string: 'outside', new_string: 'updated' }, { signal, sessionId: 'session_1', toolCallId: 'call_5', workspaceDir: root });
  assert.equal(externalEdit.success, true, externalEdit.output);
  assert.equal(await fs.readFile(externalPath, 'utf8'), 'updated');
  const shell = await runtime.execute('shell_execute', { tool_title: 'run command', command: 'echo runtime-ok' }, { signal, sessionId: 'session_1', toolCallId: 'call_6', workspaceDir: root });
  assert.equal(shell.success, true); assert.match(shell.output, /runtime-ok/i);
  const artifact = await new ArtifactStore(path.join(root, 'artifacts')).put('result');
  assert.equal((await fs.readFile(artifact.path, 'utf8')), 'result');
});

test('ToolRuntime enforces the per-run mobile tool allowlist', async () => {
  const root = await tempWorkspace();
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory') });
  runtime.registerDefaults(); await runtime.initialize();
  runtime.beginRun(['file_read']);
  const signal = new AbortController().signal;
  const blocked = await runtime.execute('shell_execute', { tool_title: 'blocked command', command: 'echo should-not-run' }, { signal, sessionId: 'mobile_chat', toolCallId: 'blocked_call', workspaceDir: root });
  assert.equal(blocked.success, false);
  assert.match(blocked.output, /not available for this client permission level/);
});

test('ToolRuntime preserves complete large output for UI and session history', async () => {
  const root = await tempWorkspace();
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory') });
  runtime.registerDefaults(); await runtime.initialize();
  const content = `START-${'完整内容'.repeat(9_000)}-END`;
  await fs.writeFile(path.join(root, 'large-result.txt'), content, 'utf8');

  const result = await runtime.execute(
    'file_read',
    { tool_title: 'read complete output', path: 'large-result.txt', max_length: 120_000 },
    { signal: new AbortController().signal, sessionId: 'large_output_session', toolCallId: 'large_output_call', workspaceDir: root },
  );

  assert.equal(result.success, true, result.output);
  assert.match(result.output, /START-/);
  assert.match(result.output, /-END/);
  assert.doesNotMatch(result.output, /Large tool result stored as artifact/);
  assert.ok(result.output.length > 24_000);
  assert.equal(result.artifacts.length, 1);
  assert.equal(await fs.readFile(result.artifacts[0].path, 'utf8'), result.output);
});

test('renderer keeps complete tool input and output inside scrollable detail panes', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

  assert.match(renderer, /info\.argsText = typeof args === 'string' \? args : JSON\.stringify\(args \|\| \{\}, null, 2\)/);
  assert.match(renderer, /resultPre\.textContent = output \|\| ''/);
  assert.doesNotMatch(renderer, /output\.substring\(0, 5000\)/);
  assert.match(styles, /\.tool-args, \.tool-body pre\.tool-args \{[^}]*overflow: auto/s);
  assert.match(styles, /\.tool-body \.tool-result \{[^}]*max-height: 340px/s);
});

test('desktop and mobile conversations use the shared real-time session event stream', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const server = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'server.ts'), 'utf8');

  assert.match(renderer, /new EventSource\(`\$\{API_BASE\}\/api\/session-events\?clientId=/);
  assert.match(renderer, /conversationEventSource\.addEventListener\('session_changed'/);
  assert.match(renderer, /conversationEventSource\.addEventListener\('session_stream'/);
  assert.match(renderer, /function applyMirroredStreamEvent\(payload\)/);
  assert.match(renderer, /'X-IEXA-Client-Id': conversationClientId/);
  assert.match(server, /function broadcastSessionEvent\(event: string, data: unknown, excludedClientId = ''\)/);
  assert.match(server, /event: 'turn_started'/);
  assert.match(server, /saveMessages\(sessionId, trimmedProvisionalMessages\)/);
});

test('turn completion preserves an existing scrolled-up chat position', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(renderer, /const preserveScrollTop = visibleChatMessages\.scrollTop/);
  assert.match(renderer, /const preserveScroll = !isChatNearBottom\(\)/);
  assert.match(renderer, /visibleChatMessages\.scrollTop = preserveScrollTop/);
});

test('turn completion marks streamed DOM authoritative before metadata sync can reload history', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(renderer, /runtimeForSession\(sessionId\)\.liveTurnDomOwnedUntil = Date\.now\(\) \+ LIVE_TURN_DOM_OWNERSHIP_MS/);
  assert.match(renderer, /const liveDomOwned = Boolean\(runtime\?\.liveTurnDomOwnedUntil/);
  const doneBody = renderer.slice(renderer.indexOf('function handleDone('), renderer.indexOf('function handleCancelled('));
  assert.ok(doneBody.indexOf('protectLiveTurnDom();') < doneBody.indexOf('setProcessing(false);'));
  assert.doesNotMatch(renderer, /remoteTurnCompleted/);
});

test('restored task summary stays above the completed assistant answer', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(renderer, /const answer = el\.querySelector\('\.message-content'\);[\s\S]*?if \(answer\) el\.insertBefore\(steps, answer\);/);
});

test('chat focus capsule hides side panels and persists its state', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const app = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

  assert.match(renderer, /id="chatFocusToggle"/);
  assert.match(renderer, /<div class="chat-container">\s*<div class="chat-focus-reveal"/);
  assert.match(app, /function initChatFocusMode\(\)/);
  assert.match(app, /localStorage\.getItem\('iexa-chat-focus-mode'\)/);
  assert.match(app, /localStorage\.setItem\('iexa-chat-focus-mode'/);
  assert.match(styles, /\.chat-focus-reveal/);
  assert.match(styles, /body\.chat-focus-mode \.sidebar/);
  assert.match(styles, /body\.chat-focus-mode \.files-panel/);
  assert.match(styles, /body\.chat-focus-mode \.chat-messages \{\s*padding-left: 24px;\s*padding-right: 24px;/);
  assert.match(styles, /body\.chat-focus-mode \.message\.assistant/);
  assert.match(styles, /body\.chat-focus-mode \.message\.user/);
});

test('renderer keeps the sidebar function rail independently scrollable', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

  assert.match(styles, /\.sidebar \{[^}]*min-height: 0;[^}]*overflow: hidden;/s);
  assert.match(styles, /\.sidebar-nav \{[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;/s);
  assert.match(styles, /\.nav-btn \{[^}]*flex: 0 0 auto;/s);
  assert.match(styles, /\.sidebar-footer \{[^}]*flex: 0 0 auto;/s);
  assert.match(renderer, /function initSidebarNavigationScroll\(\)/);
  assert.match(renderer, /navigation\.scrollTop \+= event\.deltaY/);
});

test('assistant replies expose copy and non-duplicating retry controls', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const server = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'server.ts'), 'utf8');

  assert.match(renderer, /className = 'assistant-message-actions'/);
  assert.match(renderer, /data-action="copy"/);
  assert.match(renderer, /data-action="retry"/);
  assert.match(renderer, /copyAssistantMessage\(messageEl, this\)/);
  assert.match(renderer, /retryAssistantMessage\(messageEl, this\)/);
  assert.match(renderer, /retainSelected: false/);
  assert.match(styles, /\.assistant-message-action\.is-retrying \.ui-icon/);
  assert.match(server, /body\.retainSelected !== false/);
  assert.match(server, /messageIndex \+ \(retainSelected \? 1 : 0\)/);
});

test('plugin iframe bridge uses a dedicated MessageChannel', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const example = await fs.readFile(path.join(__dirname, '..', 'examples', 'plugins', 'hello-dashboard', 'ui', 'index.html'), 'utf8');

  assert.match(renderer, /function connectPluginFrame\(frame, pluginId\)/);
  assert.match(renderer, /const channel = new MessageChannel\(\)/);
  assert.match(renderer, /\[channel\.port2\]/);
  assert.match(example, /event\.data\?\.type !== 'iexa-plugin-init'/);
  assert.match(example, /bridge\.postMessage\(message\)/);
});

test('desktop source persists native window state and boot appearance', async () => {
  const electronEntry = await fs.readFile(path.join(__dirname, '..', 'electron-entry.js'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

  assert.match(electronEntry, /mainWindow\.getNormalBounds\(\)/);
  assert.match(electronEntry, /\.iexa-window-state\.json/);
  assert.match(electronEntry, /savedWindow\.maximized/);
  assert.match(preload, /initialAppearance: ipcRenderer\.sendSync/);
  assert.match(renderer, /fetch\(`\$\{API_BASE\}\/api\/appearance`/);
  assert.match(renderer, /scheduleAppearanceSave\(\)/);
});

test('tool definitions include structured array item schemas', async () => {
  const root = await tempWorkspace();
  const runtime = new ToolRuntime({ workspaceDir: root, memoryDir: path.join(root, 'memory') });
  runtime.registerDefaults();
  const todo = runtime.definitions().find((tool) => tool.name === 'todo_write');
  assert.equal(todo.parameters.todos.items.type, 'object');
  assert.deepEqual(todo.parameters.todos.items.required, ['content', 'status']);
  assert.deepEqual(todo.parameters.todos.items.properties.status.enumValues, ['pending', 'in_progress', 'completed']);
});

test('FileTools reads large text files by page without requiring the full body result', async () => {
  const root = await tempWorkspace();
  const file = path.join(root, 'large.log');
  await fs.writeFile(file, Array.from({ length: 20_000 }, (_, index) => `line-${index + 1}`).join('\n'), 'utf8');
  const tools = new FileTools();
  const page = await tools.readFile('large.log', root, { offset: 10_001, lines: 3, maxLength: 1000 });
  assert.equal(page.success, true);
  assert.match(page.output, /line-10001\nline-10002\nline-10003/);
  assert.match(page.output, /Lines: 20000/);
  const tail = await tools.readFile('large.log', root, { direction: 'tail', lines: 2, maxLength: 1000 });
  assert.match(tail.output, /line-19999\nline-20000/);
});

test('FileTools defaults to reading the full head page and preserves tail max_length', async () => {
  const root = await tempWorkspace();
  await fs.writeFile(path.join(root, 'notes.txt'), 'first\nsecond\nthird\nfourth\n', 'utf8');
  const tools = new FileTools();
  const head = await tools.readFile('notes.txt', root);
  assert.match(head.output, /first\nsecond\nthird\nfourth/);
  const tail = await tools.readFile('notes.txt', root, { direction: 'tail', lines: 4, maxLength: 8 });
  assert.match(tail.output, /fourth/);
  assert.doesNotMatch(tail.output, /first/);
});

test('FileTools rejects empty edit anchors', async () => {
  const root = await tempWorkspace();
  await fs.writeFile(path.join(root, 'edit.txt'), 'content', 'utf8');
  const tools = new FileTools();
  const result = await tools.editFile('edit.txt', '', 'x', root);
  assert.equal(result.success, false);
  assert.match(result.output, /old_string must not be empty/);
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), 'content');
});

test('FileTools reads UTF-16LE text files created by Windows tools', async () => {
  const root = await tempWorkspace();
  const body = Buffer.from('\uFEFF第一行\r\n第二行\r\n', 'utf16le');
  await fs.writeFile(path.join(root, 'powershell.txt'), body);
  const tools = new FileTools();
  const result = await tools.readFile('powershell.txt', root);
  assert.equal(result.success, true);
  assert.match(result.output, /第一行\n第二行/);
});

test('FileTools serializes concurrent writes to the same path', async () => {
  const root = await tempWorkspace();
  const tools = new FileTools();
  await tools.writeFile('queue.txt', 'base', root);
  await Promise.all([
    tools.writeFile('queue.txt', 'one', root),
    tools.writeFile('queue.txt', 'two', root),
  ]);
  const final = await fs.readFile(path.join(root, 'queue.txt'), 'utf8');
  assert.equal(final, 'two');
});

test('AgentRuntime routes an AgentLoop tool call through ToolRuntime', async () => {
  const root = await tempWorkspace();
  let calls = 0;
  const provider = {
    name: 'test', model: 'test-model', defaultMaxTokens: 1024,
    async *streamMessage() {
      if (calls++ === 0) {
        yield { type: 'toolCallComplete', id: 'call_write', name: 'file_write', args: { tool_title: 'write', path: 'agent.txt', content: 'created by runtime' } };
        yield { type: 'done', stopReason: 'toolUse' };
      } else {
        yield { type: 'textDelta', text: 'done' };
        yield { type: 'done', stopReason: 'endTurn' };
      }
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'runtime_test', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false });
  await runtime.initialize();
  let done = false;
  const callbacks = {
    onTextDelta() {}, onThinkingDelta() {}, onToolCallStart() {}, onToolInputDelta() {}, onToolCallComplete() {}, onToolResult() {}, onUsage() {}, onContext() {}, onError(error) { throw new Error(error); }, onCancelled() { throw new Error('unexpected cancellation'); }, onDone() { done = true; },
  };
  const tools = runtime.toolDefinitions();
  await runtime.run({ message: 'create file', tools, callbacks });
  assert.equal(done, true);
  assert.equal(await fs.readFile(path.join(root, 'agent.txt'), 'utf8'), 'created by runtime');
  assert.equal(runtime.getState().status, 'completed');
  assert.equal(runtime.getState().turn, 2);
  assert.equal(runtime.getObservability().metrics.runs_completed, 1);
  assert.equal(runtime.getObservability().metrics.tools_succeeded, 1);
});

test('AgentRuntime executes a complete tool call even when provider says endTurn', async () => {
  const root = await tempWorkspace();
  let calls = 0;
  const provider = {
    name: 'test', model: 'test-model', defaultMaxTokens: 1024,
    async *streamMessage() {
      if (calls++ === 0) {
        yield { type: 'toolCallComplete', id: 'call_end_turn', name: 'file_write', args: { tool_title: 'write', path: 'end-turn.txt', content: 'executed' } };
        yield { type: 'done', stopReason: 'endTurn' };
      } else {
        yield { type: 'textDelta', text: 'finished' };
        yield { type: 'done', stopReason: 'endTurn' };
      }
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'end_turn_tool', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false });
  await runtime.initialize();
  await runtime.run({ message: 'execute', tools: runtime.toolDefinitions(), callbacks: {
    onTextDelta() {}, onThinkingDelta() {}, onToolCallStart() {}, onToolInputDelta() {}, onToolCallComplete() {}, onToolResult() {}, onUsage() {}, onContext() {}, onError(error) { throw new Error(error); }, onCancelled() { throw new Error('unexpected cancellation'); }, onDone() {},
  } });
  assert.equal(await fs.readFile(path.join(root, 'end-turn.txt'), 'utf8'), 'executed');
  assert.equal(calls, 2);
});

test('OpenAI provider reports malformed tool arguments and preserves reasoning content', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think ', tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'file_write', arguments: '{"path":' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'more' }, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]',
    ].join('\n\n') + '\n\n';
    return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const provider = new OpenAIProvider({ type: 'openai', name: 'openai', model: 'deepseek-r1', apiKey: 'test', thinkingLevel: 'medium' });
    const events = [];
    for await (const event of provider.streamMessage([{ role: 'user', parts: [{ type: 'text', text: 'run' }] }], '', [{ name: 'file_write', description: 'write', parameters: {}, required: [] }], 1000)) events.push(event);
    const complete = events.find((event) => event.type === 'toolCallComplete');
    assert.equal(complete.parseError !== undefined, true);
    assert.deepEqual(complete.args, {});
    assert.equal(events.filter((event) => event.type === 'reasoningContent').map((event) => event.content).join(''), 'think more');

    const historyBody = requests[0];
    const historyProvider = new OpenAIProvider({ type: 'openai', name: 'openai', model: 'deepseek-r1', apiKey: 'test', thinkingLevel: 'off' });
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    for await (const _event of historyProvider.streamMessage([
      { role: 'assistant', reasoningContent: 'think more', parts: [{ type: 'toolUse', id: 'call_1', name: 'file_write', input: {} }] },
    ], '', [], 1000)) {}
    const replay = requests[requests.length - 1].messages.find((message) => message.role === 'assistant');
    assert.equal(replay.reasoning_content, 'think more');
    void historyBody;
  } finally {
    global.fetch = originalFetch;
  }
});

test('PermissionBroker supports pending approval and cancellation', async () => {
  const broker = new PermissionBroker(1_000);
  const request = { sessionId: 'permission_test', tool: { name: 'shell_execute', risk: 'high', requiresApproval: true }, args: { command: 'whoami' } };
  const pending = broker.request(request);
  assert.equal(broker.list('permission_test').length, 1);
  const item = broker.list('permission_test')[0];
  assert.equal(broker.resolve(item.id, 'allow_once'), true);
  assert.equal(await pending, 'allow_once');
  assert.equal(broker.list('permission_test').length, 0);
});

test('PermissionManager distinguishes allow-once from session grants', async () => {
  const root = await tempWorkspace();
  let prompts = 0;
  const tool = { name: 'shell_execute', risk: 'high', requiresApproval: true };
  const manager = new PermissionManager(root, async () => { prompts++; return 'allow_once'; });
  await manager.authorize({ sessionId: 's', tool, args: { command: 'echo ok' } });
  await manager.authorize({ sessionId: 's', tool, args: { command: 'echo ok' } });
  assert.equal(prompts, 2);
  const sessionManager = new PermissionManager(root, async () => 'allow_session');
  await sessionManager.authorize({ sessionId: 's', tool, args: { command: 'echo ok' } });
  let called = false;
  const granted = new PermissionManager(root, async () => { called = true; return 'deny'; });
  granted.grant('s', 'shell_execute');
  await granted.authorize({ sessionId: 's', tool, args: { command: 'echo ok' } });
  assert.equal(called, false);
});

test('Security audit records operation fields without leaking secrets', async () => {
  const root = await tempWorkspace();
  const manager = new PermissionManager(root, async () => 'allow_once');
  await manager.authorize({ sessionId: 'audit', tool: { name: 'shell_execute', risk: 'high', requiresApproval: true }, args: { command: 'echo sk-secret-value', path: 'safe.txt', password: 'top-secret' } });
  const audit = await fs.readFile(path.join(root, 'security-audit.jsonl'), 'utf8');
  assert.match(audit, /"command":"echo \[REDACTED\]"/);
  assert.match(audit, /"path":"safe\.txt"/);
  assert.doesNotMatch(audit, /top-secret|sk-secret-value/);
});

test('AgentRuntime cancellation reports cancelled when provider aborts the stream', async () => {
  const root = await tempWorkspace();
  const provider = {
    name: 'test', model: 'test-model', defaultMaxTokens: 1024,
    async *streamMessage(_messages, _system, _tools, _maxTokens, signal) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('provider stream aborted');
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'cancel_test', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false });
  await runtime.initialize();
  let cancelled = false;
  const run = runtime.run({ message: 'wait', tools: runtime.toolDefinitions(), callbacks: {
    onTextDelta() {}, onThinkingDelta() {}, onToolCallStart() {}, onToolInputDelta() {}, onToolCallComplete() {}, onToolResult() {}, onUsage() {}, onContext() {}, onError(error) { throw new Error(error); }, onCancelled() { cancelled = true; }, onDone() { throw new Error('unexpected completion'); },
  } });
  setTimeout(() => runtime.cancel(), 25);
  await run;
  assert.equal(cancelled, true);
  assert.equal(runtime.getState().status, 'cancelled');
});

test('MemoryRetriever ranks matching Markdown memory without loading every file into context', async () => {
  const root = await tempWorkspace();
  const memory = path.join(root, 'memory');
  await fs.mkdir(memory);
  await fs.writeFile(path.join(memory, 'old.md'), '# Notes\nJavaScript preference\n', 'utf8');
  await fs.writeFile(path.join(memory, 'target.md'), '# Project\nUse TypeScript strict mode for the IEXA runtime.\n', 'utf8');
  const hits = await new MemoryRetriever(memory).search('TypeScript runtime', { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'target.md');
  assert.match(hits[0].content, /TypeScript strict mode/);
});

test('SkillValidator rejects malformed or binary skill content', () => {
  const validator = new SkillValidator();
  assert.equal(validator.validate('---\nname valid\n---\nbody').valid, false);
  assert.equal(validator.validate('---\nname: valid\n---\nbody\0').valid, false);
  assert.equal(validator.validate('---\nname: valid\ndescription: valid\n---\n# Body').valid, true);
});

test('SessionManager persists messages atomically through its compatibility API', async () => {
  const root = await tempWorkspace();
  const manager = new SessionManager(root);
  manager.saveSync('session_1', [{ role: 'user', content: 'persisted' }]);
  assert.deepEqual(manager.loadSync('session_1'), [{ role: 'user', content: 'persisted' }]);
  await manager.save('session_2', { value: 2 });
  assert.deepEqual(await manager.load('session_2'), { value: 2 });
  await manager.save('session_2', { value: 3 });
  await fs.writeFile(path.join(root, 'session_2.json'), '{broken', 'utf8');
  assert.deepEqual(await manager.load('session_2'), { value: 2 });
  manager.deleteSync('session_1');
  assert.equal(manager.loadSync('session_1'), null);
});

test('JsonStore recovers a corrupt primary document from its backup', async () => {
  const root = await tempWorkspace();
  const file = path.join(root, 'state.json');
  const store = new JsonStore(file, () => ({ fallback: true }));
  store.saveSync({ value: 1 });
  store.saveSync({ value: 2 });
  await fs.writeFile(file, '{broken', 'utf8');
  assert.deepEqual(store.loadSync(), { value: 1 });
});

test('WebDAVConflictStore retains a remote copy and records resolution', async () => {
  const root = await tempWorkspace();
  const store = new WebDAVConflictStore(root);
  const item = store.preserve('session:a.json', path.join(root, 'a.json'), '/IEXA/sessions/a.json', Buffer.from('{"remote":true}'));
  assert.equal(store.list().length, 1);
  assert.equal(await fs.readFile(item.remoteCopyPath, 'utf8'), '{"remote":true}');
  assert.equal(store.resolve(item.id, 'local').status, 'resolved');
  assert.equal(store.list().length, 0);
});

test('TraceStore appends and reads session-scoped audit events', async () => {
  const root = await tempWorkspace();
  const store = new TraceStore(root);
  store.append('session_1', [{ at: 1, name: 'run_started' }, { at: 2, name: 'run_completed', data: { ok: true } }]);
  assert.deepEqual(store.read('session_1'), [{ at: 1, name: 'run_started' }, { at: 2, name: 'run_completed', data: { ok: true } }]);
});

test('WebDAV conflict detection only triggers after both sides changed from the same baseline', () => {
  const baseline = { localMtime: 100, remoteMtime: 100 };
  assert.equal(hasSyncConflict(baseline, 101, 100), false);
  assert.equal(hasSyncConflict(baseline, 100, 101), false);
  assert.equal(hasSyncConflict(baseline, 102, 102), true);
});

test('CostTracker estimates configured model pricing and marks unknown pricing', () => {
  assert.equal(estimateCostUsd('openai', 'gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0.75);
  assert.equal(estimateCostUsd('custom', 'unknown', { inputTokens: 100, outputTokens: 100 }), null);
});

test('ToolScheduler supplies duration and returns a timeout result', async () => {
  const scheduler = new ToolScheduler();
  let aborted = false;
  const result = await scheduler.execute({ timeoutMs: 10, execute: async (_args, context) => new Promise((resolve) => {
    context.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    setTimeout(() => resolve({ output: 'late', success: true }), 50);
  }) }, {}, { signal: new AbortController().signal, sessionId: 's', toolCallId: 't', workspaceDir: process.cwd() });
  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
  assert.ok(result.durationMs >= 8);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(aborted, true);
});

test('ProcessManager preserves Unicode and caps large output', async () => {
  const root = await tempWorkspace();
  const manager = new ProcessManager();
  const unicode = await manager.run('echo 中文输出', root, new AbortController().signal, { timeoutMs: 5_000, maxOutputBytes: 8_192, killGracePeriodMs: 50 });
  assert.equal(unicode.success, true);
  assert.match(unicode.output, /中文输出/);
  const large = await manager.run('for /L %i in (1,1,600) do @echo 1234567890', root, new AbortController().signal, { timeoutMs: 5_000, maxOutputBytes: 1_024, killGracePeriodMs: 50 });
  assert.ok(Buffer.byteLength(large.output) <= 1_024);
});

test('AgentRuntime remains stable through 50 sequential tool calls', async () => {
  const root = await tempWorkspace();
  let calls = 0;
  const provider = {
    name: 'test', model: 'test-model', defaultMaxTokens: 1024,
    async *streamMessage() {
      if (calls < 50) {
        const index = calls++;
        yield { type: 'toolCallComplete', id: `call_${index}`, name: 'file_write', args: { tool_title: `write ${index}`, path: `bulk-${index}.txt`, content: String(index) } };
        yield { type: 'done', stopReason: 'toolUse' };
      } else {
        yield { type: 'textDelta', text: 'complete' };
        yield { type: 'done', stopReason: 'endTurn' };
      }
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'bulk_test', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false });
  await runtime.initialize();
  await runtime.run({ message: 'bulk', tools: runtime.toolDefinitions(), callbacks: {
    onTextDelta() {}, onThinkingDelta() {}, onToolCallStart() {}, onToolInputDelta() {}, onToolCallComplete() {}, onToolResult() {}, onUsage() {}, onContext() {}, onError(error) { throw new Error(error); }, onCancelled() { throw new Error('unexpected cancellation'); }, onDone() {},
  } });
  assert.equal(calls, 50);
  assert.equal(runtime.getState().toolCalls, 50);
  assert.equal(runtime.getState().status, 'completed');
  assert.equal(runtime.getObservability().metrics.tools_succeeded, 50);
});

test('AgentRuntime retries a provider 429 and then completes', async () => {
  const root = await tempWorkspace();
  let attempts = 0;
  let retries = 0;
  const provider = {
    name: 'test', model: 'test-model', defaultMaxTokens: 1024,
    async *streamMessage() {
      if (attempts++ === 0) throw new Error('HTTP 429 rate limited');
      yield { type: 'textDelta', text: 'recovered' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'retry_test', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false });
  await runtime.initialize();
  await runtime.run({ message: 'retry', tools: runtime.toolDefinitions(), callbacks: {
    onTextDelta() {}, onThinkingDelta() {}, onToolCallStart() {}, onToolInputDelta() {}, onToolCallComplete() {}, onToolResult() {}, onUsage() {}, onContext() {}, onRetry() { retries++; }, onError(error) { throw new Error(error); }, onCancelled() { throw new Error('unexpected cancellation'); }, onDone() {},
  } });
  assert.equal(attempts, 2);
  assert.equal(retries, 1);
  assert.equal(runtime.getState().status, 'completed');
});

test('ContextManager compacts pressure and supports overflow recovery', async () => {
  const provider = {
    name: 'test', model: 'test-model', defaultMaxTokens: 256,
    async *streamMessage() {
      yield { type: 'textDelta', text: '## Primary Request and Intent\nKeep the request state.\n## Pending Work / Next Step\nContinue safely.' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const history = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    parts: [{ type: 'text', text: `${index % 2 ? 'assistant' : 'user'} ${'x'.repeat(3200)}` }],
  }));
  const manager = new ContextManager(provider, 6000, [], 'system', 2000);
  const statuses = [];
  const compacted = await manager.compact(history, (status) => statuses.push(status.state));
  assert.ok(compacted.length < history.length);
  assert.ok(statuses.includes('compacted'));
  const recovered = await manager.recover(history, () => {});
  assert.ok(recovered.length < history.length);
});

test('SOUL.md persists identity and injects a bounded personality section', async () => {
  const root = await tempWorkspace();
  const store = new SoulStore(root);
  const initial = store.ensureExists();
  assert.equal(initial.metadata.name, 'IEXA');
  const saved = store.save({ metadata: { name: '小艾', style: '温暖、直接', lang: 'zh' }, body: '先理解用户的目标，再用清晰步骤完成工作。' });
  assert.equal(saved.metadata.name, '小艾');
  const disk = await fs.readFile(path.join(root, 'SOUL.md'), 'utf8');
  assert.match(disk, /name: "小艾"/);
  assert.deepEqual(parseSoulMarkdown(disk), saved);
  assert.equal(soulTokenCount('hello world，你好'), 5);
  assert.equal(checkSoulBodyLimit('a '.repeat(2001)).isOverLimit, true);
  const prompt = buildSoulPromptSection(saved);
  assert.match(prompt, /你是 小艾/);
  assert.match(prompt, /assistant-personality/);
  assert.match(prompt, /先理解用户的目标/);
});

test('HTTP route modules expose runtime and WebDAV conflict endpoints', async () => {
  const root = await tempWorkspace();
  process.env.IEXA_WORKSPACE = root;
  const { startServer } = require('../dist/main/server');
  const server = await startServer(0, false);
  const port = server.address().port;
  try {
    const eventAbort = new AbortController();
    const eventResponse = await fetch(`http://127.0.0.1:${port}/api/session-events?clientId=sync-test`, { signal: eventAbort.signal });
    assert.equal(eventResponse.status, 200);
    const eventReader = eventResponse.body.getReader();
    let eventBuffer = '';
    const eventPromise = (async () => {
      while (true) {
        const chunk = await eventReader.read();
        if (chunk.done) return null;
        eventBuffer += new TextDecoder().decode(chunk.value);
        const match = eventBuffer.match(/event: session_changed\ndata: ([^\n]+)/);
        if (match) return JSON.parse(match[1]);
      }
    })();
    const eventSession = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' }).then((response) => response.json());
    const event = await Promise.race([
      eventPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('session event timeout')), 1500)),
    ]);
    assert.equal(event.sessionId, eventSession.session.id);
    assert.equal(event.reason, 'created');
    eventAbort.abort();

    const mode = await fetch(`http://127.0.0.1:${port}/api/permissions/mode`).then((response) => response.json());
    assert.equal(mode.mode, 'risk');
    const updated = await fetch(`http://127.0.0.1:${port}/api/permissions/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'full' }) }).then((response) => response.json());
    assert.equal(updated.mode, 'full');
    const appearance = await fetch(`http://127.0.0.1:${port}/api/appearance`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', accent: 'green', sidebarWidth: 318, filesPanelWidth: 412 }),
    }).then((response) => response.json());
    assert.deepEqual(appearance, { theme: 'dark', accent: 'green', sidebarWidth: 318, filesPanelWidth: 412 });
    const persistedAppearance = await fetch(`http://127.0.0.1:${port}/api/appearance`).then((response) => response.json());
    assert.deepEqual(persistedAppearance, appearance);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.iexa-appearance.json'), 'utf8')), appearance);
    const initialSoul = await fetch(`http://127.0.0.1:${port}/api/soul`).then((response) => response.json());
    assert.equal(initialSoul.metadata.name, 'IEXA');
    const savedSoul = await fetch(`http://127.0.0.1:${port}/api/soul`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { name: 'Ze', style: 'direct', lang: 'en' }, body: 'Be concise.' }),
    }).then((response) => response.json());
    assert.equal(savedSoul.metadata.name, 'Ze');
    assert.equal(savedSoul.body, 'Be concise.');
    const restoredSoul = await fetch(`http://127.0.0.1:${port}/api/soul/restore`, { method: 'POST' }).then((response) => response.json());
    assert.equal(restoredSoul.metadata.name, 'IEXA');
    const retrySession = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' }).then((response) => response.json());
    const retryMessages = [
      { role: 'user', content: 'first prompt', timestamp: 1 },
      { role: 'assistant', content: 'first answer', timestamp: 2 },
      { role: 'user', content: 'retry this prompt', timestamp: 3 },
      { role: 'assistant', content: 'replace this answer', timestamp: 4 },
    ];
    await fs.writeFile(path.join(root, '.iexa-sessions', `${retrySession.session.id}.json`), JSON.stringify(retryMessages), 'utf8');
    const retryReset = await fetch(`http://127.0.0.1:${port}/api/sessions/${retrySession.session.id}/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex: 2, retainSelected: false }),
    }).then((response) => response.json());
    assert.equal(retryReset.messages, 2);
    const retryHistory = await fetch(`http://127.0.0.1:${port}/api/sessions/${retrySession.session.id}`).then((response) => response.json());
    assert.deepEqual(retryHistory.messages.map((message) => message.content), ['first prompt', 'first answer']);
    const conflicts = await fetch(`http://127.0.0.1:${port}/api/webdav/conflicts`).then((response) => response.json());
    assert.deepEqual(conflicts.conflicts, []);
    const traces = await fetch(`http://127.0.0.1:${port}/api/traces`).then((response) => response.json());
    assert.match(traces.error, /sessionId required/);
    const uploadSize = 8 * 1024 * 1024 + 123;
    const initialized = await fetch(`http://127.0.0.1:${port}/api/uploads/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'upload_test', name: 'large.bin', mime: 'application/octet-stream', kind: 'file', size: uploadSize }),
    }).then((response) => response.json());
    assert.ok(initialized.uploadId);
    const firstChunk = Buffer.alloc(4 * 1024 * 1024, 0x41);
    const secondChunk = Buffer.alloc(4 * 1024 * 1024, 0x42);
    const thirdChunk = Buffer.alloc(uploadSize - firstChunk.length - secondChunk.length, 0x43);
    const first = await fetch(`http://127.0.0.1:${port}/api/uploads/chunk?uploadId=${encodeURIComponent(initialized.uploadId)}&offset=0`, { method: 'POST', body: firstChunk }).then((response) => response.json());
    assert.equal(first.received, firstChunk.length);
    const second = await fetch(`http://127.0.0.1:${port}/api/uploads/chunk?uploadId=${encodeURIComponent(initialized.uploadId)}&offset=${first.received}`, { method: 'POST', body: secondChunk }).then((response) => response.json());
    assert.equal(second.received, firstChunk.length + secondChunk.length);
    const third = await fetch(`http://127.0.0.1:${port}/api/uploads/chunk?uploadId=${encodeURIComponent(initialized.uploadId)}&offset=${second.received}`, { method: 'POST', body: thirdChunk }).then((response) => response.json());
    assert.equal(third.received, uploadSize);
    const completed = await fetch(`http://127.0.0.1:${port}/api/uploads/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: initialized.uploadId }) }).then((response) => response.json());
    assert.match(completed.savedPath, /^uploads\/upload_test\//);
    const uploaded = await fs.readFile(path.join(root, completed.savedPath));
    assert.equal(uploaded.length, uploadSize);
    assert.equal(uploaded[0], 0x41); assert.equal(uploaded[uploaded.length - 1], 0x43);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
