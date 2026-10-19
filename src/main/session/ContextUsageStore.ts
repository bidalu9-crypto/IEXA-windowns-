// =============================================================================
// Per-session context accounting carried across restarts.
//
// The context meter used to restart at zero whenever the app did: the request
// size lived only in the AgentLoop's compactor, so a reopened conversation was
// re-estimated from the (deliberately bounded) rehydrated working set. The
// session file now keeps the last known request size, and a reopen continues
// from it instead of inventing a smaller conversation.
// =============================================================================
import * as fs from 'fs';
import { JsonStore } from '../persistence/JsonStore';

export interface ContextUsageSnapshot {
  usedTokens: number;
  contextWindow: number;
  compactThreshold: number;
  /** False once a provider receipt sized the last request. */
  estimated: boolean;
  updatedAt: number;
}

/** Shape the AgentLoop reports on every context event. */
export interface ContextStatusLike {
  usedTokens?: unknown;
  contextWindow?: unknown;
  compactThreshold?: unknown;
  estimated?: unknown;
}

function positive(value: unknown): number {
  const numeric = Math.floor(Number(value) || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/** Normalize a persisted record; anything malformed is simply absent. */
export function normalizeContextUsage(raw: unknown): ContextUsageSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const usedTokens = positive(value.usedTokens);
  const contextWindow = positive(value.contextWindow);
  if (!usedTokens || !contextWindow) return null;
  return {
    usedTokens,
    contextWindow,
    compactThreshold: positive(value.compactThreshold) || Math.floor(contextWindow * 0.8),
    estimated: value.estimated !== false,
    updatedAt: positive(value.updatedAt) || Date.now(),
  };
}

/** A live status becomes a storable record, or null while the size is unknown. */
export function contextUsageFromStatus(status: ContextStatusLike | null | undefined): ContextUsageSnapshot | null {
  if (!status) return null;
  return normalizeContextUsage({
    usedTokens: status.usedTokens,
    contextWindow: status.contextWindow,
    compactThreshold: status.compactThreshold,
    estimated: status.estimated,
    updatedAt: Date.now(),
  });
}

/** Rebuild the live status shape the renderer paints from. */
export function contextUsageStatus(snapshot: ContextUsageSnapshot): {
  usedTokens: number;
  contextWindow: number;
  compactThreshold: number;
  estimated: boolean;
  state: 'ok' | 'near-limit';
} {
  return {
    usedTokens: snapshot.usedTokens,
    contextWindow: snapshot.contextWindow,
    compactThreshold: snapshot.compactThreshold,
    estimated: snapshot.estimated,
    state: snapshot.usedTokens >= snapshot.compactThreshold ? 'near-limit' : 'ok',
  };
}

export function readContextUsage(filePath: string): ContextUsageSnapshot | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const state = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    return normalizeContextUsage(state.usage);
  } catch {
    return null;
  }
}

/**
 * Merge the record into the session file. Content and summary belong to the
 * caller that owns them, so a usage write must never replace them with blanks.
 */
export function writeContextUsage(filePath: string, snapshot: ContextUsageSnapshot): void {
  try {
    let state: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (parsed && typeof parsed === 'object') state = parsed as Record<string, unknown>;
      } catch { /* rebuild from the fields we own */ }
    }
    const next = { ...state, usage: snapshot, updatedAt: Date.now() };
    new JsonStore<Record<string, unknown>>(filePath, () => next).saveSync(next);
  } catch { /* accounting is best effort; never break a turn for it */ }
}

/**
 * Turning every streaming status into a write would hammer the disk. Persist
 * once the size has moved by a meaningful amount; the turn end always writes.
 */
export function shouldPersistContextUsage(
  previous: ContextUsageSnapshot | null | undefined,
  next: ContextUsageSnapshot,
): boolean {
  if (!previous) return true;
  if (previous.contextWindow !== next.contextWindow) return true;
  if (previous.compactThreshold !== next.compactThreshold) return true;
  const step = Math.max(1000, Math.floor(next.contextWindow * 0.01));
  return Math.abs(next.usedTokens - previous.usedTokens) >= step;
}
