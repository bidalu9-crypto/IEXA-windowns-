/**
 * Incremental plain-text index over chat sessions.
 *
 * Why this exists: a transcript stores every tool payload, so one session can
 * reach tens of megabytes while its searchable prose is a few kilobytes.
 * Searching used to `JSON.parse` every session (and lowercase every message)
 * on each keystroke of the search box. The index keeps only role/content text,
 * refreshes a session only when its size/mtime changes, and is pruned when the
 * session disappears.
 *
 * Deliberately dependency-free: a per-session JSON record is small, easy to
 * inspect, and cannot be corrupted by a schema migration. A damaged record is
 * simply rebuilt on the next sync.
 */
export interface SessionIndexSource {
    id: string;
    title: string;
    updated: number;
    filePath: string;
}
export interface SearchMatch {
    role: string;
    snippet: string;
    /** Zero-based message offset inside the session. */
    index: number;
    timestamp?: number;
}
export interface SearchHit {
    sessionId: string;
    title: string;
    updated: number;
    matches: SearchMatch[];
    score: number;
}
export interface SyncStats {
    scanned: number;
    indexed: number;
    skipped: number;
    removed: number;
    bytesRead: number;
}
export interface SearchOptions {
    /** Maximum number of sessions returned. Default 30. */
    limit?: number;
    /** Maximum matches kept per session. Default 5. */
    perSession?: number;
    /** Characters of context on each side of a hit. Default 40. */
    contextChars?: number;
}
export declare class SessionSearchIndex {
    private readonly directory;
    private readonly cache;
    constructor(directory: string);
    /** Create/refresh records for the supplied sessions and drop orphans. */
    sync(sources: readonly SessionIndexSource[]): SyncStats;
    search(query: string, options?: SearchOptions): SearchHit[];
    /** Drop a single record; the next sync rebuilds it. */
    invalidate(id: string): void;
    stats(): {
        records: number;
        bytes: number;
    };
    private recordPath;
    private listRecordIds;
    private fingerprint;
    private read;
    private write;
    /** Extract only the prose a user would search for; tool payloads are skipped. */
    private extract;
}
/** Split a query into lowercase terms; quoted phrases stay together. */
export declare function tokenize(query: string): string[];
//# sourceMappingURL=SessionSearchIndex.d.ts.map