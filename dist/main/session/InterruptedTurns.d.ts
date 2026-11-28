export interface UnfinishedMessage {
    role: 'user' | 'assistant';
    status?: 'running' | 'paused' | 'interrupted';
}
export interface UnfinishedStore {
    loadSync(id: string): UnfinishedMessage[] | null;
    saveSync(id: string, value: UnfinishedMessage[]): void;
}
/**
 * Returns how many sessions were repaired. A broken file is skipped: one bad
 * session must never stop the server from starting.
 */
export declare function markInterruptedTurns(workspaceDir: string, store: UnfinishedStore): number;
//# sourceMappingURL=InterruptedTurns.d.ts.map