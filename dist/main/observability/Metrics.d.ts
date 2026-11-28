/**
 * Process-local counters and latency aggregates. Nothing here is sampled or
 * exported off-device; snapshots are appended to the session trace JSONL so a
 * diagnostics export can show how a run actually behaved.
 */
export declare class Metrics {
    private readonly counters;
    private readonly samples;
    private readonly startedAt;
    increment(name: string, value?: number): void;
    /** Record one latency/size observation; non-finite or negative values are ignored. */
    observe(name: string, value: number): void;
    snapshot(): Record<string, number>;
    reset(): void;
}
//# sourceMappingURL=Metrics.d.ts.map