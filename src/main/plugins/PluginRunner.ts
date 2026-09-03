import * as fs from 'fs';

interface RunnerPayload { tool: string; args: Record<string, unknown>; context: Record<string, unknown>; }

async function readInput(): Promise<RunnerPayload> {
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) throw new Error('插件输入超过 2 MB 限制。');
  }
  return JSON.parse(body || '{}') as RunnerPayload;
}

async function main(): Promise<void> {
  const entry = process.argv[2];
  if (!entry || !fs.existsSync(entry)) throw new Error('插件入口不存在。');
  const payload = await readInput();
  const plugin = require(entry) as { execute?: Function; tools?: Record<string, Function>; default?: { execute?: Function; tools?: Record<string, Function> } };
  const target = plugin.default || plugin;
  const handler = target.tools?.[payload.tool] || (target.execute ? (args: unknown, context: unknown) => target.execute!(payload.tool, args, context) : undefined);
  if (typeof handler !== 'function') throw new Error(`插件未导出工具处理器：${payload.tool}`);
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    const value = await handler(payload.args || {}, payload.context || {});
    const result = value && typeof value === 'object' && !Array.isArray(value) && ('output' in value || 'success' in value)
      ? value
      : { output: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2), success: true };
    process.stdout.write(JSON.stringify(result));
  } finally {
    console.log = originalLog;
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ output: `插件执行失败：${error instanceof Error ? error.message : String(error)}`, success: false }));
  process.exitCode = 1;
});
