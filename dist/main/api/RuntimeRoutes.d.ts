import * as http from 'http';
import { URL } from 'url';
import { PermissionBroker, PermissionMode } from '../security/PermissionManager';
import { QuestionBroker, PendingQuestion } from '../runtime/QuestionBroker';
interface RuntimeAgent {
    getState(): unknown;
    getObservability(): unknown;
    setPermissionMode(mode: PermissionMode): void;
    grantPermission(toolName: string): void;
    isRunning(): boolean;
    cancel(): void;
    pause(): boolean;
    resume(): Promise<boolean>;
    isPaused(): boolean;
}
export interface RuntimeRoutesContext {
    agents: Map<string, RuntimeAgent>;
    permissionBroker: PermissionBroker;
    permissionPayload(item: Parameters<RuntimeRoutesContext['permissionBroker']['list']>[0] extends never ? never : any): Record<string, unknown>;
    questionBroker: QuestionBroker;
    questionPayload(item: PendingQuestion): Record<string, unknown>;
    getPermissionMode(): PermissionMode;
    setPermissionMode(mode: PermissionMode): void;
    normalizePermissionMode(value: unknown): PermissionMode;
    loadJobs(): unknown[];
    /** Purge settled job records; without a session id the whole audit trail is cleared. */
    clearJobs(sessionId?: string): {
        removed: number;
        remaining: number;
    };
    jobsRetention: {
        days: number;
        perSession: number;
        total: number;
    };
    readTraces(sessionId: string, limit: number): unknown[];
    cancelSession(sessionId: string): void;
    clearRunningSession(sessionId: string): void;
    /** Includes initialization/persistence outside AgentRuntime.run(). */
    isSessionRunning?(sessionId: string): boolean;
    cancelLiveJobs(sessionId: string, settled?: boolean): void;
    /** Objective kept outside the transcript so compaction cannot drop it. */
    getGoal(sessionId: string): unknown;
    clearGoal(sessionId: string): boolean;
    /** Active persistent shells belonging to this conversation. */
    listShellSessions(sessionId: string): unknown[];
    closeShellSession(id: string, sessionId: string): Promise<{
        output: string;
        success: boolean;
    }>;
}
export declare function handleRuntimeRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: RuntimeRoutesContext): Promise<boolean>;
export {};
//# sourceMappingURL=RuntimeRoutes.d.ts.map