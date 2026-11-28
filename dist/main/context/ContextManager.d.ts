import { AgentMessage, AgentToolDefinition, ContextUsage } from '../providers/types';
import { LLMProvider } from '../providers/ProviderFactory';
import { ContextCompactionOptions } from '../agent/ContextCompactor';
/** Single context policy boundary for bounded, cancellable compaction. */
export declare class ContextManager {
    private readonly compactor;
    constructor(provider: LLMProvider, contextWindow: number, tools: AgentToolDefinition[], systemPrompt: string, maxTokens: number, options?: ContextCompactionOptions);
    compact(messages: AgentMessage[], report: (status: ContextUsage) => void, signal?: AbortSignal): Promise<AgentMessage[]>;
    recover(messages: AgentMessage[], report: (status: ContextUsage) => void, signal?: AbortSignal): Promise<AgentMessage[]>;
    recordInputTokens(tokens: number, messages?: AgentMessage[]): void;
    /** Continue a reopened session's request size instead of restarting at zero. */
    restoreUsage(usedTokens: number): void;
    status(messages: AgentMessage[]): ContextUsage;
    summary(): string;
    restoreSummary(summary: string): void;
}
//# sourceMappingURL=ContextManager.d.ts.map