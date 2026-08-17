import { ToolDefinition, ToolExecutionContext } from './ToolRegistry';
import { ToolExecutionResult } from '../providers/types';

export class ToolScheduler {
  async execute(tool: ToolDefinition, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    if (context.signal.aborted) return { output: 'Tool cancelled before execution.', success: false, timedOut: false, durationMs: 0 };
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    context.signal.addEventListener('abort', abortFromParent, { once: true });
    const timeoutMs = tool.timeoutMs;
    const operation = tool.execute(args, { ...context, signal: controller.signal });
    if (!timeoutMs) {
      try { return { ...(await operation), durationMs: Date.now() - startedAt }; }
      finally { context.signal.removeEventListener('abort', abortFromParent); }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([operation, new Promise<ToolExecutionResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ output: `Tool timed out after ${timeoutMs}ms.`, success: false, timedOut: true });
          controller.abort();
        }, timeoutMs);
      })]);
      return { ...result, durationMs: Date.now() - startedAt };
    } finally { if (timer) clearTimeout(timer); context.signal.removeEventListener('abort', abortFromParent); }
  }
}
