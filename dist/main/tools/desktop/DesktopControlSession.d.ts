import { ToolExecutionResult } from '../../providers/types';
import { DesktopControlScheduler } from './DesktopControlScheduler';
export type DesktopPhase = 'queued' | 'observe' | 'resolve' | 'action_start' | 'action_end' | 'verify' | 'completed' | 'failed' | 'takeover' | 'cancelled';
export interface DesktopControlStatus {
    mode: string;
    backend: string;
    focusPolicy: string;
    capability: string;
    physicalInput: boolean;
    providerMayChangeFocus: boolean;
    noForegroundFallback: boolean;
}
export interface DesktopEvent {
    version: 1;
    operationId: string;
    sequence: number;
    phase: DesktopPhase;
    timestamp: number;
    action: string;
    verified?: boolean;
    step?: number;
    totalSteps?: number;
    dispatchedActions?: number;
    completedSteps?: number;
    inputMayHaveExecuted?: boolean;
    control?: DesktopControlStatus;
}
export interface DesktopContext {
    owner: string;
    operationId?: string;
    onEvent?: (event: DesktopEvent) => void;
}
type Transport = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecutionResult>;
/** Control plane. Snapshots are process-local capabilities, never replayed from disk.
 * Journal stores phases only: no typed text, screenshots, element names or secrets. */
export declare class DesktopControlSession {
    private readonly transport;
    private readonly scheduler;
    private readonly journalDir?;
    private owners;
    /** A new model run gets no reusable input capability. The durable journal remains available for recovery diagnostics. */
    reset(): void;
    constructor(transport: Transport, scheduler?: DesktopControlScheduler, journalDir?: string | undefined);
    private journalPath;
    private recover;
    execute(args: Record<string, unknown>, signal: AbortSignal | undefined, context: DesktopContext): Promise<ToolExecutionResult>;
}
export {};
//# sourceMappingURL=DesktopControlSession.d.ts.map