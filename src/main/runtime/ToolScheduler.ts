import { ToolDefinition, ToolExecutionContext } from './ToolRegistry';
import { ToolExecutionResult } from '../providers/types';

export class ToolScheduler {
  async execute(tool: ToolDefinition, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    if (context.signal.aborted) return { output: 'Tool cancelled before execution.', success: false, cancelled: true, executionStatus: 'cancelled', durationMs: 0 };
    const controller = new AbortController();
    let reason: 'cancelled' | 'timed_out' | undefined;
    const cancel = (value: 'cancelled' | 'timed_out') => {
      if (reason) return;
      reason = value;
      try { context.onCancellation?.(value); } catch { /* A UI listener is not the executor. */ }
      controller.abort(value === 'cancelled' ? context.signal.reason : new Error('Tool deadline exceeded.'));
    };
    const abortFromParent = () => cancel('cancelled');
    context.signal.addEventListener('abort', abortFromParent, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (tool.timeoutMs && Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0) timer = setTimeout(() => cancel('timed_out'), tool.timeoutMs);
    let result: ToolExecutionResult;
    try {
      // Wait for the executor to settle/clean up. Returning from Promise.race here
      // used to mark a tool finished while its process could still be executing.
      result = await tool.execute(args, { ...context, signal: controller.signal });
    } catch (error) {
      result = { output: (error as Error)?.message || 'Tool execution failed.', success: false };
    } finally {
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', abortFromParent);
    }
    if (reason) {
      return { ...result, success: false, cancelled: reason === 'cancelled', timedOut: reason === 'timed_out', executionStatus: reason,
        output: result.output || (reason === 'cancelled' ? 'Tool cancelled.' : 'Tool deadline exceeded.'), durationMs: Date.now() - startedAt };
    }
    return { ...result, durationMs: Date.now() - startedAt };
  }
}
