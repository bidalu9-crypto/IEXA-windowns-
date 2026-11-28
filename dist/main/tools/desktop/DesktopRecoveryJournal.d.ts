export interface RecoveryEvent {
    version: 1;
    operationId: string;
    phase: string;
    timestamp: number;
    action?: string;
    dispatchedActions?: number;
    completedSteps?: number;
    inputMayHaveExecuted?: boolean;
    verified?: boolean;
}
export interface DesktopRecoveryOperation {
    operationId: string;
    phase: string;
    timestamp: number;
    action?: string;
    interrupted: boolean;
    inputMayHaveExecuted: boolean;
    dispatchedActions: number;
    completedSteps: number;
}
export interface DesktopRecoveryState extends Partial<DesktopRecoveryOperation> {
    unresolvedOperations: DesktopRecoveryOperation[];
    unresolvedOperationCount: number;
    unresolvedOperationsTruncated: boolean;
    journalIntegrity: 'complete' | 'partial';
    bytesScanned: number;
    replayPolicy: 'observe_and_verify_no_automatic_replay';
}
/** Scan the whole WAL in bounded chunks. A newer queued/read-only operation must
 * never erase an earlier uncertain write, even when it lies outside the last 64KB.
 * Retain only unresolved effects in memory; never load text, selectors or capabilities. */
export declare function readDesktopRecovery(file: string | undefined): DesktopRecoveryState | undefined;
/** Separate any torn tail before append, so it cannot swallow the next valid event.
 * Start intents and terminal outcomes are fsynced before dispatch/return respectively. */
export declare function appendDesktopRecoveryEvent(file: string, event: RecoveryEvent): void;
//# sourceMappingURL=DesktopRecoveryJournal.d.ts.map