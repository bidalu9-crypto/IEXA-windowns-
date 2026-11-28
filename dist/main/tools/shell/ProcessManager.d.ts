import { ChildProcess } from 'child_process';
import { ToolExecutionResult } from '../../providers/types';
export interface ProcessPolicy {
    timeoutMs: number;
    maxOutputBytes: number;
    killGracePeriodMs: number;
}
export type ShellKind = 'auto' | 'cmd' | 'powershell' | 'pwsh';
export declare class ProcessManager {
    run(command: string, cwd: string, signal: AbortSignal, policy: ProcessPolicy, shell?: ShellKind): Promise<ToolExecutionResult>;
    private launch;
}
/**
 * Terminate exactly one process tree and wait for the cleanup helper.
 *
 * libuv resolves a bare executable name through PATH, and it throws
 * synchronously (`spawn UNKNOWN`) when the resolved file cannot be executed —
 * it never emits an asynchronous `error`. A rewritten or shadowed PATH
 * (Electron inherits one from its launcher) therefore used to skip taskkill
 * entirely: the catch block resolved at once, only the direct child was killed,
 * and the command's real work kept running while the caller was told it had
 * been cancelled. Retry with the absolute system path; only when no candidate
 * can start does the direct-child fallback stand.
 */
export declare function terminateProcessTree(child: ChildProcess, gracePeriodMs: number): Promise<void>;
//# sourceMappingURL=ProcessManager.d.ts.map