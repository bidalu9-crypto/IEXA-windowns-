export interface TitleProfile {
    userAgent?: string;
    provider: string;
    model: string;
    apiKey: string;
    baseURL?: string;
}
export interface TitleResult {
    title: string;
    category?: string;
}
declare const MAX_TITLE_ATTEMPTS = 3;
/** iOS fallbackTitle(fromFirstUserMessage:) — ~30 chars from first user msg */
export declare function fallbackTitleFromFirstUserMessage(raw: string): string | null;
/** Build conversation summary like iOS (first pair ± last pair, 200 chars each) */
export declare function buildConversationSummary(opts: {
    firstUser: string;
    firstAssistant: string;
    lastUser?: string;
    lastAssistant?: string;
    toolEntries?: Array<{
        name: string;
        args: Record<string, unknown>;
    }>;
}): string;
/** Parse model response into {title, category} — same strategies as iOS */
export declare function parseTitleResponse(responseText: string): TitleResult | null;
/**
 * Call active model with the same prompt shape as iOS callSubModelForTitle.
 * Returns null on failure (caller should apply fallback).
 */
export declare function callModelForTitle(profile: TitleProfile, conversationSummary: string): Promise<TitleResult | null>;
export { MAX_TITLE_ATTEMPTS };
//# sourceMappingURL=session-title.d.ts.map