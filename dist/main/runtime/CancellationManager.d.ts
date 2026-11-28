export declare class CancellationManager {
    private controllers;
    begin(sessionId: string): AbortSignal;
    signal(sessionId: string): AbortSignal | undefined;
    cancel(sessionId: string): void;
    finish(sessionId: string): void;
}
//# sourceMappingURL=CancellationManager.d.ts.map