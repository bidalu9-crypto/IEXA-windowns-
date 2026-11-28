import { EventEmitter } from 'events';
import { FileWorkspace } from './FileWorkspace';
export interface PreviewLog {
    level: string;
    message: string;
    time: number;
}
export interface PreviewState {
    workspaceId: string;
    status: 'stopped' | 'starting' | 'running' | 'error';
    url: string;
    logs: PreviewLog[];
    error?: string;
    script?: string;
    entryPath?: string;
}
/** Owns static servers and development processes independently for every authorized root. */
export declare class PreviewServerManager extends EventEmitter {
    private readonly files;
    private readonly records;
    constructor(files: FileWorkspace);
    private readonly onFileChange;
    inspect(id: string): {
        type: string;
        scripts: Array<{
            name: string;
            command: string;
        }>;
        index?: string;
        packageManager: string;
    };
    status(id: string): PreviewState;
    private record;
    private snapshot;
    private publish;
    private log;
    start(id: string, script?: string, confirmed?: boolean, entryPath?: string): Promise<PreviewState>;
    private startStatic;
    private nodeAndNpm;
    private startScript;
    private clean;
    stop(id: string): Promise<PreviewState>;
    restart(id: string, script?: string, confirmed?: boolean, entryPath?: string): Promise<PreviewState>;
    shutdown(): Promise<void>;
    shutdownSync(): void;
}
//# sourceMappingURL=PreviewServerManager.d.ts.map