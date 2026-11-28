export type HookPhase = 'preToolUse' | 'postToolUse';
export interface HookSpec {
    phase: HookPhase;
    script: string;
    tools?: string[];
    timeoutMs: number;
}
export interface HookPayload {
    phase: HookPhase;
    tool: string;
    args: Record<string, unknown>;
    sessionId: string;
    result?: {
        success: boolean;
        output: string;
        executionStatus?: string;
    };
}
export interface HookOutcome {
    block: boolean;
    reason?: string;
    errors: string[];
}
/** Read and validate the workspace hook configuration. Invalid entries fail closed. */
export declare function loadHookSpecs(workspaceDir: string): HookSpec[];
/** Run every matching hook in order. preToolUse blocking stops the chain. */
export declare function runHooks(specs: HookSpec[], payload: HookPayload, cwd: string, signal?: AbortSignal): Promise<HookOutcome>;
//# sourceMappingURL=HookRunner.d.ts.map