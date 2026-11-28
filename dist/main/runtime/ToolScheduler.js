"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolScheduler = void 0;
const AbortWait_1 = require("./AbortWait");
class ToolScheduler {
    async execute(tool, args, context) {
        const startedAt = Date.now();
        if (context.signal.aborted)
            return { output: 'Tool cancelled before execution.', success: false, cancelled: true, executionStatus: 'cancelled', durationMs: 0 };
        const controller = new AbortController();
        let reason;
        let acceptingEvents = true;
        const cancel = (value) => {
            if (reason)
                return;
            reason = value;
            try {
                context.onCancellation?.(value);
            }
            catch { /* A UI listener is not the executor. */ }
            controller.abort(value === 'cancelled' ? context.signal.reason : new Error('Tool deadline exceeded.'));
        };
        const abortFromParent = () => cancel('cancelled');
        context.signal.addEventListener('abort', abortFromParent, { once: true });
        let timer;
        if (tool.timeoutMs && Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)
            timer = setTimeout(() => cancel('timed_out'), tool.timeoutMs);
        let result;
        try {
            // Cooperative tools get a short cleanup window. An extension or provider
            // that ignores abort must not hold the chat's terminal event forever.
            // Shell/Desktop executors receive abort immediately and own process cleanup.
            result = await (0, AbortWait_1.awaitOrAbort)(Promise.resolve().then(() => tool.execute(args, { ...context, signal: controller.signal,
                onToolState: event => { if (acceptingEvents && !controller.signal.aborted)
                    context.onToolState?.(event); },
            })), controller.signal, 150);
        }
        catch (error) {
            result = { output: error?.message || 'Tool execution failed.', success: false };
        }
        finally {
            acceptingEvents = false;
            if (timer)
                clearTimeout(timer);
            context.signal.removeEventListener('abort', abortFromParent);
        }
        if (reason) {
            return { ...result, success: false, cancelled: reason === 'cancelled', timedOut: reason === 'timed_out', executionStatus: reason,
                output: result.output || (reason === 'cancelled' ? 'Tool cancelled.' : 'Tool deadline exceeded.'), durationMs: Date.now() - startedAt };
        }
        return { ...result, durationMs: Date.now() - startedAt };
    }
}
exports.ToolScheduler = ToolScheduler;
//# sourceMappingURL=ToolScheduler.js.map