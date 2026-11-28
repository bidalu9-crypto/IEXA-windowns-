export interface DesktopLease {
    owner: string;
    operationId: string;
    acquiredAt: number;
    signal: AbortSignal;
}
/** One process-wide queue, shared by parent and child ToolRuntime instances.
 * Never release the lease until transport cancellation has settled. */
export declare class DesktopControlScheduler {
    private readonly leaseMs;
    private queue;
    private active?;
    private activeController?;
    private paused;
    pause(): void;
    resume(): void;
    constructor(leaseMs?: number);
    snapshot(): {
        paused: boolean;
        active: {
            owner: string;
            operationId: string;
            acquiredAt: number;
        } | undefined;
        queued: {
            owner: string;
            operationId: string;
        }[];
    };
    run<T>(owner: string, operationId: string, signal: AbortSignal | undefined, run: (lease: DesktopLease) => Promise<T>): Promise<T>;
    private drain;
}
export declare const desktopControlScheduler: DesktopControlScheduler;
//# sourceMappingURL=DesktopControlScheduler.d.ts.map