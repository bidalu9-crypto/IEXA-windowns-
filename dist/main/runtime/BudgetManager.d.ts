export interface AgentBudget {
    maxTurns: number;
    maxToolCalls: number;
    maxRuntimeMs: number;
    maxInputTokens: number;
}
export interface AgentBudgetState extends AgentBudget {
    startedAt: number;
    turns: number;
    toolCalls: number;
    inputTokens: number;
}
export declare class BudgetManager {
    private state;
    private readonly limits;
    /** Input-token limits are opt-in; context-window safety is handled by ContextCompactor. */
    private readonly enforceInputTokenBudget;
    constructor(budget?: Partial<AgentBudget>);
    reset(): void;
    beginTurn(): void;
    recordTool(): void;
    recordInputTokens(tokens: number): void;
    snapshot(): AgentBudgetState;
    private ensureRuntime;
    private createState;
}
//# sourceMappingURL=BudgetManager.d.ts.map