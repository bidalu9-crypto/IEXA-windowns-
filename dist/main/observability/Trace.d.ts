export interface TraceEvent {
    at: number;
    name: string;
    data?: Record<string, unknown>;
}
export interface TraceOptions {
    maxEvents?: number;
    maxBytes?: number;
    maxEventBytes?: number;
}
/** Bounded retained history. Incremental consumers MUST use cursor()/since(), not snapshot indices. */
export declare class Trace {
    private readonly events;
    private sequence;
    private bytes;
    private readonly maxEvents;
    private readonly maxBytes;
    private readonly maxEventBytes;
    constructor(options?: TraceOptions);
    event(name: string, data?: Record<string, unknown>): void;
    /** Exclusive monotonic cursor, independent of eviction and wall-clock timestamps. */
    cursor(): number;
    /** Earliest retained cursor; a smaller requested cursor indicates dropped history. */
    oldestCursor(): number;
    since(cursor: number): TraceEvent[];
    /** Retained history only. Do not save .length as an incremental persistence cursor. */
    snapshot(): TraceEvent[];
}
//# sourceMappingURL=Trace.d.ts.map