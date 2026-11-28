export type TerminalShell = 'cmd' | 'powershell' | 'bash' | 'wsl';
interface TerminalChunk {
    seq: number;
    text: string;
}
export interface TerminalSessionInfo {
    id: string;
    shell: TerminalShell;
    cwd: string;
    createdAt: number;
    endedAt?: number;
    exitCode?: number | null;
    running: boolean;
    cols: number;
    rows: number;
}
export declare const DEFAULT_MAX_ACTIVE_TERMINALS = 8;
/**
 * Persistent shell processes for the desktop terminal workbench. The process
 * owns its cwd and environment, so state such as `cd`, variables and activated
 * virtual environments remains available across commands in one session.
 */
export declare class TerminalManager {
    private readonly maxActive;
    private readonly sessions;
    constructor(maxActive?: number);
    create(cwd: string, requestedShell?: string): TerminalSessionInfo;
    list(): TerminalSessionInfo[];
    output(id: string, after?: number): {
        chunks: TerminalChunk[];
        lastSeq: number;
        running: boolean;
    };
    write(id: string, input: string, appendNewline?: boolean): void;
    resize(id: string, cols: number, rows: number): void;
    terminate(id: string): Promise<void>;
    shutdown(): Promise<void>;
    shutdownSync(): void;
    private get;
    private append;
    private info;
    private resolveShell;
    private commandFor;
    private trimSessions;
    private terminateRecord;
    private finalize;
}
export {};
//# sourceMappingURL=TerminalManager.d.ts.map