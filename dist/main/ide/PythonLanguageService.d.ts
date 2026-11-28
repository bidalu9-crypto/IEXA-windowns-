import { EventEmitter } from 'events';
import { FileWorkspace } from './FileWorkspace';
export type PythonLanguageStatus = 'idle' | 'starting' | 'ready' | 'unavailable' | 'error' | 'cooldown';
export interface PythonLanguageRequest {
    workspaceId: string;
    method: 'open' | 'change' | 'close' | 'completion' | 'hover' | 'definition' | 'references' | 'release';
    path?: string;
    text?: string;
    version?: number;
    position?: {
        line: number;
        character: number;
    };
    context?: {
        triggerKind?: number;
        triggerCharacter?: string;
    };
    includeDeclaration?: boolean;
}
export interface PythonLanguageResult {
    status: PythonLanguageStatus;
    workspaceId?: string;
    result?: unknown;
    version?: number;
    reason?: string;
    pid?: number;
    cooldownUntil?: number;
}
interface Options {
    /** Main-process controlled unpacked resource directory. Never renderer supplied. */
    resourcePath?: string;
    /** null deliberately disables execution. Electron's executable is accepted only when explicitly supplied. */
    nodePath?: string | null;
    electronRunAsNode?: boolean;
    env?: NodeJS.ProcessEnv;
    idleMs?: number;
    requestTimeoutMs?: number;
    startupTimeoutMs?: number;
    /** Main-process/test hook; renderer cannot change resource budgets. */
    sampleRss?: (pid: number) => Promise<number | undefined>;
    rssIntervalMs?: number;
    rssLimitBytes?: number;
    cooldownMs?: number;
}
/** One lazily created Python stdio server for the selected project. Opening ordinary
 * files, starting the app, and querying status never launch a language process. */
export declare class PythonLanguageService extends EventEmitter {
    private readonly files;
    private readonly options;
    private child?;
    private workspaceId?;
    private root?;
    private status;
    private reason?;
    private cooldownUntil;
    private disposed;
    private generation;
    private nextId;
    private pending;
    private documents;
    private incoming;
    private startup?;
    private idleTimer?;
    private rssTimer?;
    private rssBusy;
    private highRssSamples;
    private stderr;
    private verifiedResource?;
    private switching;
    private stopping;
    private workspaceTokens;
    constructor(files: FileWorkspace, options?: Options);
    getStatus(workspaceId?: string): PythonLanguageResult;
    request(input: PythonLanguageRequest): Promise<PythonLanguageResult>;
    private validateText;
    private flush;
    private close;
    private changeStatus;
    private ensureStarted;
    private start;
    private settings;
    private resource;
    private node;
    private notify;
    private send;
    private rpc;
    private consume;
    private message;
    private diagnostics;
    private locations;
    private touch;
    private startRssMonitor;
    private fail;
    private stop;
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=PythonLanguageService.d.ts.map