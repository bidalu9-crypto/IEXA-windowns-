export declare class RetryManager {
    private readonly delays;
    constructor(delays?: readonly number[]);
    isRetryable(error: unknown): boolean;
    /** Legacy AgentLoop contract: wake on cancellation, then the caller checks its signal. */
    sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
    /** Pass signal into the operation's I/O as well; arbitrary promises cannot be forcibly stopped. */
    run<T>(operation: (signal?: AbortSignal) => Promise<T>, onRetry?: (attempt: number, delayMs: number, error: Error) => void, signal?: AbortSignal): Promise<T>;
}
//# sourceMappingURL=RetryManager.d.ts.map