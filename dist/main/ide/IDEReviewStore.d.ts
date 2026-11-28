import { EventEmitter } from 'events';
import { FileWorkspace } from './FileWorkspace';
export interface IDEReviewRecord {
    id: string;
    workspaceId: string;
    path: string;
    before: string;
    after: string;
    beforeExists: boolean;
    revision: string;
    createdAt: number;
    updatedAt: number;
}
export interface IDEReviewAction {
    reviewId: string;
    action: 'accept' | 'reject';
    revision: string;
    content?: string;
    baseline?: string;
    complete?: boolean;
    remove?: boolean;
}
/** Called while the ordinary Agent file tool owns its existing write lock.
 * Full snapshots stay local to the IDE; tool/SSE summaries remain bounded. */
export declare function recordIDEFileChange(absolutePath: string, before: string, after: string, beforeExists: boolean, afterBytes: Buffer): void;
export declare class IDEReviewStore extends EventEmitter {
    private readonly files;
    private readonly stateFile?;
    private readonly records;
    private timer?;
    private persistence;
    private disposed;
    constructor(files: FileWorkspace, stateFile?: string | undefined);
    record(absolutePath: string, before: string, after: string, beforeExists: boolean, revision: string): void;
    list(workspaceId: string): {
        records: Omit<IDEReviewRecord, 'before' | 'after'>[];
    };
    read(workspaceId: string, reviewId: string): IDEReviewRecord;
    action(workspaceId: string, input: IDEReviewAction): Promise<{
        record: IDEReviewRecord | null;
        content?: string;
        revision?: string;
        removed?: boolean;
    }>;
    private trim;
    private persist;
    private flush;
    dispose(): Promise<void>;
}
//# sourceMappingURL=IDEReviewStore.d.ts.map