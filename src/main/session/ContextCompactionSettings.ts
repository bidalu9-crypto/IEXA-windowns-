// =============================================================================
// Context compaction settings — window ceiling and trigger point
//
// Kept out of server.ts so the bootstrap stays a bootstrap. Pure functions: the
// route layer owns persistence, the agent loop owns the resulting behaviour.
// =============================================================================

/** Presets the menu offers. A custom value may be anything >= the minimum. */
export const CONTEXT_COMPACTION_LIMITS = [128_000, 256_000, 384_000, 768_000, 1_000_000] as const;

/** Below this a custom window is a typo, not a smaller model. */
export const MIN_CONTEXT_COMPACTION_LIMIT = 128_000;
export const MAX_CONTEXT_COMPACTION_LIMIT = 10_000_000;

/** Historical default: start compacting with a fifth of the window still free. */
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;

/**
 * A ceiling is any window size at or above 128K, not only the five presets: a
 * relay advertising 200K or 500K should be configurable as such instead of
 * being rounded down to a tier that throws away usable context.
 */
export function normalizeContextCompactionLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '' || value === 'auto' || value === '0') return undefined;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return undefined;
  if (numeric < MIN_CONTEXT_COMPACTION_LIMIT || numeric > MAX_CONTEXT_COMPACTION_LIMIT) return undefined;
  return numeric;
}

/**
 * Where compaction starts, as a share of the window: 50%–100%. Accepts both
 * `0.85` and `85` so a percentage field cannot silently become 0.0085.
 */
export function normalizeContextCompactionThreshold(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '' || value === 'auto') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const ratio = numeric > 1 ? numeric / 100 : numeric;
  if (ratio < 0.5 || ratio > 1) return undefined;
  return Math.round(ratio * 100) / 100;
}
