import type { BotProfile } from './BotStore';
export type TeamStatus = 'planning' | 'running' | 'completed' | 'cancelling' | 'cancelled' | 'failed' | 'interrupted';
export interface TeamPlan {
    tasks: Array<{
        botId: string;
        instruction: string;
    }>;
}
export interface TeamTask {
    botId: string;
    instruction: string;
    status: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
    sessionId?: string;
    result?: string;
    error?: string;
}
export interface Team {
    id: string;
    goal: string;
    botIds: string[];
    status: TeamStatus;
    created: number;
    updated: number;
    plan?: TeamPlan;
    tasks: TeamTask[];
    error?: string;
}
export interface BotTeamsDependencies {
    getBot(id: string): BotProfile | undefined;
    /** planning=true MUST be implemented by the runner with tools disabled. */
    run(botId: string, prompt: string, signal: AbortSignal, planning: boolean, onSession: (id: string) => void): Promise<string>;
}
/** Durable, single-process scheduler. Persisted work is never replayed on startup. */
export declare class BotTeams {
    readonly root: string;
    private readonly deps;
    private readonly store;
    private readonly teams;
    private readonly jobs;
    constructor(root: string, deps: BotTeamsDependencies);
    list(): Team[];
    get(id: string): Team | undefined;
    start(goal: string, botIds: string[]): Team;
    cancel(id: string): Promise<Team>;
    stopAll(): Promise<void>;
    private persist;
    private parsePlan;
    private taskPrompt;
    private execute;
}
//# sourceMappingURL=BotTeams.d.ts.map