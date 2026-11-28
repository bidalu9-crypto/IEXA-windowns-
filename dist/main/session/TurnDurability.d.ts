export interface ResumeMessage {
    role: 'user' | 'assistant';
    content: string;
    status?: 'running' | 'paused' | 'interrupted';
    steered?: boolean;
}
export interface ResumePlan<T extends ResumeMessage> {
    /** The prompt the interrupted turn was answering; it is replayed, not re-sent. */
    userMsg: T;
    /** Everything before that prompt: the continuation replaces the partial reply. */
    existingMessages: T[];
    /** Follow-ups injected before the interruption, preserved in order. */
    steeredMessages: T[];
    /** The partial assistant turn that will be replaced by the continuation. */
    assistant: T;
    /** Prose already streamed; the resumed turn appends to it. */
    priorText: string;
}
/** Returns null when there is nothing to continue. */
export declare function planResume<T extends ResumeMessage>(messages: T[]): ResumePlan<T> | null;
export interface TurnCheckpoint {
    /** Write now (tool results and pauses use this). */
    flush(status?: 'running' | 'paused'): Promise<void>;
    /** Coalesced write for high-frequency events such as text deltas. */
    schedule(): void;
    /** Cancel the pending timer and wait for any in-flight write. */
    settle(): Promise<void>;
}
export declare function createTurnCheckpoint<T>(options: {
    snapshot: (status: 'running' | 'paused') => T[];
    save: (messages: T[]) => Promise<void>;
    delayMs?: number;
}): TurnCheckpoint;
//# sourceMappingURL=TurnDurability.d.ts.map