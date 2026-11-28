import { ProviderConfig, AgentMessage, AgentToolDefinition, AgentStreamEvent } from './types';
export interface LLMProvider {
    readonly name: string;
    readonly model: string;
    readonly defaultMaxTokens: number;
    streamMessage(messages: AgentMessage[], systemPrompt: string, tools: AgentToolDefinition[], maxTokens?: number, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent>;
}
export declare class ProviderFactory {
    static create(config: ProviderConfig): LLMProvider;
}
//# sourceMappingURL=ProviderFactory.d.ts.map