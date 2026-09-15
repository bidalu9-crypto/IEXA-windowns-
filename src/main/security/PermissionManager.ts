import { appendFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { IexaError, redactSecrets } from '../errors/IexaError';
import { ToolDefinition, ToolRisk } from '../runtime/ToolRegistry';

export interface PermissionRequest { sessionId: string; tool: ToolDefinition; args: Record<string, unknown>; signal?: AbortSignal; toolCallId?: string; runId?: string; onAwaitingApproval?: () => void; }
export type PermissionDecision = 'allow_once' | 'allow_session' | 'allow' | 'deny';
export type PermissionMode = 'ask' | 'risk' | 'full';
export type PermissionResolver = (request: PermissionRequest) => Promise<PermissionDecision>;

export interface PendingPermission {
  id: string;
  request: PermissionRequest;
  createdAt: number;
  expiresAt: number;
}

type PendingListener = (pending: PendingPermission) => void;

/** Bridges a runtime permission wait to HTTP/SSE without exposing Tool internals. */
export class PermissionBroker {
  private readonly pending = new Map<string, { item: PendingPermission; resolve: (decision: PermissionDecision) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();
  private readonly listeners = new Map<string, Set<PendingListener>>();

  constructor(private readonly timeoutMs = 120_000) {}

  request(request: PermissionRequest): Promise<PermissionDecision> {
    if (request.signal?.aborted) return Promise.resolve('deny');
    const now = Date.now();
    const item: PendingPermission = {
      id: `perm_${now.toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      request,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => this.resolve(item.id, 'deny'), this.timeoutMs);
      const abort = () => { this.resolve(item.id, 'deny'); };
      const cleanup = () => request.signal?.removeEventListener('abort', abort);
      this.pending.set(item.id, { item, resolve, timer, cleanup });
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) { abort(); return; }
      for (const listener of this.listeners.get(request.sessionId) || []) {
        try { listener(item); } catch { /* Disconnected observers do not resolve or lose the request. */ }
      }
    });
  }

  subscribe(sessionId: string, listener: PendingListener): () => void {
    const listeners = this.listeners.get(sessionId) || new Set<PendingListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      const current = this.listeners.get(sessionId);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(sessionId);
    };
  }

  list(sessionId?: string): PendingPermission[] {
    return [...this.pending.values()]
      .map(({ item }) => item)
      .filter((item) => !sessionId || item.request.sessionId === sessionId);
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.cleanup();
    this.pending.delete(id);
    entry.resolve(decision === 'allow' ? 'allow_session' : decision);
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const item of this.list(sessionId)) this.resolve(item.id, 'deny');
  }
}

export class PermissionManager {
  private grants = new Map<string, Set<string>>();
  constructor(private readonly auditDir: string, private readonly resolver?: PermissionResolver, private mode: PermissionMode = 'risk') {}

  setMode(mode: PermissionMode): void { this.mode = mode; }

  grant(sessionId: string, toolName: string): void {
    const names = this.grants.get(sessionId) || new Set<string>(); names.add(toolName); this.grants.set(sessionId, names);
  }
  revokeSession(sessionId: string): void { this.grants.delete(sessionId); }
  async authorize(request: PermissionRequest): Promise<void> {
    const checkAbort = () => { if (request.signal?.aborted) throw new IexaError('TOOL_CANCELLED', 'RUNTIME', 'Tool cancelled during permission approval.'); };
    checkAbort();
    const requiresApproval = this.mode === 'ask'
      ? !['todo_write', 'file_read', 'memory_get', 'project_instructions'].includes(request.tool.name)
      : this.mode === 'full'
        ? false
        : request.tool.requiresApproval || request.tool.risk === 'high' || request.tool.risk === 'critical';
    let decision: PermissionDecision = 'allow';
    if (requiresApproval && !this.grants.get(request.sessionId)?.has(request.tool.name)) {
      try { request.onAwaitingApproval?.(); } catch { /* Listener failures do not grant access. */ }
      decision = this.resolver ? await this.resolver(request) : 'deny';
      checkAbort();
      if (decision === 'allow' || decision === 'allow_session') this.grant(request.sessionId, request.tool.name);
    }
    checkAbort();
    this.audit(request, decision);
    if (decision !== 'allow' && decision !== 'allow_once' && decision !== 'allow_session') {
      throw new IexaError('PERMISSION_DENIED', 'SECURITY', `工具 ${request.tool.name} 的权限请求已拒绝。`);
    }
  }
  private audit(request: PermissionRequest, decision: PermissionDecision): void {
    try {
      mkdirSync(this.auditDir, { recursive: true });
      const args = JSON.parse(redactSecrets(JSON.stringify(request.args || {})));
      appendFileSync(path.join(this.auditDir, 'security-audit.jsonl'), JSON.stringify({ timestamp: Date.now(), sessionId: request.sessionId, tool: request.tool.name, risk: request.tool.risk, decision, path: typeof args.path === 'string' ? args.path : undefined, command: typeof args.command === 'string' ? args.command : undefined, args }) + '\n', 'utf8');
    } catch { /* Audit failures must not change the tool decision. */ }
  }
}
