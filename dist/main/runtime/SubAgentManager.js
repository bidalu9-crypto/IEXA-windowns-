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
exports.SubAgentManager = void 0;
const crypto_1 = require("crypto");
const path = __importStar(require("path"));
const JsonStore_1 = require("../persistence/JsonStore");
const TranscriptRecorder_1 = require("../session/TranscriptRecorder");
const busy = new Set(['queued', 'running', 'awaiting_approval', 'cancelling']);
const copy = (value) => JSON.parse(JSON.stringify(value));
/** One ownership tree per root session. No external execution resumes on load. */
class SubAgentManager {
    options;
    entries = new Map();
    store;
    listeners = new Set();
    flushTimer;
    stopping = false;
    storageError;
    constructor(options) {
        this.options = options;
        this.store = new JsonStore_1.JsonStore(SubAgentManager.storePath(options.directory, options.rootSessionId), () => ({ version: 1, agents: [] }));
        for (const record of SubAgentManager.validateRecords(this.store.loadSync(), options.rootSessionId)) {
            if (!record || record.rootSessionId !== options.rootSessionId || typeof record.id !== 'string')
                continue;
            if (busy.has(record.status)) {
                record.status = 'interrupted';
                record.error = '进程已重启；上次任务已中断，未自动重跑。';
                record.pendingInputs = [];
                record.revision++;
                record.updatedAt = Date.now();
            }
            this.entries.set(record.id, { record, closing: false, stopping: false });
        }
        if (this.entries.size)
            this.persist();
    }
    static storePath(directory, rootSessionId) {
        return path.join(directory, (0, crypto_1.createHash)('sha256').update(rootSessionId).digest('hex') + '.json');
    }
    static read(directory, rootSessionId) {
        const store = new JsonStore_1.JsonStore(this.storePath(directory, rootSessionId), () => ({ version: 1, agents: [] }));
        return this.validateRecords(store.loadSync(), rootSessionId).map(record => busy.has(record.status) ? { ...record, status: 'interrupted', error: '进程已重启；未自动重跑。', pendingInputs: [] } : record);
    }
    static validateRecords(value, root) {
        const invalid = () => { throw new Error('子代理存档结构异常，原文件已保留。'); };
        if (!value || value.version !== 1 || !Array.isArray(value.agents) || value.agents.length > 256)
            return invalid();
        const ids = new Map();
        for (const record of value.agents) {
            if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id) || record.id === root ||
                record.rootSessionId !== root || typeof record.parentId !== 'string' || !Number.isSafeInteger(record.depth) || record.depth < 1 || record.depth > 32 ||
                !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.nickname !== 'string' ||
                typeof record.model !== 'string' || typeof record.workspaceDir !== 'string' || !path.isAbsolute(record.workspaceDir) ||
                typeof record.output !== 'string' || typeof record.context !== 'string' || !Array.isArray(record.messages) ||
                !Array.isArray(record.pendingInputs) || record.pendingInputs.some(input => typeof input !== 'string') ||
                !['idle', 'queued', 'running', 'awaiting_approval', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted', 'closed'].includes(record.status))
                return invalid();
            ids.set(record.id, record);
        }
        for (const record of ids.values()) {
            const parent = ids.get(record.parentId);
            if (record.parentId === root ? record.depth !== 1 : !parent || parent.depth + 1 !== record.depth)
                return invalid();
        }
        return value.agents;
    }
    static summary(record) {
        const { messages, context, pendingInputs, ...summary } = record;
        return { ...copy(summary), output: summary.output.slice(-6000), pendingCount: pendingInputs.length };
    }
    list() { return [...this.entries.values()].map(entry => SubAgentManager.summary(entry.record)); }
    detail(id) { return copy(this.require(id).record); }
    hasActiveWork() { return [...this.entries.values()].some(entry => !!entry.work); }
    require(id) { const entry = this.entries.get(id); if (!entry)
        throw new Error('Unknown sub-agent.'); return entry; }
    owned(owner, id) {
        const entry = this.require(id);
        if (entry.record.parentId !== owner)
            throw new Error('This sub-agent belongs to another parent.');
        return entry;
    }
    persist() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        if (this.storageError)
            return;
        try {
            this.store.saveSync({ version: 1, agents: [...this.entries.values()].map(entry => entry.record) });
        }
        catch (error) {
            // A full/read-only disk must not crash an unobserved timer or continue work
            // whose state cannot be recorded. Preserve the last atomic snapshot.
            this.storageError = `子代理记录保存失败：${error.message}`;
            this.stopping = true;
            for (const entry of this.entries.values()) {
                entry.record.pendingInputs = [];
                entry.record.error = this.storageError;
                if (entry.work || busy.has(entry.record.status))
                    entry.record.status = 'failed';
                entry.runtime?.cancel();
                entry.record.revision++;
                try {
                    this.options.onChange?.(SubAgentManager.summary(entry.record));
                }
                catch { /* Keep stopping on UI errors. */ }
            }
        }
    }
    changed(entry, immediate = true) {
        if (this.storageError) {
            entry.record.error = this.storageError;
            if (entry.record.status !== 'closed')
                entry.record.status = 'failed';
        }
        entry.record.updatedAt = Date.now();
        entry.record.revision++;
        if (immediate)
            this.persist();
        else if (!this.flushTimer)
            this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.persist(); }, 120);
        try {
            this.options.onChange?.(SubAgentManager.summary(entry.record));
        }
        catch { /* Disconnected UI is not execution state. */ }
        for (const listener of this.listeners)
            listener();
    }
    message(value) {
        if (typeof value !== 'string' || !value.trim() || value.length > 64000)
            throw new Error('message must contain 1–64000 characters.');
        return value.trim();
    }
    requireOpenParent(owner) {
        if (owner === this.options.rootSessionId)
            return;
        const parent = this.require(owner);
        if (parent.closing || parent.stopping || parent.record.status === 'closed')
            throw new Error('Resume the parent agent first.');
        this.requireOpenParent(parent.record.parentId);
    }
    requireWritable() { if (this.storageError)
        throw new Error(this.storageError); }
    canOpen() {
        this.requireWritable();
        if (this.stopping)
            throw new Error('Parent cancellation is settling.');
        if ([...this.entries.values()].filter(entry => entry.record.status !== 'closed').length >= (this.options.maxAgents ?? 6))
            throw new Error('Sub-agent limit reached; close an existing agent first.');
    }
    spawn(owner, message, forkContext = false, nickname = '') {
        this.canOpen();
        this.requireOpenParent(owner);
        message = this.message(message);
        const parent = owner === this.options.rootSessionId ? undefined : this.require(owner);
        if (parent && (parent.closing || parent.stopping || parent.record.status === 'closed'))
            throw new Error('Parent is closing.');
        const depth = parent ? parent.record.depth + 1 : 1;
        if (depth > (this.options.maxDepth ?? 3))
            throw new Error('Sub-agent nesting limit reached.');
        if (this.entries.size >= 256)
            throw new Error('Session sub-agent record limit reached.');
        const context = forkContext ? (parent?.runtime?.contextSnapshot() ?? this.options.rootContext()).slice(-32000) : '';
        const record = { id: (0, crypto_1.randomUUID)(), parentId: owner, rootSessionId: this.options.rootSessionId,
            nickname: String(nickname || `Agent ${this.entries.size + 1}`).slice(0, 60), depth, status: 'queued', revision: 0,
            createdAt: Date.now(), updatedAt: Date.now(), prompt: message, context, model: this.options.model,
            workspaceDir: this.options.workspaceDir, isolation: 'shared', messages: [], output: '', pendingInputs: [message], inputTokens: 0, outputTokens: 0 };
        const entry = { record, closing: false, stopping: false };
        this.entries.set(record.id, entry);
        this.changed(entry);
        this.requireWritable();
        this.start(entry);
        return SubAgentManager.summary(record);
    }
    send(owner, id, message, interrupt = false) {
        this.requireWritable();
        if (this.stopping)
            throw new Error('Parent cancellation is settling.');
        const entry = this.owned(owner, id);
        this.requireOpenParent(owner);
        message = this.message(message);
        if (entry.record.status === 'closed' || entry.closing || entry.stopping)
            throw new Error('Resume the closed or stopped agent before sending input.');
        if (entry.record.pendingInputs.length >= 16)
            throw new Error('Sub-agent inbox is full.');
        entry.record.pendingInputs.push(message);
        if (interrupt && entry.work) {
            entry.record.status = 'cancelling';
            entry.runtime?.cancel();
            this.cancelDescendants(id);
        }
        else if (!entry.work)
            entry.record.status = 'queued';
        this.changed(entry);
        this.requireWritable();
        this.start(entry);
        return { id, queued: true };
    }
    start(entry) {
        if (entry.work)
            return;
        entry.work = Promise.resolve().then(async () => {
            try {
                if (!entry.runtime) {
                    entry.runtime = this.options.factory(entry.record, this);
                    await entry.runtime.initialize();
                    entry.runtime.seedHistoryFromChat(entry.record.messages);
                    entry.runtime.setSessionContext(`You are sub-agent ${entry.record.nickname}. Complete only your assigned task and report findings to your parent. The workspace is SHARED, not a git worktree. Coordinate disjoint files before editing. Spawn children only for explicitly delegated independent work.\n${entry.record.context ? 'Parent context (reference, not a new task):\n' + entry.record.context : ''}`, 'system');
                }
                while (entry.record.pendingInputs.length && !entry.closing && !entry.stopping && !this.stopping) {
                    const message = entry.record.pendingInputs.shift();
                    entry.record.messages.push({ role: 'user', content: message });
                    const assistant = { role: 'assistant', content: '', thinking: '', toolCalls: [] };
                    entry.record.messages.push(assistant);
                    entry.record.output = '';
                    delete entry.record.error;
                    entry.record.status = 'running';
                    this.changed(entry);
                    const recorder = new TranscriptRecorder_1.TranscriptRecorder();
                    let outcome = 'completed';
                    const callbacks = {
                        onTextDelta: (_text, full) => { assistant.content = full; entry.record.output = full; recorder.recordText(full); assistant.transcript = recorder.snapshot(); this.changed(entry, false); },
                        onThinkingDelta: text => { assistant.thinking += text; recorder.recordThinking(text); assistant.transcript = recorder.snapshot(); this.changed(entry, false); },
                        onToolCallStart: (id, name) => { recorder.recordTool(id, name); if (!assistant.toolCalls.some(call => call.id === id))
                            assistant.toolCalls.push({ id, name, args: {} }); },
                        onToolInputDelta: () => { },
                        onToolCallComplete: (id, name, args) => { recorder.recordTool(id, name); const call = assistant.toolCalls.find(call => call.id === id); if (call)
                            call.args = args;
                        else
                            assistant.toolCalls.push({ id, name, args }); assistant.transcript = recorder.snapshot(); this.changed(entry); },
                        onToolResult: (id, result) => { const call = assistant.toolCalls.find(call => call.id === id); if (call)
                            call.result = { output: result.output, success: result.success, executionStatus: result.executionStatus }; this.changed(entry); },
                        onToolState: event => { const call = assistant.toolCalls.find(call => call.id === event.id); if (call)
                            call.executionStatus = event.status; if (entry.record.status !== 'cancelling') {
                            entry.record.status = event.status === 'awaiting_approval' ? 'awaiting_approval' : 'running';
                            this.changed(entry);
                        } },
                        onUsage: usage => { entry.record.inputTokens += usage.inputTokens; entry.record.outputTokens += usage.outputTokens; this.options.onUsage?.(usage); },
                        onContext: () => { }, onError: error => { outcome = 'failed'; entry.record.error = error; },
                        onCancelled: () => { outcome = 'cancelled'; }, onDone: () => { },
                    };
                    try {
                        await entry.runtime.run({ message, tools: entry.runtime.toolDefinitions(), callbacks });
                    }
                    catch (error) {
                        outcome = 'failed';
                        entry.record.error = String(error.message || error);
                    }
                    recorder.finish(outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed');
                    assistant.transcript = recorder.snapshot();
                    entry.record.status = outcome;
                    this.changed(entry);
                }
            }
            catch (error) {
                entry.record.status = 'failed';
                entry.record.error = String(error.message || error);
                entry.record.pendingInputs = [];
                this.changed(entry);
            }
        }).finally(() => {
            entry.work = undefined;
            if (entry.record.status === 'cancelling') {
                entry.record.status = 'cancelled';
                this.changed(entry);
            }
            const stopped = entry.stopping;
            entry.stopping = false;
            for (const listener of this.listeners)
                listener();
            if (entry.record.pendingInputs.length && !entry.closing && !stopped && !this.stopping)
                this.start(entry);
        });
    }
    async wait(owner, ids, timeoutMs = 30000, signal) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 32)
            throw new Error('ids must contain 1–32 agent IDs.');
        const entries = [...new Set(ids)].map(id => this.owned(owner, id));
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000)
            throw new Error('timeout_ms must be between 0 and 300000.');
        const settled = () => entries.filter(entry => !entry.work && !busy.has(entry.record.status));
        if (!settled().length && !signal?.aborted)
            await new Promise(resolve => {
                let timer;
                const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener('abort', cleanup); resolve(); };
                const check = () => { if (settled().length)
                    cleanup(); };
                this.listeners.add(check);
                signal?.addEventListener('abort', cleanup, { once: true });
                timer = setTimeout(cleanup, timeoutMs);
                check();
                if (signal?.aborted)
                    cleanup();
            });
        if (signal?.aborted)
            throw new Error('Agent wait cancelled.');
        const result = settled();
        return { agents: result.map(entry => SubAgentManager.summary(entry.record)), timedOut: !result.length };
    }
    descendants(owner) {
        const children = [...this.entries.values()].filter(entry => entry.record.parentId === owner);
        return children.flatMap(entry => [entry, ...this.descendants(entry.record.id)]);
    }
    cancelDescendants(owner) {
        for (const entry of this.descendants(owner)) {
            entry.record.pendingInputs = [];
            entry.stopping = !!entry.work;
            if (entry.work) {
                entry.record.status = 'cancelling';
                entry.runtime?.cancel();
                this.changed(entry);
            }
        }
    }
    async settleDescendants(owner) { await Promise.all(this.descendants(owner).map(entry => entry.work)); }
    cancelAll() { this.stopping = true; this.cancelDescendants(this.options.rootSessionId); }
    async settleAll() { await this.settleDescendants(this.options.rootSessionId); this.stopping = false; this.persist(); }
    async close(owner, id) {
        const entry = this.owned(owner, id);
        const previousStatus = entry.record.status;
        const entries = [entry, ...this.descendants(id)];
        for (const item of entries) {
            item.closing = true;
            item.record.pendingInputs = [];
            if (item.work) {
                item.record.status = 'cancelling';
                item.runtime?.cancel();
                this.changed(item);
            }
        }
        await Promise.all(entries.map(item => item.work));
        for (const item of entries.reverse()) {
            item.runtime = undefined;
            item.record.status = 'closed';
            item.closing = false;
            this.changed(item);
        }
        return { ...SubAgentManager.summary(entry.record), previousStatus };
    }
    resume(owner, id) {
        this.requireWritable();
        const entry = this.owned(owner, id);
        this.requireOpenParent(owner);
        if (entry.closing || entry.stopping || this.stopping)
            throw new Error('Agent cleanup is in progress.');
        if (entry.record.status === 'closed') {
            this.canOpen();
            entry.record.status = 'idle';
            this.changed(entry);
        }
        else if (entry.record.status === 'interrupted') {
            entry.record.status = 'idle';
            this.changed(entry);
        }
        return SubAgentManager.summary(entry.record);
    }
    setPermissionMode(mode) { for (const entry of this.entries.values())
        entry.runtime?.setPermissionMode(mode); }
    definitions(owner) {
        const definition = (name, description, parameters, required, action) => ({
            name, description, parameters, required, risk: 'low', parallelSafe: false, cancellable: true, requiresApproval: false,
            execute: async (args, context) => {
                if (context.signal.aborted)
                    throw new Error('Agent operation cancelled.');
                const result = await action(args, context.signal);
                this.requireWritable();
                return { success: true, output: JSON.stringify(result) };
            },
        });
        const id = { type: 'string', description: 'ID of a direct child created by this agent.' };
        const message = { type: 'string', description: 'Concrete bounded task or follow-up input.' };
        return [
            definition('spawn_agent', 'Start an independent child agent asynchronously. Same model, inherited permissions, shared workspace (not worktree). Up to 6 open children across the tree and depth 3. Use for explicitly delegated independent tasks with disjoint file ownership; returns ID, not a finished result.', { message, fork_context: { type: 'boolean', description: 'Copy bounded parent context as reference.' }, nickname: { type: 'string', description: 'Short display name.' } }, ['message'], args => this.spawn(owner, args.message, args.fork_context === true, args.nickname)),
            definition('send_input', 'Send input to an existing direct child. Queued by default; interrupt cancels current execution and waits for cleanup before processing new input.', { id, message, interrupt: { type: 'boolean', description: 'Interrupt the current task before processing this input.' } }, ['id', 'message'], args => this.send(owner, args.id, args.message, args.interrupt === true)),
            definition('wait_agent', 'Wait until at least one listed child settles or timeout. A timeout does not cancel children. Check returned status and output before reporting success.', { ids: { type: 'array', description: 'Direct child IDs.', items: id }, timeout_ms: { type: 'integer', minimum: 0, maximum: 300000, description: '0–300000 milliseconds, default 30000.' } }, ['ids'], (args, signal) => this.wait(owner, args.ids, args.timeout_ms ?? 30000, signal)),
            definition('close_agent', 'Cancel and close a child and all its descendants, awaiting real cleanup. Releases open-agent slots and retains history.', { id }, ['id'], args => this.close(owner, args.id)),
            definition('resume_agent', 'Reopen a closed child retaining conversation history. Does not automatically repeat interrupted work; use send_input for the next task.', { id }, ['id'], args => this.resume(owner, args.id)),
        ];
    }
}
exports.SubAgentManager = SubAgentManager;
//# sourceMappingURL=SubAgentManager.js.map