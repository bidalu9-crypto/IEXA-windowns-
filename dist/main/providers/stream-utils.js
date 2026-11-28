"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STREAM_IDLE_TIMEOUT_MS = exports.STREAM_RETRY_DELAYS_MS = void 0;
exports.isAbortError = isAbortError;
exports.throwIfAborted = throwIfAborted;
exports.abortableSleep = abortableSleep;
exports.isRetryableStatus = isRetryableStatus;
exports.fetchWithRetry = fetchWithRetry;
exports.readWithTimeout = readWithTimeout;
exports.readSSEFrames = readSSEFrames;
const ProviderError_1 = require("./ProviderError");
const RequestHeaders_1 = require("./RequestHeaders");
exports.STREAM_RETRY_DELAYS_MS = [2000, 5000, 10000];
function isAbortError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const value = error;
    return value.name === 'AbortError' || value.code === 'ABORT_ERR' || value.code === 'PROVIDER_ABORTED';
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}
/** Reject on cancellation and remove the listener on every settlement path. */
function abortableSleep(delayMs, signal) {
    return new Promise((resolve, reject) => {
        throwIfAborted(signal);
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(signal?.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        };
        const timer = setTimeout(finish, delayMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            abort();
    });
}
function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
async function fetchWithRetry(input, init, attempts = exports.STREAM_RETRY_DELAYS_MS.length + 1) {
    const signal = init.signal === undefined && typeof Request !== 'undefined' && input instanceof Request ? input.signal : init.signal;
    throwIfAborted(signal);
    if (!Number.isSafeInteger(attempts) || attempts < 1)
        throw new RangeError('attempts must be a positive integer');
    const inheritedHeaders = init.headers === undefined && typeof Request !== 'undefined' && input instanceof Request ? input.headers : init.headers;
    const { userAgent, ...fetchInit } = init;
    const requestInit = { ...fetchInit, headers: (0, RequestHeaders_1.modelRequestHeaders)(inheritedHeaders, userAgent) };
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
        throwIfAborted(signal);
        try {
            const response = await fetch(input, requestInit);
            if (signal?.aborted) {
                void response.body?.cancel().catch(() => { });
                throwIfAborted(signal);
            }
            if (response.ok || !isRetryableStatus(response.status) || attempt === attempts - 1)
                return response;
            // Do not buffer (or await draining) an arbitrarily large/erroring body.
            void response.body?.cancel().catch(() => { });
            lastError = new Error(`HTTP ${response.status}`);
        }
        catch (error) {
            throwIfAborted(signal);
            if (!ProviderError_1.ProviderError.from(error).retryable || attempt === attempts - 1)
                throw error;
            lastError = error;
        }
        await abortableSleep(exports.STREAM_RETRY_DELAYS_MS[Math.min(attempt, exports.STREAM_RETRY_DELAYS_MS.length - 1)], signal);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'request failed'));
}
// Reasoning models can spend several minutes between SSE frames while doing
// hidden work. A 45s idle cutoff aborts a healthy stream and truncates the
// visible thinking block. Keep a generous transport watchdog for genuinely
// dead connections; the caller's AbortSignal still remains the hard cancel.
exports.STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
async function readWithTimeout(reader, timeoutMs = exports.STREAM_IDLE_TIMEOUT_MS, signal) {
    throwIfAborted(signal);
    let timer;
    let abort;
    try {
        const result = await Promise.race([
            new Promise((_, reject) => {
                abort = () => {
                    reject(signal?.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
                    void reader.cancel(signal?.reason).catch(() => { });
                };
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted)
                    abort();
            }),
            reader.read(),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`stream idle timeout after ${timeoutMs}ms`));
                    void reader.cancel('stream idle timeout').catch(() => { });
                }, timeoutMs);
            }),
        ]);
        throwIfAborted(signal);
        return result;
    }
    finally {
        if (abort)
            signal?.removeEventListener('abort', abort);
        if (timer)
            clearTimeout(timer);
    }
}
/** SSE framing independent of byte boundaries; also accepts a plain JSON error body. */
async function* readSSEFrames(reader, signal) {
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data = [];
    let json = '';
    const line = (text) => {
        if (!text) {
            const frame = data.length ? { data: data.join('\n'), event } : undefined;
            data = [];
            event = '';
            return frame;
        }
        if (text.startsWith('event:'))
            event = text.slice(6).trim();
        else if (text.startsWith('data:'))
            data.push(text.slice(5).replace(/^ /, ''));
        else if (json || text.trimStart().startsWith('{'))
            json += text + '\n';
        return undefined;
    };
    while (true) {
        const { done, value } = await readWithTimeout(reader, exports.STREAM_IDLE_TIMEOUT_MS, signal);
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        // Keep a trailing CR pending: it may be half of a split CRLF delimiter.
        let match;
        while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
            const frame = line(buffer.slice(0, match.index));
            buffer = buffer.slice(match.index + match[0].length);
            if (frame) {
                throwIfAborted(signal);
                yield frame;
            }
        }
        if (done) {
            if (buffer) {
                const frame = line(buffer.replace(/\r$/, ''));
                if (frame)
                    yield frame;
            }
            const frame = line('');
            if (frame)
                yield frame;
            if (json.trim())
                yield { data: json.trim(), event: '' };
            return;
        }
        if (buffer.length + json.length + data.reduce((sum, text) => sum + text.length, 0) > 8 * 1024 * 1024) {
            throw new ProviderError_1.ProviderError('INVALID_STREAM', 'Provider SSE frame exceeds size limit', false);
        }
    }
}
//# sourceMappingURL=stream-utils.js.map