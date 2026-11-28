"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BudgetManager = void 0;
const IexaError_1 = require("../errors/IexaError");
class BudgetManager {
    state;
    limits;
    /** Input-token limits are opt-in; context-window safety is handled by ContextCompactor. */
    enforceInputTokenBudget;
    constructor(budget = {}) {
        // Long-running repository tasks routinely need hundreds of model/tool
        // turns. Keep finite guardrails, but make the defaults large enough that
        // normal project work is not cut off prematurely; callers can still pass
        // tighter per-run budgets explicitly.
        const limits = {
            maxTurns: budget.maxTurns ?? 2_000,
            maxToolCalls: budget.maxToolCalls ?? 5_000,
            maxRuntimeMs: budget.maxRuntimeMs ?? 24 * 60 * 60_000,
            maxInputTokens: budget.maxInputTokens ?? 10_000_000,
        };
        for (const [name, value] of Object.entries(limits)) {
            if (!Number.isSafeInteger(value) || value <= 0)
                throw new IexaError_1.IexaError('BUDGET_CONFIG', 'CONFIG', `${name} must be a positive safe integer.`);
        }
        this.limits = limits;
        // The default value is retained for observability/backwards compatibility,
        // but cumulative prompt usage is not a useful hard stop: each request is
        // already bounded by the model context window and compaction policy.
        this.enforceInputTokenBudget = budget.maxInputTokens !== undefined;
        this.state = this.createState();
    }
    reset() { this.state = this.createState(); }
    beginTurn() { this.ensureRuntime(); if (++this.state.turns > this.state.maxTurns)
        throw new IexaError_1.IexaError('BUDGET_TURNS', 'RUNTIME', '已达到本次任务的最大执行轮数。'); }
    recordTool() { this.ensureRuntime(); if (++this.state.toolCalls > this.state.maxToolCalls)
        throw new IexaError_1.IexaError('BUDGET_TOOLS', 'RUNTIME', '已达到本次任务的最大工具调用数。'); }
    recordInputTokens(tokens) {
        if (!Number.isSafeInteger(tokens) || tokens < 0)
            throw new IexaError_1.IexaError('BUDGET_INPUT', 'CONFIG', 'Input token count must be a nonnegative safe integer.');
        this.state.inputTokens += tokens;
        if (this.enforceInputTokenBudget && this.state.inputTokens > this.state.maxInputTokens) {
            throw new IexaError_1.IexaError('BUDGET_TOKENS', 'RUNTIME', '已达到本次任务的上下文预算。');
        }
    }
    snapshot() { return { ...this.state }; }
    ensureRuntime() { if (Date.now() - this.state.startedAt > this.state.maxRuntimeMs)
        throw new IexaError_1.IexaError('BUDGET_TIME', 'RUNTIME', '已达到本次任务的最大运行时间。'); }
    createState() { return { ...this.limits, startedAt: Date.now(), turns: 0, toolCalls: 0, inputTokens: 0 }; }
}
exports.BudgetManager = BudgetManager;
//# sourceMappingURL=BudgetManager.js.map