import { ToolDefinition } from '../runtime/ToolRegistry';
export interface PermissionRequest {
    sessionId: string;
    tool: ToolDefinition;
    args: Record<string, unknown>;
    signal?: AbortSignal;
    toolCallId?: string;
    runId?: string;
    onAwaitingApproval?: () => void;
}
export type PermissionDecision = 'allow_once' | 'allow_session' | 'allow' | 'deny';
export type PermissionMode = 'plan' | 'ask' | 'risk' | 'full';
export type PermissionResolver = (request: PermissionRequest) => Promise<PermissionDecision>;
export interface PendingPermission {
    id: string;
    request: PermissionRequest;
    createdAt: number;
    expiresAt: number;
}
type PendingListener = (pending: PendingPermission) => void;
/** Bridges a runtime permission wait to HTTP/SSE without exposing Tool internals. */
export declare class PermissionBroker {
    private readonly timeoutMs;
    private readonly pending;
    private readonly listeners;
    constructor(timeoutMs?: number);
    request(request: PermissionRequest): Promise<PermissionDecision>;
    subscribe(sessionId: string, listener: PendingListener): () => void;
    list(sessionId?: string): PendingPermission[];
    resolve(id: string, decision: PermissionDecision): boolean;
    cancelSession(sessionId: string): void;
}
export declare class PermissionManager {
    private readonly auditDir;
    private readonly resolver?;
    private mode;
    private grants;
    constructor(auditDir: string, resolver?: PermissionResolver | undefined, mode?: PermissionMode);
    setMode(mode: PermissionMode): void;
    grant(sessionId: string, toolName: string): void;
    revokeSession(sessionId: string): void;
    authorize(request: PermissionRequest): Promise<void>;
    private audit;
}
export {};
//# sourceMappingURL=PermissionManager.d.ts.map