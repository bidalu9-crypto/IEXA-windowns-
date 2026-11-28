"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.awaitOrAbort = awaitOrAbort;
exports.settleWithin = settleWithin;
/** Wait briefly for cooperative cleanup, then release an aborted caller.
 * Both branches stay observed so an abandoned executor/iterator rejection
 * cannot become an unhandled rejection after the next turn has started. */
function awaitOrAbort(work, signal, graceMs = 0) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (failed, value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            if (failed)
                reject(value);
            else
                resolve(value);
        };
        const cancelled = () => {
            const error = new Error('Operation cancelled.');
            error.name = 'AbortError';
            finish(true, error);
        };
        const abort = () => { if (graceMs > 0)
            timer = setTimeout(cancelled, graceMs);
        else
            queueMicrotask(cancelled); };
        Promise.resolve(work).then(value => finish(false, value), error => finish(true, error));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
    });
}
/** Cleanup never owns the conversation lock indefinitely. */
async function settleWithin(work, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        await awaitOrAbort(work, controller.signal);
    }
    catch { /* detached work remains observed */ }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=AbortWait.js.map