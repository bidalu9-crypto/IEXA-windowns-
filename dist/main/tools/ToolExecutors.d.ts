import { ToolExecutionResult } from '../providers/types';
import { ShellKind } from './shell/ProcessManager';
import { PathPolicy } from '../security/PathSandbox';
import { NetworkPolicy } from '../security/NetworkPolicy';
export type ToolPathPolicy = Omit<PathPolicy, 'workspaceDir' | 'allowMissing'>;
/** Build a ToolExecutionResult that surfaces a local media file to the UI. */
export declare function buildMediaDisplayResult(filePath: string, workspaceDir: string, policy?: ToolPathPolicy): Promise<ToolExecutionResult>;
export declare class ShellExecutor {
    private workspaceDir;
    private readonly processes;
    private readonly policy;
    constructor(workspaceDir: string);
    execute(command: string, timeoutSec?: number, signal?: AbortSignal, shell?: ShellKind): Promise<ToolExecutionResult>;
}
export declare class FileTools {
    private readonly pathPolicy;
    constructor(pathPolicy?: ToolPathPolicy | (() => ToolPathPolicy));
    private static readonly DEFAULT_READ_CHARS;
    private static readonly MAX_READ_CHARS;
    private static readonly MAX_READ_LINES;
    private withWriteLock;
    private atomicWriteBytes;
    private atomicWriteText;
    private resolvePath;
    readFile(filePath: string, workspaceDir: string, options?: {
        offset?: number;
        lines?: number;
        maxLength?: number;
        direction?: 'head' | 'tail';
    }): Promise<ToolExecutionResult>;
    writeFile(filePath: string, content: string, workspaceDir: string, options?: {
        append?: boolean;
        createDirs?: boolean;
    }): Promise<ToolExecutionResult>;
    editFile(filePath: string, oldString: string, newString: string, workspaceDir: string, replaceAll?: boolean): Promise<ToolExecutionResult>;
}
export declare class MemoryTools {
    private readonly memoryDir;
    private readonly retriever;
    private writeQueue;
    private canonicalRoot?;
    constructor(memoryDir: string);
    private verifyRoot;
    private verifyMemoryFiles;
    private withWriteLock;
    initialize(): Promise<void>;
    writeMemory(content: string): Promise<ToolExecutionResult>;
    getMemory(keywords?: string, limit?: number): Promise<ToolExecutionResult>;
}
export declare class WebSearch {
    private readonly network;
    constructor(network?: NetworkPolicy);
    search(query: string, limit?: number, recencyDays?: number, signal?: AbortSignal): Promise<ToolExecutionResult>;
    private clean;
    private parseLinks;
    private parseBingRss;
    private parseBing;
    private parseDuck;
    private parseGoogle;
}
export declare class BrowserFetch {
    private readonly network;
    constructor(network?: NetworkPolicy);
    fetch(url: string, maxLength?: number, signal?: AbortSignal): Promise<ToolExecutionResult>;
    private stripHtml;
}
//# sourceMappingURL=ToolExecutors.d.ts.map