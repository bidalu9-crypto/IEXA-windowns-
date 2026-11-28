export type GoalStatus = 'active' | 'done' | 'blocked';
export interface GoalRecord {
    sessionId: string;
    objective: string;
    doneWhen: string;
    status: GoalStatus;
    notes: string[];
    createdAt: number;
    updatedAt: number;
}
/**
 * The objective used to evaporate at the first compaction: the summary kept
 * the recent turns and dropped the reason they existed. A goal is stored
 * outside the transcript and re-injected every turn, so it survives both
 * compaction and a process restart.
 */
export declare class GoalStore {
    private readonly store;
    private cache?;
    constructor(filePath: string);
    private load;
    private save;
    get(sessionId: string): GoalRecord | null;
    set(sessionId: string, objective: string, doneWhen?: string): GoalRecord;
    update(sessionId: string, patch: {
        status?: GoalStatus;
        note?: string;
        doneWhen?: string;
    }): GoalRecord | null;
    clear(sessionId: string): boolean;
    format(record: GoalRecord): string;
    /** Fresh each turn, so a compaction between turns cannot drop the objective. */
    promptBlock(sessionId: string): string;
}
//# sourceMappingURL=GoalStore.d.ts.map