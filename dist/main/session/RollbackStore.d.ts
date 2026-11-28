/**
 * Undo snapshots live outside the session JSON.
 *
 * Every successful file edit stores the file's previous bytes so the turn can
 * be reverted. Those bytes used to sit inline as `beforeBase64`, which made a
 * long editing session grow without bound: one conversation here reached 82 MB,
 * and every save copied the whole thing to `.bak`.
 *
 * Snapshots are now written once, content-addressed and gzipped, under
 * `<sessions>/rollbacks/<sha256>.bin.gz`. The message keeps only `beforeRef`.
 * The undo route rehydrates the turn it is about to touch; nothing else needs
 * the bytes, and `clientMessages` already replaces rollback with a boolean.
 */
export interface RollbackSnapshot {
    version: 1;
    beforeExists: boolean;
    beforeBase64?: string;
    beforeRef?: string;
    afterSha256: string;
}
export declare function isRollbackSnapshot(value: unknown): value is RollbackSnapshot;
export declare function rollbackPath(dir: string, ref: string): string;
/**
 * Return a copy of `value` where every inline snapshot has been written to
 * `dir` and replaced with `beforeRef`. The input is left untouched: the live
 * session keeps its bytes for the undo path in this process.
 */
export declare function encodeRollbacks<T>(value: T, dir: string): T;
/**
 * Restore `beforeBase64` for every snapshot that has a `beforeRef`, in place.
 * Call this on a freshly loaded session right before undo validation; a
 * missing or unreadable snapshot is left unresolved and `undoUnavailable`
 * reports the record as incomplete, which is the same outcome as an old
 * session that never had a snapshot.
 */
export declare function hydrateRollbacks<T>(value: T, dir: string): T;
//# sourceMappingURL=RollbackStore.d.ts.map