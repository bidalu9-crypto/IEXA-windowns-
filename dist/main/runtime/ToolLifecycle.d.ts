export type ToolExecutionStatus = 'queued' | 'awaiting_approval' | 'running' | 'cancelling' | 'completed' | 'failed' | 'denied' | 'cancelled' | 'timed_out';
export interface ToolLifecycleEvent {
    desktop?: import('../tools/desktop/DesktopControlSession').DesktopEvent;
    version: 1;
    runId: string;
    sequence: number;
    sessionId: string;
    id: string;
    name: string;
    status: ToolExecutionStatus;
    timestamp: number;
    startedAt?: number;
    durationMs?: number;
}
export declare const TERMINAL_TOOL_STATES: ReadonlySet<ToolExecutionStatus>;
/** One monotonic sequence per run; never carries tool arguments, secrets or output. */
export declare class ToolLifecycle {
    readonly runId: `${string}-${string}-${string}-${string}-${string}`;
    private sequence;
    private readonly states;
    transition(sessionId: string, id: string, name: string, status: ToolExecutionStatus): ToolLifecycleEvent;
    progress(sessionId: string, id: string, desktop: NonNullable<ToolLifecycleEvent['desktop']>): ToolLifecycleEvent;
    snapshot(): ToolLifecycleEvent[];
}
//# sourceMappingURL=ToolLifecycle.d.ts.map