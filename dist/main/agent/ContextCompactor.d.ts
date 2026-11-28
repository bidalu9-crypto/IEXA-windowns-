import { AgentMessage, AgentToolDefinition } from '../providers/types';
import { LLMProvider } from '../providers/ProviderFactory';
export interface ContextStatus {
    contextWindow: number;
    usedTokens: number;
    estimated: boolean;
    compactThreshold: number;
    state: 'ok' | 'near-limit' | 'compacting' | 'compacted' | 'exhausted';
}
export declare function contextWindowForModel(model: string, provider?: string): number;
/**
 * Start compaction before input plus a possible completion can exceed the
 * model window. Keep the historical 80% ceiling for providers without an
 * output limit, while reserving the actual advertised completion budget.
 */
export declare function compactThresholdForWindow(window: number, maxOutputTokens?: number, thresholdRatio?: number): number;
/**
 * How much saved conversation to replay when a session is reopened.
 *
 * A fixed ceiling made every restart a smaller, differently-shaped context:
 * the user watched the meter fall back and the model forgot the middle of the
 * task. Recovery has to scale with the model window instead, so the reopened
 * session continues at the size it had, and compaction — not an arbitrary
 * constant — decides what leaves the request.
 */
export declare const MIN_REHYDRATED_TOKENS = 24000;
export declare function rehydrateBudgetForWindow(window: number, maxOutputTokens?: number): number;
/** Estimate model-visible messages including role and structural framing. */
export declare function estimateMessageTokens(messages: AgentMessage[]): number;
/** Estimate the complete request envelope, not only visible conversation text. */
export declare function estimateRequestTokens(messages: AgentMessage[], systemPrompt?: string, tools?: AgentToolDefinition[]): number;
export interface ContextCompactionOptions {
    /** Bound a stalled provider independently of its transport timeout. */
    summaryTimeoutMs?: number;
    /**
     * Where to start compacting, as a share of the window. The historical 80%
     * keeps a fifth of the window free for the reply; a user who runs close to
     * the limit can raise it to 1.0 and accept the output-reserve clamp instead.
     */
    thresholdRatio?: number;
}
export declare class ContextCompactor {
    private readonly provider;
    private readonly contextWindow;
    private readonly tools;
    private readonly systemPrompt;
    private readonly maxOutputTokens;
    private readonly options;
    private summary;
    private lastReportedInputTokens;
    private lastUsageEstimate;
    private lastEstimatedRequest;
    /** Session size restored from disk before this process made a request. */
    private pendingRestoredUsage;
    /** Until a provider receipt arrives, the carried value is still an estimate. */
    private restoredBaseline;
    constructor(provider: LLMProvider, contextWindow: number, tools: AgentToolDefinition[], systemPrompt: string, maxOutputTokens?: number, options?: ContextCompactionOptions);
    status(history: AgentMessage[], state?: ContextStatus['state']): ContextStatus;
    /**
     * Adopt the persisted request size for a reopened session. The first
     * status() call applies it; a later provider receipt supersedes it.
     */
    restoreUsage(usedTokens: number): void;
    recordProviderUsage(inputTokens: number, history?: AgentMessage[]): void;
    getSummary(): string;
    setSummary(summary: string): void;
    compactIfNeeded(history: AgentMessage[], onStatus: (s: ContextStatus) => void, signal?: AbortSignal): Promise<AgentMessage[]>;
    /** One bounded recovery attempt after a provider-confirmed context overflow. */
    compactForOverflow(history: AgentMessage[], onStatus: (s: ContextStatus) => void, signal?: AbortSignal): Promise<AgentMessage[]>;
    private readSummary;
    private compact;
}
//# sourceMappingURL=ContextCompactor.d.ts.map