export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'disabled';
export interface UpdateEvent {
    status: UpdateStatus;
    version?: string;
    percent?: number;
    message?: string;
    at: number;
}
export interface UpdateAdapter {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(event: string, listener: (...args: any[]) => void): unknown;
    checkForUpdates(): Promise<unknown>;
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(): void;
}
export interface UpdateServiceOptions {
    adapter: UpdateAdapter;
    /** False in development or when the build has no publish configuration. */
    enabled: boolean;
    currentVersion: string;
    onStatus?: (event: UpdateEvent) => void;
    /** Injectable timers keep tests deterministic. */
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancelSchedule?: (handle: unknown) => void;
    initialDelayMs?: number;
}
export interface UpdateState {
    status: UpdateStatus;
    version?: string;
    percent?: number;
    message?: string;
    checkedAt?: number;
}
export declare class UpdateService {
    private readonly options;
    private state;
    private scheduled;
    private disposed;
    constructor(options: UpdateServiceOptions);
    private publish;
    /** Schedule the first check a short while after startup. */
    start(): void;
    check(silent?: boolean): Promise<void>;
    download(): Promise<void>;
    install(): void;
    getState(): UpdateState;
    dispose(): void;
}
//# sourceMappingURL=UpdateService.d.ts.map