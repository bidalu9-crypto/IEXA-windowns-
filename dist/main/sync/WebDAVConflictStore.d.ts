export type ConflictResolution = 'local' | 'remote' | 'merge';
export type ConflictStatus = 'pending' | 'resolved';
export interface SyncConflictRecord {
    id: string;
    version: 1;
    key: string;
    localPath: string;
    remotePath: string;
    remoteCopyPath: string;
    deviceId: string;
    createdAt: number;
    updatedAt: number;
    status: ConflictStatus;
    resolution?: ConflictResolution;
    resolvedAt?: number;
}
export declare class WebDAVConflictStore {
    private readonly root;
    private readonly workspace;
    private readonly index;
    constructor(workspaceDir: string);
    private validate;
    private state;
    preserve(key: string, localPath: string, remotePath: string, content: Buffer): SyncConflictRecord;
    list(includeResolved?: boolean): SyncConflictRecord[];
    get(id: string): SyncConflictRecord | null;
    resolve(id: string, resolution: ConflictResolution): SyncConflictRecord | null;
}
//# sourceMappingURL=WebDAVConflictStore.d.ts.map