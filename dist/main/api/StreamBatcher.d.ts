/** Coalesce adjacent deltas only. Grouping all text before all reasoning used
 * to reverse event order and made a faithful transcript impossible.
 *
 * The interval is the longest the client can go without hearing anything. An
 * 80ms window merged whatever the model produced in that time into one frame;
 * a model that speeds up after reasoning then handed the reader a whole
 * paragraph at once. 40ms halves the worst-case chunk without doubling the
 * event count to the point where the socket work dominates. */
export declare class StreamBatcher {
    private readonly send;
    private readonly interval;
    private timer?;
    private pending;
    constructor(send: (event: string, data: any) => void, interval?: number);
    emit(event: string, data: any): void;
    flush(): void;
}
//# sourceMappingURL=StreamBatcher.d.ts.map