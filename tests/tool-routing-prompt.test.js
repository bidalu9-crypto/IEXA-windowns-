const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { buildSystemPrompt } = require('../dist/main/agent/SystemPrompt');
const { makeAgentTools } = require('../dist/main/tools/ToolDefinitions');
const { ProcessManager } = require('../dist/main/tools/shell/ProcessManager');

test('application tasks prefer direct commands and APIs, GUI remains a separate route', () => {
  const prompt = buildSystemPrompt({ workspaceDir: process.cwd(), hasProject: true });
  const routing = prompt.indexOf('先按用户意图选工具');
  const gui = prompt.indexOf('桌面 GUI 任务使用 desktop_control');
  assert.ok(routing >= 0 && gui > routing);
  assert.match(prompt, /优先使用 file_\* 或 shell_execute/);
  assert.match(prompt, /需要读屏或控件交互、或经检查没有可用命令\/API 时，才用 desktop_control/);
  assert.match(prompt, /不要用 shell\/curl 代替 desktop_control 或绕开它的焦点\/审批保护/);
  assert.doesNotMatch(prompt, /桌面任务直接使用 desktop_control/);
  const tools = makeAgentTools();
  const shell = tools.find(t => t.name === 'shell_execute');
  const desktop = tools.find(t => t.name === 'desktop_control');
  assert.match(shell.description, /Prefer direct CLI, PowerShell and public APIs/);
  assert.match(desktop.description, /Use this for actual GUI observation and input/);
});

test('the existing PowerShell process route executes a real command', { skip: process.platform !== 'win32' }, async () => {
  const result = await new ProcessManager().run(
    "Write-Output 'IEXA_SHELL_OK'", process.cwd(), new AbortController().signal,
    { timeoutMs: 15000, maxOutputBytes: 4096, killGracePeriodMs: 1500 }, 'powershell',
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /IEXA_SHELL_OK/);
});
