export type UsageRange = '24h' | '7d' | '30d' | 'all';
export interface TokenPart {
    key: string;
    label: string;
    tokens: number;
    ratio: number;
}
export interface TimePart {
    key: string;
    label: string;
    ms: number;
    ratio: number;
}
export interface DailyPoint {
    day: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number | null;
}
export interface ActivityCell {
    day: string;
    tokens: number;
    turns: number;
}
export interface SessionInsight {
    id: string;
    title: string;
    updated: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number | null;
    model: string;
    lastMessage: string;
}
export interface UsageInsights {
    range: UsageRange;
    generatedAt: number;
    since: number;
    totals: {
        sessions: number;
        turns: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheHitRate: number;
        costUsd: number | null;
        pricedSessions: number;
        toolCalls: number;
        toolMs: number;
        activeMs: number;
        modelCalls: number;
    };
    daily: DailyPoint[];
    tokenBreakdown: TokenPart[];
    timeBreakdown: TimePart[];
    activity: ActivityCell[];
    sessions: SessionInsight[];
    /** True when the token split had to be inferred from message text. */
    tokenBreakdownEstimated: boolean;
    /** True when at least one session had no configured price. */
    costIncomplete: boolean;
}
export interface TokenPrice {
    input: number;
    output: number;
    cacheRead?: number;
}
/** Resolve the price for one session's model; null means "no price configured". */
export type PriceLookup = (sessionId: string, provider: string, model: string) => TokenPrice | null;
/**
 * Rough token count for a string. CJK runs near one token per character while
 * Latin text is closer to four characters per token; the mix below lands within
 * the ±15% band the UI advertises.
 */
export declare function estimateTokens(text: string): number;
export interface CollectOptions {
    workspaceDir: string;
    range: UsageRange;
    priceFor: PriceLookup;
    /** Session index metadata, so a row can show the name the sidebar shows. */
    meta?: Map<string, {
        title: string;
        model: string;
        provider: string;
    }>;
}
export declare function collectUsageInsights(options: CollectOptions): UsageInsights;
//# sourceMappingURL=UsageInsights.d.ts.map