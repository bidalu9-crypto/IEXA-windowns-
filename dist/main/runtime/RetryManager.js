"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryManager = void 0;
const ProviderError_1 = require("../providers/ProviderError");
const stream_utils_1 = require("../providers/stream-utils");
class RetryManager {
    delays;
    constructor(delays = [2000, 5000, 10000]) {
        if (delays.some(delay => !Number.isFinite(delay) || delay < 0 || delay > 2_147_483_647))
            throw new RangeError('retry delays must be finite non-negative timer durations');
        this.delays = [...delays];
    }
    isRetryable(error) { return ProviderError_1.ProviderError.from(error).retryable; }
    /** Legacy AgentLoop contract: wake on cancellation, then the caller checks its signal. */
    async sleep(delayMs, signal) {
        try {
            await (0, stream_utils_1.abortableSleep)(delayMs, signal);
        }
        catch (error) {
            if (!signal?.aborted)
                throw error;
        }
    }
    /** Pass signal into the operation's I/O as well; arbitrary promises cannot be forcibly stopped. */
    async run(operation, onRetry, signal) {
        for (let attempt = 0;; attempt++) {
            (0, stream_utils_1.throwIfAborted)(signal);
            try {
                const result = await operation(signal);
                (0, stream_utils_1.throwIfAborted)(signal);
                return result;
            }
            catch (error) {
                (0, stream_utils_1.throwIfAborted)(signal);
                const normalized = ProviderError_1.ProviderError.from(error);
                if (!normalized.retryable || attempt >= this.delays.length)
                    throw normalized;
                const delay = this.delays[attempt];
                onRetry?.(attempt + 1, delay, normalized);
                await (0, stream_utils_1.abortableSleep)(delay, signal);
            }
        }
    }
}
exports.RetryManager = RetryManager;
//# sourceMappingURL=RetryManager.js.map