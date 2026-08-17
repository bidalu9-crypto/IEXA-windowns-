import { IexaError } from '../errors/IexaError';
export interface AgentBudget { maxTurns: number; maxToolCalls: number; maxRuntimeMs: number; maxInputTokens: number; }
export interface AgentBudgetState extends AgentBudget { startedAt: number; turns: number; toolCalls: number; inputTokens: number; }
export class BudgetManager {
  private state: AgentBudgetState;
  private readonly limits: AgentBudget;
  constructor(budget: Partial<AgentBudget> = {}) { this.limits = { maxTurns: budget.maxTurns ?? 200, maxToolCalls: budget.maxToolCalls ?? 300, maxRuntimeMs: budget.maxRuntimeMs ?? 60 * 60_000, maxInputTokens: budget.maxInputTokens ?? 1_000_000 }; this.state = this.createState(); }
  reset(): void { this.state = this.createState(); }
  beginTurn(): void { this.ensureRuntime(); if (++this.state.turns > this.state.maxTurns) throw new IexaError('BUDGET_TURNS', 'RUNTIME', '已达到本次任务的最大执行轮数。'); }
  recordTool(): void { this.ensureRuntime(); if (++this.state.toolCalls > this.state.maxToolCalls) throw new IexaError('BUDGET_TOOLS', 'RUNTIME', '已达到本次任务的最大工具调用数。'); }
  recordInputTokens(tokens: number): void { this.state.inputTokens += Math.max(0, tokens || 0); if (this.state.inputTokens > this.state.maxInputTokens) throw new IexaError('BUDGET_TOKENS', 'RUNTIME', '已达到本次任务的上下文预算。'); }
  snapshot(): AgentBudgetState { return { ...this.state }; }
  private ensureRuntime(): void { if (Date.now() - this.state.startedAt > this.state.maxRuntimeMs) throw new IexaError('BUDGET_TIME', 'RUNTIME', '已达到本次任务的最大运行时间。'); }
  private createState(): AgentBudgetState { return { ...this.limits, startedAt: Date.now(), turns: 0, toolCalls: 0, inputTokens: 0 }; }
}
