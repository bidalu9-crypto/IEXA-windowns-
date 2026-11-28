import { TaskScheduler } from './Scheduler';
interface TaskProfile {
    id: string;
    name?: string;
    model: string;
}
interface TaskSession {
    id: string;
    title: string;
}
interface TaskSessionStore {
    sessions: TaskSession[];
    activeSessionId: string;
}
export interface TaskRuntimeDeps {
    file: string;
    /** Resolved after listen(); null while the port or token is not ready. */
    endpoint(): {
        baseUrl: string;
        token: string;
    } | null;
    loadSettings(): {
        profiles: TaskProfile[];
    };
    loadSessionStore(): TaskSessionStore;
    saveSessionStore(store: TaskSessionStore): void;
    saveMessages(sessionId: string, messages: unknown[]): Promise<void>;
    getProjectRoot(): string | null;
    modelBindingForProfile(profile: any): any;
    broadcastSessionEvent(event: string, data: unknown): void;
}
export declare function createTaskScheduler(deps: TaskRuntimeDeps): TaskScheduler;
export {};
//# sourceMappingURL=TaskRuntime.d.ts.map