import { AgentMessage, AgentToolDefinition, AgentStreamEvent, ProviderConfig } from './types';
export declare class GeminiProvider {
    readonly name: string;
    readonly model: string;
    private apiKey;
    private userAgent?;
    private thinkingLevel;
    readonly defaultMaxTokens: number;
    constructor(config: ProviderConfig);
    streamMessage(messages: AgentMessage[], systemPrompt: string, tools: AgentToolDefinition[], maxTokens?: number, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent>;
    private convertMessages;
    private convertTools;
}
//# sourceMappingURL=GeminiProvider.d.ts.map