import { AgentLoop, AgentLoopConfig } from '../agent/AgentLoop';
import { AgentState } from '../agent/AgentState';
import { AgentLoopCallbacks, AgentToolDefinition } from '../providers/types';
import { BudgetManager } from './BudgetManager';
import { CancellationManager } from './CancellationManager';
import { ToolRuntime } from './ToolRuntime';
import { PermissionMode, PermissionResolver } from '../security/PermissionManager';
import { Trace } from '../observability/Trace';
import { Metrics } from '../observability/Metrics';
import { CostTracker } from '../observability/CostTracker';
import { SubAgentManager, SubAgentSummary } from './SubAgentManager';
import { TraceStore } from '../observability/TraceStore';

export interface AgentRuntimeConfig extends Omit<AgentLoopConfig, 'toolRuntime' | 'sessionId' | 'getAbortSignal'> { sessionId: string; auditDir?: string; traceDir?: string; permissionResolver?: PermissionResolver; permissionMode?: PermissionMode; budget?: ConstructorParameters<typeof BudgetManager>[0]; desktopCaptureFrames?: boolean; subAgentDir?: string; onSubAgentChange?: (agent: SubAgentSummary) => void; onSubAgentUsage?: (usage: { inputTokens: number; outputTokens: number }) => void; subAgentTree?: SubAgentManager; }
export interface AgentRequest { message: string; tools: AgentToolDefinition[]; callbacks: AgentLoopCallbacks; attachments?: Parameters<AgentLoop['run']>[3]; }

export class AgentRuntime {
  private readonly cancellation = new CancellationManager();
  private readonly budget: BudgetManager;
  private readonly tools: ToolRuntime;
  private readonly loop: AgentLoop;
  private readonly trace = new Trace();
  private readonly metrics = new Metrics();
  private readonly costs: CostTracker;
  private readonly traceStore?: TraceStore;
  private traceOffset = 0;
  private state: AgentState;
  private activeRun = false;
  private readonly subAgents?: SubAgentManager;
  private permissionMode: PermissionMode;
  constructor(private readonly config: AgentRuntimeConfig) {
    this.permissionMode = config.permissionMode || 'risk';
    this.costs = new CostTracker(config.provider.name, config.provider.model);
    this.budget = new BudgetManager(config.budget);
    this.traceStore = config.traceDir ? new TraceStore(config.traceDir) : undefined;
    this.tools = new ToolRuntime({ workspaceDir: config.workspaceDir, memoryDir: config.memoryDir, memoryEnabled: config.memoryEnabled, auditDir: config.auditDir, permissionResolver: config.permissionResolver, permissionMode: config.permissionMode, budget: this.budget, desktopCaptureFrames: config.desktopCaptureFrames });
    this.tools.registerDefaults(config.onSkillRead, config.onSkillWrite);
    this.loop = new AgentLoop({ ...config, sessionId: config.sessionId, toolRuntime: this.tools, getAbortSignal: () => this.cancellation.signal(config.sessionId) });
    this.subAgents = config.subAgentTree || (config.subAgentDir ? new SubAgentManager({
      rootSessionId: config.sessionId, directory: config.subAgentDir, model: config.provider.model,
      workspaceDir: config.workspaceDir, rootContext: () => this.contextSnapshot(), onChange: config.onSubAgentChange,
      onUsage: config.onSubAgentUsage,
      factory: (record, manager) => {
        if (record.model !== config.provider.model) throw new Error('子代理原模型与当前模型不同；请切回原模型后继续，避免静默替换。');
        return new AgentRuntime({ ...config, sessionId: record.id, subAgentTree: manager, workspaceDir: record.workspaceDir,
        subAgentDir: undefined, permissionMode: this.permissionMode,
        permissionResolver: config.permissionResolver ? request => config.permissionResolver!({ ...request,
          sessionId: config.sessionId, toolCallId: `${record.id}:${request.toolCallId || ''}` }) : undefined,
        });
      },
    }) : undefined);
    for (const definition of this.subAgents?.definitions(config.sessionId) || []) this.tools.registry.register(definition);
    this.state = { sessionId: config.sessionId, status: 'idle', turn: 0, toolCalls: 0, startedAt: 0, updatedAt: Date.now(), budget: this.budget.snapshot() };
  }
  async initialize(): Promise<void> { await this.tools.initialize(); await this.loop.initialize(); }
  async run(request: AgentRequest): Promise<void> {
    if (this.activeRun) throw new Error('This session already has a running or cancelling turn.');
    this.tools.beginRun(request.tools.map((tool) => tool.name)); const runSignal = this.cancellation.begin(this.config.sessionId); this.traceOffset = this.trace.cursor(); this.trace.event('run_started', { sessionId: this.config.sessionId }); this.metrics.increment('runs_started'); this.state = { ...this.state, status: 'running', turn: 0, toolCalls: 0, startedAt: Date.now(), updatedAt: Date.now(), budget: this.budget.snapshot() };
    let terminal: (() => void) | undefined;
    const callbacks: AgentLoopCallbacks = { ...request.callbacks,
      onToolState: (event) => { this.trace.event('tool_state', { ...event }); request.callbacks.onToolState?.(event); },
      onTurnStart: (turn) => { this.trace.event('turn_started', { turn }); this.metrics.increment('turns_started'); this.state = { ...this.state, turn, updatedAt: Date.now(), budget: this.budget.snapshot() }; request.callbacks.onTurnStart?.(turn); },
      onToolExecutionStart: (id, name, args) => { this.trace.event('tool_started', { id, name, args }); this.metrics.increment('tools_started'); this.state = { ...this.state, toolCalls: this.state.toolCalls + 1, currentTool: { id, name }, updatedAt: Date.now(), budget: this.budget.snapshot() }; request.callbacks.onToolExecutionStart?.(id, name, args); },
      onToolResult: (id, result) => { this.trace.event('tool_finished', { id, success: result.success, durationMs: result.durationMs }); this.metrics.increment(result.success ? 'tools_succeeded' : 'tools_failed'); request.callbacks.onToolResult(id, result); },
      onRetry: (attempt, delayMs, error) => { this.trace.event('retry', { attempt, delayMs, error }); this.metrics.increment('retries'); request.callbacks.onRetry?.(attempt, delayMs, error); },
      onUsage: (usage) => { this.costs.record(usage); this.metrics.increment('provider_calls'); this.trace.event('provider_usage', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }); request.callbacks.onUsage(usage); },
      onDone: (reason) => { this.metrics.increment('runs_completed'); this.trace.event('run_completed', { reason }); terminal = () => { this.finish('completed'); request.callbacks.onDone(reason); }; }, onError: (error) => { this.metrics.increment('runs_failed'); this.trace.event('run_failed', { error }); terminal = () => { this.finish('failed'); request.callbacks.onError(error); }; }, onCancelled: () => { this.metrics.increment('runs_cancelled'); this.trace.event('run_cancelled'); terminal = () => { this.finish('cancelled'); request.callbacks.onCancelled(); }; },
    };
    this.activeRun = true;
    try { await this.loop.run(request.message, request.tools, callbacks, request.attachments); }
    finally {
      if (runSignal.aborted) {
        if (this.config.subAgentTree) await this.subAgents?.settleDescendants(this.config.sessionId);
        else await this.subAgents?.settleAll();
      }
      this.activeRun = false; this.cancellation.finish(this.config.sessionId); terminal?.();
    }
  }
  cancel(): void {
    this.cancellation.cancel(this.config.sessionId); this.loop.cancel();
    if (this.config.subAgentTree) this.subAgents?.cancelDescendants(this.config.sessionId);
    else { this.subAgents?.cancelAll(); if (!this.activeRun) void this.subAgents?.settleAll(); }
  }
  async settleBackground(): Promise<void> { await this.subAgents?.settleAll(); }
  getSubAgents(): SubAgentManager | undefined { return this.subAgents; }
  hasBackgroundWork(): boolean { return this.subAgents?.hasActiveWork() || false; }
  contextSnapshot(): string { return this.loop.contextSnapshot(); }
  reset(): void { this.loop.reset(); }
  getState(): AgentState & { toolExecutions: ReturnType<ToolRuntime['getToolExecutions']> } { return { ...this.state, budget: this.budget.snapshot(), toolExecutions: this.tools.getToolExecutions() }; }
  getObservability(): { metrics: Record<string, number>; cost: ReturnType<CostTracker['snapshot']>; trace: ReturnType<Trace['snapshot']> } { return { metrics: this.metrics.snapshot(), cost: this.costs.snapshot(), trace: this.trace.snapshot() }; }
  getHistoryLength(): number { return this.loop.getHistoryLength(); }
  toolDefinitions(): AgentToolDefinition[] { return this.tools.definitions(); }
  registerDynamicTool(...args: Parameters<ToolRuntime['registerDynamicTool']>): void { this.tools.registerDynamicTool(...args); }
  grantPermission(toolName: string): void { this.tools.grantPermission(this.config.sessionId, toolName); }
  setPermissionMode(mode: PermissionMode): void { this.permissionMode = mode; this.tools.setPermissionMode(mode); if (!this.config.subAgentTree) this.subAgents?.setPermissionMode(mode); }
  setSessionContext(value: string | null | undefined): void { this.loop.setSessionContext(value); }
  setCompactorSummary(value: string | null | undefined): void { this.loop.setCompactorSummary(value); }
  getCompactorSummary(): string { return this.loop.getCompactorSummary(); }
  seedHistoryFromChat(...args: Parameters<AgentLoop['seedHistoryFromChat']>): void { this.loop.seedHistoryFromChat(...args); }
  private finish(status: AgentState['status']): void {
    this.state = { ...this.state, status, currentTool: undefined, updatedAt: Date.now(), budget: this.budget.snapshot() };
    try { this.traceStore?.append(this.config.sessionId, this.trace.since(this.traceOffset)); } catch { /* Trace persistence must not change agent completion. */ }
  }
}
