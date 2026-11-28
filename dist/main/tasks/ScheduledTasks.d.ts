export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
export interface ScheduledTaskSchedule {
    frequency: ScheduleFrequency;
    /** Local wall-clock time, `HH:mm`. */
    time: string;
    /** 0 = Sunday … 6 = Saturday. Weekly only. */
    weekday?: number;
    /** 1–31. Monthly only; clamped to the last day of shorter months. */
    dayOfMonth?: number;
}
export type ScheduledTaskStatus = 'ok' | 'error' | 'missed';
export interface ScheduledTask {
    id: string;
    title: string;
    /** True when the title was typed by the user instead of derived from the prompt. */
    customTitle?: boolean;
    prompt: string;
    profileId: string;
    /** `new` opens a fresh conversation per run; `existing` reuses one. */
    sessionMode: 'new' | 'existing';
    sessionId?: string;
    schedule: ScheduledTaskSchedule;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    nextRunAt: number | null;
    lastRunAt?: number;
    lastStatus?: ScheduledTaskStatus;
    lastError?: string;
    lastSessionId?: string;
    runCount: number;
}
export interface ScheduledTaskInput {
    title?: string;
    customTitle?: boolean;
    prompt: string;
    profileId: string;
    sessionMode?: 'new' | 'existing';
    sessionId?: string;
    schedule: ScheduledTaskSchedule;
    enabled?: boolean;
}
export declare function parseClockTime(value: string): {
    hour: number;
    minute: number;
} | null;
export declare function normalizeSchedule(raw: unknown): ScheduledTaskSchedule;
export declare function normalizeInput(raw: unknown): ScheduledTaskInput;
/** Next wall-clock occurrence strictly after `after` (epoch ms). */
export declare function nextRunAfter(schedule: ScheduledTaskSchedule, after: number): number | null;
export declare function describeSchedule(schedule: ScheduledTaskSchedule): string;
export declare function loadScheduledTasks(file: string): ScheduledTask[];
export declare function saveScheduledTasks(file: string, tasks: ScheduledTask[]): void;
//# sourceMappingURL=ScheduledTasks.d.ts.map