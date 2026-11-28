export declare function controlNativeIsolatedWorkspaces(operation: 'pause' | 'resume', signal?: AbortSignal): Promise<({
    ok: boolean;
    closed: boolean;
    desktopName?: undefined;
    operation?: undefined;
    error?: undefined;
} | {
    ok: boolean;
    desktopName: string;
    operation: "pause" | "resume";
    closed?: undefined;
    error?: undefined;
} | {
    ok: boolean;
    desktopName: string;
    error: string;
    closed?: undefined;
    operation?: undefined;
})[]>;
interface WorkspaceReady {
    desktopName: string;
    pid: number;
    hostPid: number;
    port: number;
    jobBound: boolean;
}
/** Native desktop UI isolation only. Existing user windows, filesystem/network and
 * account credentials are not moved or sandboxed. Never switch the input desktop. */
export declare class NativeIsolatedWorkspace {
    private readonly executableOverride?;
    private child?;
    private pending?;
    private ready?;
    private closed;
    private failed;
    private directory?;
    constructor(_appRoot?: string, executableOverride?: string | undefined);
    ensureStarted(signal?: AbortSignal): Promise<WorkspaceReady>;
    private executable;
    private start;
    private cleanupAttempt;
    operatorControl(operation: 'pause' | 'resume', signal?: AbortSignal): Promise<{
        ok: boolean;
        closed: boolean;
        desktopName?: undefined;
        operation?: undefined;
        error?: undefined;
    } | {
        ok: boolean;
        desktopName: string;
        operation: "pause" | "resume";
        closed?: undefined;
        error?: undefined;
    } | {
        ok: boolean;
        desktopName: string;
        error: string;
        closed?: undefined;
        operation?: undefined;
    }>;
    close(): void;
    diagnostics(): {
        directory: string | undefined;
        ready: WorkspaceReady | undefined;
        closed: boolean;
        failed: boolean;
    };
}
export {};
//# sourceMappingURL=NativeIsolatedWorkspace.d.ts.map