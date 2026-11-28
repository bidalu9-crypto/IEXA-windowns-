/** Wait briefly for cooperative cleanup, then release an aborted caller.
 * Both branches stay observed so an abandoned executor/iterator rejection
 * cannot become an unhandled rejection after the next turn has started. */
export declare function awaitOrAbort<T>(work: PromiseLike<T>, signal: AbortSignal, graceMs?: number): Promise<T>;
/** Cleanup never owns the conversation lock indefinitely. */
export declare function settleWithin(work: PromiseLike<unknown>, timeoutMs: number): Promise<void>;
//# sourceMappingURL=AbortWait.d.ts.map