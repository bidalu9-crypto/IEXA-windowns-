import { ToolLifecycleEvent } from './ToolLifecycle';
import { AgentToolDefinition, ToolExecutionResult } from '../providers/types';
export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';
export interface ToolExecutionContext {
    signal: AbortSignal;
    sessionId: string;
    toolCallId: string;
    workspaceDir: string;
    onToolState?: (event: ToolLifecycleEvent) => void;
    onCancellation?: (reason: 'cancelled' | 'timed_out') => void;
}
export interface ToolDefinition extends AgentToolDefinition {
    risk: ToolRisk;
    parallelSafe: boolean;
    cancellable: boolean;
    requiresApproval: boolean;
    timeoutMs?: number;
    filesystemAccess?: boolean;
    networkAccess?: boolean;
    execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}
export declare function canonicalToolName(name: string): string;
export declare class ToolRegistry {
    private definitions;
    register(tool: ToolDefinition): void;
    get(name: string): ToolDefinition | undefined;
    has(name: string): boolean;
    list(): ToolDefinition[];
    /**
     * A wrong tool name is usually a near miss (`edit`, `read_file`, `Write`).
     * Naming the closest real tool lets the model recover in one turn instead of
     * guessing again, which is cheaper than a full retry.
     */
    private suggest;
    /** Validate in place; returns the human-readable list of clamped arguments. */
    validate(name: string, args: Record<string, unknown>): string[];
}
//# sourceMappingURL=ToolRegistry.d.ts.map