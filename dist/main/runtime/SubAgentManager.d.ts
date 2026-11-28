import { AgentLoopCallbacks, AgentToolDefinition } from '../providers/types';
import { TranscriptRecorder } from '../session/TranscriptRecorder';
import { PermissionMode } from '../security/PermissionManager';
import { ToolExecutionStatus } from './ToolLifecycle';
import { ToolDefinition } from './ToolRegistry';
type Status = 'idle' | 'queued' | 'running' | 'awaiting_approval' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'closed';
export interface ChildMessage {
    role: string;
    content: string;
    thinking?: string;
    toolCalls?: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
        executionStatus?: ToolExecutionStatus;
        result?: {
            output: string;
            success: boolean;
            executionStatus?: ToolExecutionStatus;
        };
    }>;
    transcript?: ReturnType<TranscriptRecorder['snapshot']>;
}
export interface SubAgentRecord {
    id: string;
    parentId: string;
    rootSessionId: string;
    nickname: string;
    depth: number;
    status: Status;
    revision: number;
    createdAt: number;
    updatedAt: number;
    prompt: string;
    context: string;
    model: string;
    workspaceDir: string;
    isolation: 'shared';
    messages: ChildMessage[];
    output: string;
    error?: string;
    pendingInputs: string[];
    inputTokens: number;
    outputTokens: number;
}
export type SubAgentSummary = Omit<SubAgentRecord, 'messages' | 'context' | 'pendingInputs'> & {
    pendingCount: number;
};
export interface ChildRuntime {
    initialize(): Promise<void>;
    cancel(): void;
    setPermissionMode(mode: PermissionMode): void;
    run(request: {
        message: string;
        tools: AgentToolDefinition[];
        callbacks: AgentLoopCallbacks;
    }): Promise<void>;
    toolDefinitions(): AgentToolDefinition[];
    seedHistoryFromChat(messages: ChildMessage[]): void;
    setSessionContext(context: string, placement?: 'message' | 'system'): void;
    contextSnapshot(): string;
}
export interface SubAgentOptions {
    rootSessionId: string;
    directory: string;
    model: string;
    workspaceDir: string;
    factory: (record: SubAgentRecord, manager: SubAgentManager) => ChildRuntime;
    rootContext: () => string;
    onChange?: (agent: SubAgentSummary) => void;
    onUsage?: (usage: {
        inputTokens: number;
        outputTokens: number;
    }) => void;
    maxAgents?: number;
    maxDepth?: number;
}
/** One ownership tree per root session. No external execution resumes on load. */
export declare class SubAgentManager {
    private readonly options;
    private readonly entries;
    private readonly store;
    private readonly listeners;
    private flushTimer?;
    private stopping;
    private storageError?;
    constructor(options: SubAgentOptions);
    static storePath(directory: string, rootSessionId: string): string;
    static read(directory: string, rootSessionId: string): SubAgentRecord[];
    private static validateRecords;
    static summary(record: SubAgentRecord): SubAgentSummary;
    list(): SubAgentSummary[];
    detail(id: string): SubAgentRecord;
    hasActiveWork(): boolean;
    private require;
    private owned;
    private persist;
    private changed;
    private message;
    private requireOpenParent;
    private requireWritable;
    private canOpen;
    spawn(owner: string, message: string, forkContext?: boolean, nickname?: string): SubAgentSummary;
    send(owner: string, id: string, message: string, interrupt?: boolean): {
        id: string;
        queued: boolean;
    };
    private start;
    wait(owner: string, ids: string[], timeoutMs?: number, signal?: AbortSignal): Promise<{
        agents: SubAgentSummary[];
        timedOut: boolean;
    }>;
    private descendants;
    cancelDescendants(owner: string): void;
    settleDescendants(owner: string): Promise<void>;
    cancelAll(): void;
    settleAll(): Promise<void>;
    close(owner: string, id: string): Promise<SubAgentSummary & {
        previousStatus: Status;
    }>;
    resume(owner: string, id: string): SubAgentSummary;
    setPermissionMode(mode: PermissionMode): void;
    definitions(owner: string): ToolDefinition[];
}
export {};
//# sourceMappingURL=SubAgentManager.d.ts.map