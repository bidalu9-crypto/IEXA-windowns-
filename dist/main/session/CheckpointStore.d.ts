import { ToolExecutionResult } from '../providers/types';
export type FileChange = NonNullable<ToolExecutionResult['fileChange']>;
export interface CheckpointSummary {
    id: string;
    sessionId: string;
    label: string;
    createdAt: number;
    files: string[];
    changeCount: number;
    bytes: number;
}
interface CheckpointRecord extends CheckpointSummary {
    /** One merged record per file: first `before` + last `afterSha256`. */
    changes: FileChange[];
}
export declare class CheckpointStore {
    private readonly directory;
    constructor(directory: string);
    private file;
    load(sessionId: string): CheckpointRecord[];
    private save;
    list(sessionId: string): CheckpointSummary[];
    append(sessionId: string, label: string, changes: FileChange[]): CheckpointSummary | undefined;
    /**
     * Rewind to (and including) the given checkpoint: every checkpoint created
     * after it is undone, newest first. Nothing is truncated unless every undo
     * succeeded, so a conflicted file leaves the history intact.
     */
    rewind(sessionId: string, checkpointId: string, roots: string[]): Promise<{
        restored: string[];
        removed: number;
    }>;
    clear(sessionId: string): void;
}
export {};
//# sourceMappingURL=CheckpointStore.d.ts.map