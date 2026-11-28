/** Presets the menu offers. A custom value may be anything >= the minimum. */
export declare const CONTEXT_COMPACTION_LIMITS: readonly [128000, 256000, 384000, 768000, 1000000];
/** Below this a custom window is a typo, not a smaller model. */
export declare const MIN_CONTEXT_COMPACTION_LIMIT = 128000;
export declare const MAX_CONTEXT_COMPACTION_LIMIT = 10000000;
/** Historical default: start compacting with a fifth of the window still free. */
export declare const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;
/**
 * A ceiling is any window size at or above 128K, not only the five presets: a
 * relay advertising 200K or 500K should be configurable as such instead of
 * being rounded down to a tier that throws away usable context.
 */
export declare function normalizeContextCompactionLimit(value: unknown): number | undefined;
/**
 * Where compaction starts, as a share of the window: 50%–100%. Accepts both
 * `0.85` and `85` so a percentage field cannot silently become 0.0085.
 */
export declare function normalizeContextCompactionThreshold(value: unknown): number | undefined;
//# sourceMappingURL=ContextCompactionSettings.d.ts.map