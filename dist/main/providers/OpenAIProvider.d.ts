import { AgentMessage, AgentToolDefinition, AgentStreamEvent, ProviderConfig } from './types';
export declare class OpenAIProvider {
    readonly name: string;
    readonly model: string;
    private apiKey;
    private userAgent?;
    private baseURL;
    private thinkingLevel;
    /** True only after server-side model/endpoint capability validation. */
    private fastMode;
    private apiMode;
    /** Cache per-provider/model wire capability after a gateway rejects an
     * optional reasoning field. This prevents repeating a known-bad request. */
    private reasoningWireMode;
    readonly defaultMaxTokens: number;
    constructor(config: ProviderConfig);
    streamMessage(messages: AgentMessage[], systemPrompt: string, tools: AgentToolDefinition[], maxTokens?: number, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent>;
    private streamChatCompletions;
    /** OpenAI Responses API (/v1/responses) serializer + SSE parser.
     * This is a separate wire protocol, not a renamed Chat Completions route. */
    private streamResponses;
    private apiBaseURL;
    private convertResponsesInput;
    private convertResponsesTools;
    private applyResponsesThinkingLevel;
    private convertMessages;
    private shouldFallbackReasoning;
    private disableReasoningFields;
    private applyThinkingLevel;
    private convertTools;
}
//# sourceMappingURL=OpenAIProvider.d.ts.map