export type TranscriptItem = {
    id: string;
    sequence: number;
    timestamp: number;
} & ({
    type: 'text' | 'thinking';
    start: number;
    end: number;
    durationMs?: number;
} | {
    type: 'tool';
    callId: string;
    name: string;
}
/** A context checkpoint: older history was folded into a summary here. */
 | {
    type: 'compaction';
    before: number;
    after: number;
});
export interface TranscriptEvents {
    version: 1;
    turnId: string;
    revision: number;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    valid: boolean;
    invalidReason?: string;
    items: TranscriptItem[];
}
/** Ordered semantic events. Content is referenced by UTF-16 ranges into the
 * existing message fields, not duplicated per token. Adjacent deltas coalesce,
 * but no event ever crosses a text/thinking/tool boundary. */
export declare class TranscriptRecorder {
    private readonly clock;
    private readonly maxItems;
    readonly turnId: `${string}-${string}-${string}-${string}-${string}`;
    private text;
    private thinking;
    private revision;
    private readonly items;
    private readonly toolIds;
    private status;
    private invalidReason?;
    constructor(clock?: () => number, maxItems?: number);
    private add;
    private closeThinking;
    recordText(fullText: string): void;
    recordThinking(delta: string): void;
    recordTool(callId: string, name: string): void;
    /** Marks the exact point where a checkpoint replaced older history. */
    recordCompaction(before: number, after: number): void;
    /**
     * Adopt the events of an interrupted turn so continuing it keeps one
     * transcript instead of starting a second one. `carried` must be the text the
     * restored ranges were measured against, or later deltas would look replaced.
     */
    restore(events: TranscriptEvents | undefined, carried?: {
        text?: string;
        thinking?: string;
    }): void;
    finish(status: Exclude<TranscriptEvents['status'], 'running'>): void;
    snapshot(): TranscriptEvents;
}
//# sourceMappingURL=TranscriptRecorder.d.ts.map