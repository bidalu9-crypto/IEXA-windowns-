"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionManager = exports.PermissionBroker = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const IexaError_1 = require("../errors/IexaError");
/**
 * Tools that never mutate the workspace or the user's machine. Plan mode allows
 * exactly this set (plus read-only desktop_control actions) and refuses the rest
 * before any approval prompt, so exploration is safe by construction.
 */
const PLAN_READ_ONLY_TOOLS = new Set([
    'project_instructions', 'todo_write', 'ask_user', 'file_read', 'grep', 'glob',
    'memory_get', 'web_search', 'browser_fetch', 'display_file', 'read_image',
    'job_list', 'job_output', 'ide_context',
]);
const READ_ONLY_DESKTOP_ACTIONS = new Set([
    'list_windows', 'observe', 'frame', 'session_state', 'find_element',
    'read_focused', 'wait', 'wait_change',
]);
/** Bridges a runtime permission wait to HTTP/SSE without exposing Tool internals. */
class PermissionBroker {
    timeoutMs;
    pending = new Map();
    listeners = new Map();
    constructor(timeoutMs = 120_000) {
        this.timeoutMs = timeoutMs;
    }
    request(request) {
        if (request.signal?.aborted)
            return Promise.resolve('deny');
        const now = Date.now();
        const item = {
            id: `perm_${now.toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
            request,
            createdAt: now,
            expiresAt: now + this.timeoutMs,
        };
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.resolve(item.id, 'deny'), this.timeoutMs);
            const abort = () => { this.resolve(item.id, 'deny'); };
            const cleanup = () => request.signal?.removeEventListener('abort', abort);
            this.pending.set(item.id, { item, resolve, timer, cleanup });
            request.signal?.addEventListener('abort', abort, { once: true });
            if (request.signal?.aborted) {
                abort();
                return;
            }
            for (const listener of this.listeners.get(request.sessionId) || []) {
                try {
                    listener(item);
                }
                catch { /* Disconnected observers do not resolve or lose the request. */ }
            }
        });
    }
    subscribe(sessionId, listener) {
        const listeners = this.listeners.get(sessionId) || new Set();
        listeners.add(listener);
        this.listeners.set(sessionId, listeners);
        return () => {
            const current = this.listeners.get(sessionId);
            current?.delete(listener);
            if (current && current.size === 0)
                this.listeners.delete(sessionId);
        };
    }
    list(sessionId) {
        return [...this.pending.values()]
            .map(({ item }) => item)
            .filter((item) => !sessionId || item.request.sessionId === sessionId);
    }
    resolve(id, decision) {
        const entry = this.pending.get(id);
        if (!entry)
            return false;
        clearTimeout(entry.timer);
        entry.cleanup();
        this.pending.delete(id);
        entry.resolve(decision === 'allow' ? 'allow_session' : decision);
        return true;
    }
    cancelSession(sessionId) {
        for (const item of this.list(sessionId))
            this.resolve(item.id, 'deny');
    }
}
exports.PermissionBroker = PermissionBroker;
class PermissionManager {
    auditDir;
    resolver;
    mode;
    grants = new Map();
    constructor(auditDir, resolver, mode = 'risk') {
        this.auditDir = auditDir;
        this.resolver = resolver;
        this.mode = mode;
    }
    setMode(mode) { this.mode = mode; }
    grant(sessionId, toolName) {
        const names = this.grants.get(sessionId) || new Set();
        names.add(toolName);
        this.grants.set(sessionId, names);
    }
    revokeSession(sessionId) { this.grants.delete(sessionId); }
    async authorize(request) {
        const checkAbort = () => { if (request.signal?.aborted)
            throw new IexaError_1.IexaError('TOOL_CANCELLED', 'RUNTIME', 'Tool cancelled during permission approval.'); };
        checkAbort();
        if (this.mode === 'plan') {
            const name = request.tool.name;
            const readOnlyDesktop = name === 'desktop_control'
                && READ_ONLY_DESKTOP_ACTIONS.has(String(request.args.action || 'observe'));
            if (!PLAN_READ_ONLY_TOOLS.has(name) && !readOnlyDesktop) {
                this.audit(request, 'deny');
                throw new IexaError_1.IexaError('PERMISSION_DENIED', 'SECURITY', `当前为规划模式（只读）：${name} 不会执行。需要动手时请切换到「帮我批准」或「完全访问」。`);
            }
            this.audit(request, 'allow');
            return;
        }
        const requiresApproval = this.mode === 'ask'
            ? !['todo_write', 'file_read', 'memory_get', 'project_instructions', 'ide_context'].includes(request.tool.name)
            : this.mode === 'full'
                ? false
                : request.tool.requiresApproval || request.tool.risk === 'high' || request.tool.risk === 'critical';
        let decision = 'allow';
        if (requiresApproval && !this.grants.get(request.sessionId)?.has(request.tool.name)) {
            try {
                request.onAwaitingApproval?.();
            }
            catch { /* Listener failures do not grant access. */ }
            decision = this.resolver ? await this.resolver(request) : 'deny';
            checkAbort();
            if (decision === 'allow' || decision === 'allow_session')
                this.grant(request.sessionId, request.tool.name);
        }
        checkAbort();
        this.audit(request, decision);
        if (decision !== 'allow' && decision !== 'allow_once' && decision !== 'allow_session') {
            throw new IexaError_1.IexaError('PERMISSION_DENIED', 'SECURITY', `工具 ${request.tool.name} 的权限请求已拒绝。`);
        }
    }
    audit(request, decision) {
        try {
            (0, fs_1.mkdirSync)(this.auditDir, { recursive: true });
            const args = (0, IexaError_1.redactSecretValues)(request.args || {});
            (0, fs_1.appendFileSync)(path.join(this.auditDir, 'security-audit.jsonl'), JSON.stringify({ timestamp: Date.now(), sessionId: request.sessionId, tool: request.tool.name, risk: request.tool.risk, decision, path: typeof args.path === 'string' ? args.path : undefined, command: typeof args.command === 'string' ? args.command : undefined, args }) + '\n', 'utf8');
        }
        catch { /* Audit failures must not change the tool decision. */ }
    }
}
exports.PermissionManager = PermissionManager;
//# sourceMappingURL=PermissionManager.js.map