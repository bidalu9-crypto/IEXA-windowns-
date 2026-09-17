import { AgentMessage, AgentToolDefinition, ContextUsage } from '../providers/types';
import { LLMProvider } from '../providers/ProviderFactory';
import { ContextCompactor } from '../agent/ContextCompactor';

/** Single context policy boundary for bounded, cancellable compaction. */
export class ContextManager {
  private readonly compactor: ContextCompactor;
  constructor(provider: LLMProvider, contextWindow: number, tools: AgentToolDefinition[], systemPrompt: string, maxTokens: number) {
    this.compactor = new ContextCompactor(provider, contextWindow, tools, systemPrompt, maxTokens);
  }
  compact(messages: AgentMessage[], report: (status: ContextUsage) => void, signal?: AbortSignal): Promise<AgentMessage[]> { return this.compactor.compactIfNeeded(messages, report, signal); }
  recover(messages: AgentMessage[], report: (status: ContextUsage) => void, signal?: AbortSignal): Promise<AgentMessage[]> { return this.compactor.compactForOverflow(messages, report, signal); }
  recordInputTokens(tokens: number, messages?: AgentMessage[]): void { this.compactor.recordProviderUsage(tokens, messages); }
  status(messages: AgentMessage[]): ContextUsage { return this.compactor.status(messages); }
  summary(): string { return this.compactor.getSummary(); }
  restoreSummary(summary: string): void { this.compactor.setSummary(summary); }
}
