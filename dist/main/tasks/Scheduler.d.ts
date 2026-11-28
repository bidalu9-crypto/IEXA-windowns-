import { ScheduledTask } from './ScheduledTasks';
export interface SchedulerHost {
    /** Create a conversation already bound to the task's model. */
    createSession(input: {
        title: string;
        profileId: string;
    }): Promise<string>;
    /** Re-point an existing conversation at the task's model. */
    bindSession(sessionId: string, profileId: string): Promise<void> | void;
    /** Send one prompt and resolve when the turn reaches its terminal state. */
    sendPrompt(sessionId: string, prompt: string): Promise<void>;
}
export interface SchedulerOptions {
    file: string;
    host: SchedulerHost;
    tickMs?: number;
    now?: () => number;
    /** How late a due task may still run (default 10 minutes). */
    graceMs?: number;
    log?: (message: string) => void;
}
export declare class TaskScheduler {
    private readonly options;
    private tasks;
    private timer;
    private ticking;
    private readonly running;
    private readonly listeners;
    private readonly host;
    private readonly tickMs;
    private readonly graceMs;
    private readonly now;
    private readonly log;
    constructor(options: SchedulerOptions);
    list(): ScheduledTask[];
    find(id: string): ScheduledTask | undefined;
    onChange(listener: (task: ScheduledTask) => void): () => void;
    create(raw: unknown, defaults?: {
        profileId?: string;
    }): ScheduledTask;
    update(id: string, patch: Record<string, unknown>): ScheduledTask;
    remove(id: string): boolean;
    /** Run a task now without disturbing its schedule. */
    runNow(id: string): Promise<ScheduledTask>;
    start(): void;
    stop(): void;
    /** Exposed for tests: one deterministic pass over the due list. */
    tick(): Promise<void>;
    private execute;
    private rollForward;
    private recoverMissed;
    private repairSchedule;
    private require;
    private persist;
    private emit;
}
//# sourceMappingURL=Scheduler.d.ts.map