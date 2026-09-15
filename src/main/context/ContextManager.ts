import { AgentMessage, AgentToolDefinition, ContextUsage } from '../providers/types';
import { LLMProvider } from '../providers/ProviderFactory';
import { ContextCompactor } from '../agent/ContextCompactor';

/** Single context policy boundary retaining the existing compactor algorithm. */
export class ContextManager {
  private readonly compactor: ContextCompactor;
  constructor(provider: LLMProvider, contextWindow: number, tools: AgentToolDefinition[], systemPrompt: string, maxTokens: number) {
    this.compactor = new ContextCompactor(provider, contextWindow, tools, systemPrompt, maxTokens);
  }
  compact(messages: AgentMessage[], report: (status: ContextUsage) => void): Promise<AgentMessage[]> { return this.compactor.compactIfNeeded(messages, report); }
  recover(messages: AgentMessage[], report: (status: ContextUsage) => void): Promise<AgentMessage[]> { return this.compactor.compactForOverflow(messages, report); }
  recordInputTokens(tokens: number): void { this.compactor.recordProviderUsage(tokens); }
  status(messages: AgentMessage[]): ContextUsage { return this.compactor.status(messages); }
  summary(): string { return this.compactor.getSummary(); }
  restoreSummary(summary: string): void { this.compactor.setSummary(summary); }
}
