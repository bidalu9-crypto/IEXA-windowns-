import type * as http from 'http';
export declare const DEFAULT_TTS_VOICE = "zh-CN-YunyangNeural";
export declare const CACHE_LIMIT_BYTES: number;
/**
 * Drop the oldest cached clips until the directory fits the budget.
 *
 * Runs after a synthesis finishes rather than on a timer: the only moment the
 * size changes is when something is written, and a background sweeper would need
 * its own lifecycle for no gain.
 */
export declare function trimCache(cacheDir: string, limitBytes?: number): number;
/** Split prose into chunks that respect sentence boundaries. */
export declare function splitForSpeech(text: string, limit?: number): string[];
/**
 * Markdown read aloud is mostly noise: fence contents, tables and link targets
 * are not sentences. Keep the prose, drop the scaffolding.
 */
export declare function stripForSpeech(markdown: string): string;
export interface TtsRouteContext {
    workspaceDir: string;
}
/**
 * @returns true when the request was handled here.
 */
export declare function handleTtsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: TtsRouteContext): Promise<boolean>;
//# sourceMappingURL=TtsRoutes.d.ts.map