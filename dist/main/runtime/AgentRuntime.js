"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRuntime = void 0;
const AgentLoop_1 = require("../agent/AgentLoop");
const BudgetManager_1 = require("./BudgetManager");
const CancellationManager_1 = require("./CancellationManager");
const ToolRuntime_1 = require("./ToolRuntime");
const Trace_1 = require("../observability/Trace");
const Metrics_1 = require("../observability/Metrics");
const CostTracker_1 = require("../observability/CostTracker");
const SubAgentManager_1 = require("./SubAgentManager");
const TraceStore_1 = require("../observability/TraceStore");
const AbortWait_1 = require("./AbortWait");
class AgentRuntime {
    config;
    cancellation = new CancellationManager_1.CancellationManager();
    /** Resolves the parked run() when a paused turn is resumed or cancelled. */
    resumeWaiter = null;
    budget;
    tools;
    loop;
    trace = new Trace_1.Trace();
    metrics = new Metrics_1.Metrics();
    costs;
    traceStore;
    traceOffset = 0;
    state;
    activeRun = false;
    subAgents;
    permissionMode;
    constructor(config) {
        this.config = config;
        this.permissionMode = config.permissionMode || 'risk';
        this.costs = new CostTracker_1.CostTracker(config.provider.name, config.provider.model);
        this.budget = new BudgetManager_1.BudgetManager(config.budget);
        this.traceStore = config.traceDir ? new TraceStore_1.TraceStore(config.traceDir) : undefined;
        this.tools = new ToolRuntime_1.ToolRuntime({ workspaceDir: config.workspaceDir, memoryDir: config.memoryDir, memoryEnabled: config.memoryEnabled, auditDir: config.auditDir, permissionResolver: config.permissionResolver, permissionMode: config.permissionMode, budget: this.budget, desktopCaptureFrames: config.desktopCaptureFrames, questionResolver: config.questionResolver, hooks: config.hooks, shellSessions: config.shellSessions, jobBridge: config.jobBridge, goalStore: config.goalStore, bots: config.bots, scheduledTasks: config.scheduledTasks });
        this.tools.registerDefaults(config.onSkillRead, config.onSkillWrite);
        this.loop = new AgentLoop_1.AgentLoop({ ...config, sessionId: config.sessionId, toolRuntime: this.tools, getAbortSignal: () => this.cancellation.signal(config.sessionId) });
        this.subAgents = config.subAgentTree || (config.subAgentDir ? new SubAgentManager_1.SubAgentManager({
            rootSessionId: config.sessionId, directory: config.subAgentDir, model: config.provider.model,
            workspaceDir: config.workspaceDir, rootContext: () => this.contextSnapshot(), onChange: config.onSubAgentChange,
            onUsage: config.onSubAgentUsage,
            factory: (record, manager) => {
                if (record.model !== config.provider.model)
                    throw new Error('子代理原模型与当前模型不同；请切回原模型后继续，避免静默替换。');
                return new AgentRuntime({ ...config, sessionId: record.id, subAgentTree: manager, workspaceDir: record.workspaceDir,
                    subAgentDir: undefined, permissionMode: this.permissionMode,
                    permissionResolver: config.permissionResolver ? request => config.permissionResolver({ ...request,
                        sessionId: config.sessionId, toolCallId: `${record.id}:${request.toolCallId || ''}` }) : undefined,
                    questionResolver: config.questionResolver ? request => config.questionResolver({ ...request,
                        sessionId: config.sessionId, toolCallId: `${record.id}:${request.toolCallId || ''}` }) : undefined,
                });
            },
        }) : undefined);
        for (const definition of this.subAgents?.definitions(config.sessionId) || [])
            this.tools.registry.register(definition);
        this.state = { sessionId: config.sessionId, status: 'idle', turn: 0, toolCalls: 0, startedAt: 0, updatedAt: Date.now(), budget: this.budget.snapshot() };
    }
    async initialize() { await this.tools.initialize(); await this.loop.initialize(); }
    async run(request, options = {}) {
        if (this.activeRun)
            throw new Error('This session already has a running or cancelling turn.');
        if (this.config.allowedToolNames) {
            const allowed = new Set(this.config.allowedToolNames);
            request = { ...request, tools: request.tools.filter(tool => allowed.has(tool.name)) };
        }
        this.tools.beginRun(request.tools.map((tool) => tool.name));
        const runSignal = this.cancellation.begin(this.config.sessionId);
        this.traceOffset = this.trace.cursor();
        this.trace.event('run_started', { sessionId: this.config.sessionId });
        this.metrics.increment('runs_started');
        this.state = { ...this.state, status: 'running', turn: 0, toolCalls: 0, startedAt: Date.now(), updatedAt: Date.now(), budget: this.budget.snapshot() };
        let terminal;
        const callbacks = { ...request.callbacks,
            onToolState: (event) => { this.trace.event('tool_state', { ...event }); request.callbacks.onToolState?.(event); },
            onTurnStart: (turn) => { this.trace.event('turn_started', { turn }); this.metrics.increment('turns_started'); this.state = { ...this.state, turn, updatedAt: Date.now(), budget: this.budget.snapshot() }; request.callbacks.onTurnStart?.(turn); },
            onToolExecutionStart: (id, name, args) => { this.trace.event('tool_started', { id, name, args }); this.metrics.increment('tools_started'); this.state = { ...this.state, toolCalls: this.state.toolCalls + 1, currentTool: { id, name }, updatedAt: Date.now(), budget: this.budget.snapshot() }; request.callbacks.onToolExecutionStart?.(id, name, args); },
            onToolResult: (id, result) => { this.trace.event('tool_finished', { id, success: result.success, durationMs: result.durationMs }); this.metrics.increment(result.success ? 'tools_succeeded' : 'tools_failed'); if (typeof result.durationMs === 'number')
                this.metrics.observe('tool_duration_ms', result.durationMs); request.callbacks.onToolResult(id, result); },
            onRetry: (attempt, delayMs, error) => { this.trace.event('retry', { attempt, delayMs, error }); this.metrics.increment('retries'); request.callbacks.onRetry?.(attempt, delayMs, error); },
            onUsage: (usage) => { this.costs.record(usage); this.metrics.increment('provider_calls'); this.trace.event('provider_usage', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(usage.cacheReadInputTokens != null ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}) }); request.callbacks.onUsage(usage); },
            onDone: (reason) => { this.metrics.increment('runs_completed'); this.trace.event('run_completed', { reason }); terminal = () => { this.finish('completed'); request.callbacks.onDone(reason); }; }, onError: (error) => { this.metrics.increment('runs_failed'); this.trace.event('run_failed', { error }); terminal = () => { this.finish('failed'); request.callbacks.onError(error); }; }, onCancelled: () => { this.metrics.increment('runs_cancelled'); this.trace.event('run_cancelled'); terminal = () => { this.finish('cancelled'); request.callbacks.onCancelled(); }; },
        };
        this.activeRun = true;
        try {
            await this.loop.run(request.message, request.tools, callbacks, request.attachments, options.continueTurn ? { resume: true } : undefined);
        }
        finally {
            // Pause is terminal: the turn releases its lock and closes its stream, so
            // a reload, a sleep or a crash cannot leave a parked turn nobody can
            // reach. Continuing is a new turn seeded from disk (Codex does the same).
            if (this.loop.isPaused()) {
                this.state = { ...this.state, status: 'paused', currentTool: undefined, updatedAt: Date.now() };
            }
            if (runSignal.aborted) {
                const cleanup = this.config.subAgentTree ? this.subAgents?.settleDescendants(this.config.sessionId) : this.subAgents?.settleAll();
                if (cleanup)
                    await (0, AbortWait_1.settleWithin)(cleanup, 150);
            }
            this.activeRun = false;
            this.cancellation.finish(this.config.sessionId);
            // Anything still waiting was never committed; report it before the
            // terminal frame so the renderer can fall back to its queue.
            this.loop.endRun();
            terminal?.();
        }
    }
    /** True while a turn is actually streaming (not merely cached). */
    isRunning() { return this.activeRun; }
    /** Provider-stream time for this turn; tool and wait time excluded. */
    getGenerationMs() { return this.loop.getGenerationMs(); }
    /** Apply a new compaction trigger to the live loop (see AgentLoop). */
    setCompactionThresholdRatio(ratio) { this.loop.setCompactionThresholdRatio(ratio); }
    /** Prompt-prefill wait before the first token, summed over model steps. */
    getTimeToFirstTokenMs() { return this.loop.getTimeToFirstTokenMs(); }
    /** Inject a user message into the live turn; false when nothing is running. */
    steer(request) {
        if (!this.activeRun)
            return false;
        return this.loop.steer(request);
    }
    async resume() {
        if (!this.activeRun || !this.loop.isPaused())
            return false;
        this.resumeWaiter?.();
        this.resumeWaiter = null;
        return true;
    }
    isPaused() { return this.loop.isPaused(); }
    pause() {
        if (!this.activeRun)
            return false;
        return this.loop.pause();
    }
    cancel() {
        this.cancellation.cancel(this.config.sessionId);
        this.loop.cancel();
        // A paused turn is parked inside run(); wake it so the cancellation can
        // settle instead of leaving the session locked forever.
        this.resumeWaiter?.();
        this.resumeWaiter = null;
        if (this.config.subAgentTree)
            this.subAgents?.cancelDescendants(this.config.sessionId);
        else {
            this.subAgents?.cancelAll();
            if (!this.activeRun)
                void this.subAgents?.settleAll();
        }
    }
    async settleBackground() { await this.subAgents?.settleAll(); }
    /**
     * 这个实例是用哪套 prompt 建的。
     *
     * 调用方必须拿它和会话当前的 natural 状态比对：不一致就丢弃重建。
     * 缓存命中不等于配置正确——实例一旦建好，prompt 就固定了，之后会话
     * 模式再变也不会自己更新。
     */
    isNaturalChat() { return this.config.naturalChat === true; }
    getSubAgents() { return this.subAgents; }
    hasBackgroundWork() { return this.subAgents?.hasActiveWork() || false; }
    contextSnapshot() { return this.loop.contextSnapshot(); }
    reset() { this.loop.reset(); }
    getState() { return { ...this.state, budget: this.budget.snapshot(), toolExecutions: this.tools.getToolExecutions() }; }
    getObservability() { return { metrics: this.metrics.snapshot(), cost: this.costs.snapshot(), trace: this.trace.snapshot() }; }
    getHistoryLength() { return this.loop.getHistoryLength(); }
    scrubAssistantText(scrub) { this.loop.scrubAssistantText(scrub); }
    toolDefinitions() { return this.tools.definitions(); }
    registerDynamicTool(...args) { this.tools.registerDynamicTool(...args); }
    grantPermission(toolName) { this.tools.grantPermission(this.config.sessionId, toolName); }
    setPermissionMode(mode) { this.permissionMode = mode; this.tools.setPermissionMode(mode); if (!this.config.subAgentTree)
        this.subAgents?.setPermissionMode(mode); }
    setSessionContext(value, placement) { this.loop.setSessionContext(value, placement); }
    setNaturalMemory(value) { this.loop.setNaturalMemory(value); }
    setCompactorSummary(value) { this.loop.setCompactorSummary(value); }
    restoreContextUsage(usedTokens) { this.loop.restoreContextUsage(usedTokens); }
    getCompactorSummary() { return this.loop.getCompactorSummary(); }
    seedHistoryFromChat(...args) { this.loop.seedHistoryFromChat(...args); }
    finish(status) {
        this.state = { ...this.state, status, currentTool: undefined, updatedAt: Date.now(), budget: this.budget.snapshot() };
        try {
            this.trace.event('metrics_snapshot', this.metrics.snapshot());
        }
        catch { /* metrics must not change completion */ }
        try {
            this.traceStore?.append(this.config.sessionId, this.trace.since(this.traceOffset));
        }
        catch { /* Trace persistence must not change agent completion. */ }
    }
}
exports.AgentRuntime = AgentRuntime;
//# sourceMappingURL=AgentRuntime.js.map