export interface ContextUsageSnapshot {
    usedTokens: number;
    contextWindow: number;
    compactThreshold: number;
    /** False once a provider receipt sized the last request. */
    estimated: boolean;
    updatedAt: number;
}
/** Shape the AgentLoop reports on every context event. */
export interface ContextStatusLike {
    usedTokens?: unknown;
    contextWindow?: unknown;
    compactThreshold?: unknown;
    estimated?: unknown;
}
/** Normalize a persisted record; anything malformed is simply absent. */
export declare function normalizeContextUsage(raw: unknown): ContextUsageSnapshot | null;
/** A live status becomes a storable record, or null while the size is unknown. */
export declare function contextUsageFromStatus(status: ContextStatusLike | null | undefined): ContextUsageSnapshot | null;
/** Rebuild the live status shape the renderer paints from. */
export declare function contextUsageStatus(snapshot: ContextUsageSnapshot): {
    usedTokens: number;
    contextWindow: number;
    compactThreshold: number;
    estimated: boolean;
    state: 'ok' | 'near-limit';
};
export declare function readContextUsage(filePath: string): ContextUsageSnapshot | null;
/**
 * Merge the record into the session file. Content and summary belong to the
 * caller that owns them, so a usage write must never replace them with blanks.
 */
export declare function writeContextUsage(filePath: string, snapshot: ContextUsageSnapshot): void;
/**
 * Turning every streaming status into a write would hammer the disk. Persist
 * once the size has moved by a meaningful amount; the turn end always writes.
 */
export declare function shouldPersistContextUsage(previous: ContextUsageSnapshot | null | undefined, next: ContextUsageSnapshot): boolean;
//# sourceMappingURL=ContextUsageStore.d.ts.map