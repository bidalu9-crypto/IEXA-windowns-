import { TraceEvent } from './Trace';
export interface TraceStoreOptions {
    maxFileBytes?: number;
    maxReadBytes?: number;
    maxFiles?: number;
}
export declare class TraceStore {
    private readonly root;
    private readonly maxFileBytes;
    private readonly maxReadBytes;
    private readonly maxFiles;
    constructor(root: string, options?: TraceStoreOptions);
    private file;
    /** Current file plus maxFiles-1 numbered backups, newest first. */
    private rotate;
    append(sessionId: string, events: TraceEvent[]): void;
    /** Total disk reads across current file and backups are capped by maxReadBytes. */
    read(sessionId: string, limit?: number): TraceEvent[];
}
//# sourceMappingURL=TraceStore.d.ts.map