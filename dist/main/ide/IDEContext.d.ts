import type { AgentRuntime } from '../runtime/AgentRuntime';
import type { AgentToolDefinition } from '../providers/types';
export declare const IDE_CONTEXT_LIMITS: Readonly<{
    projects: 16;
    content: 16000;
    selection: 10000;
    logEntries: 16;
    logLine: 240;
    errorEntries: 12;
    errorLine: 320;
}>;
export interface IDEContextSnapshot {
    updatedAt: number;
    root: string;
    activeFile: string;
    content: string;
    contentTruncated: boolean;
    selectedCode: string;
    selectionTruncated: boolean;
    cursor: {
        line: number;
        column: number;
    } | null;
    unsaved: boolean;
    previewUrl: string;
    serverStatus: string;
    recentLogs: string[];
    webErrors: string[];
    languageStatus: string;
    openFiles: {
        path: string;
        dirty: boolean;
    }[];
    languageDiagnostics: {
        path: string;
        message: string;
        severity: string;
        line: number;
        column: number;
    }[];
}
/** The caller must resolve workspaceId through the host's authorized workspace registry. */
export declare function setIDEContext(root: string, input: unknown): IDEContextSnapshot;
/** Used when creating a project-bound chat or terminal through existing APIs. */
export declare function resolveIDEWorkspaceRoot(input: unknown): string;
/** Exact-root lookup prevents the IDE from retargeting an existing conversation. */
export declare function getIDEContextForRoot(root: string | null | undefined): string;
export declare const ideContextToolDefinition: AgentToolDefinition;
/** Reuses the existing runtime registry, permissions, cancellation and tool loop. */
export declare function registerIDEContextTool(runtime: Pick<AgentRuntime, 'registerDynamicTool'>, root: string): void;
export declare function clearIDEContext(root?: string): void;
/** Main-process preview events remain available when the IDE renderer is hidden. */
export declare function appendIDEDiagnostic(root: string, diagnostic: {
    message?: unknown;
    level?: unknown;
    source?: unknown;
    line?: unknown;
}): void;
export declare function updateIDERuntime(root: string, update: {
    url?: unknown;
    status?: unknown;
    logs?: unknown;
}): void;
//# sourceMappingURL=IDEContext.d.ts.map