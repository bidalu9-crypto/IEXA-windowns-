import * as http from 'http';
/** Serializes state transitions per upload, with bounded aggregate reservations. */
export declare class UploadRoutes {
    private readonly workspace;
    private entries;
    private inflight;
    private locks;
    private timer;
    constructor(workspace: string);
    close(): void;
    private discard;
    private prune;
    private directory;
    private validatePart;
    private cleanupStaleFiles;
    private lock;
    private entry;
    handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, owner: string): Promise<boolean>;
    private handleAdmitted;
}
//# sourceMappingURL=UploadRoutes.d.ts.map