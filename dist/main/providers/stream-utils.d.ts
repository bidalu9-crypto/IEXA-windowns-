export declare const STREAM_RETRY_DELAYS_MS: number[];
export declare function isAbortError(error: unknown): boolean;
export declare function throwIfAborted(signal?: AbortSignal | null): void;
/** Reject on cancellation and remove the listener on every settlement path. */
export declare function abortableSleep(delayMs: number, signal?: AbortSignal | null): Promise<void>;
export declare function isRetryableStatus(status: number): boolean;
export declare function fetchWithRetry(input: string | URL | Request, init: RequestInit & {
    userAgent?: string;
}, attempts?: number): Promise<Response>;
export declare const STREAM_IDLE_TIMEOUT_MS: number;
export declare function readWithTimeout<T>(reader: ReadableStreamDefaultReader<T>, timeoutMs?: number, signal?: AbortSignal): Promise<{
    done: boolean;
    value?: T;
}>;
/** SSE framing independent of byte boundaries; also accepts a plain JSON error body. */
export declare function readSSEFrames(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{
    data: string;
    event: string;
}>;
//# sourceMappingURL=stream-utils.d.ts.map