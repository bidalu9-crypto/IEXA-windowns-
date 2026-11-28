export interface DedupeMessage {
    role: 'user' | 'assistant';
    content?: string;
    timestamp?: number;
}
export interface DedupeStore {
    loadSync(id: string): DedupeMessage[] | null;
    saveSync(id: string, value: DedupeMessage[]): void;
}
/**
 * Returns how many sessions were repaired. A broken file is skipped: one bad
 * session must never stop the server from starting.
 */
export declare function removeDuplicatePrompts(workspaceDir: string, store: DedupeStore): number;
//# sourceMappingURL=DuplicatePrompts.d.ts.map