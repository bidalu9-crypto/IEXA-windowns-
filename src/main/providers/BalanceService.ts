/**
 * Account balance lookup for a configured model profile.
 *
 * Providers expose this in incompatible ways, so the service tries the shapes
 * that actually exist in the wild and normalises the first usable answer:
 *
 *   DeepSeek        GET {root}/user/balance
 *   OpenRouter      GET {origin}/api/v1/credits
 *   WorkBuddy 系    GET {root}/status            (账号池：accounts[].credits)
 *   New API / One API relays, OpenAI-compatible gateways
 *                   GET {root}/dashboard/billing/subscription
 *                   GET {root}/dashboard/billing/usage
 *                   GET {root}/v1/credits
 *
 * Nothing here is guessed: a gateway that answers 404 everywhere is reported as
 * unsupported and the UI stays quiet, because a fake "¥0.00" is worse than no
 * reading at all.
 */
import * as crypto from 'crypto';
import { ModelProfileLike } from './BalanceTypes';

export interface ProviderBalance {
  status: 'ok' | 'unsupported' | 'error';
  currency?: string;
  remaining?: number;
  used?: number;
  total?: number;
  granted?: number;
  toppedUp?: number;
  source?: string;
  message?: string;
  updatedAt: number;
}

const TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 256 * 1024;
const CACHE_TTL_MS = 90_000;
const cache = new Map<string, { value: ProviderBalance; at: number }>();

function cacheKey(profile: ModelProfileLike): string {
  const fingerprint = crypto.createHash('sha256')
    .update(`${profile.baseURL || ''}\u0000${profile.apiKey || ''}`)
    .digest('hex')
    .slice(0, 12);
  return `${profile.id}:${fingerprint}`;
}

/** Strip a known API suffix but keep any gateway path prefix. */
function normaliseBase(raw: string | undefined, provider: string): string {
  const fallback = provider === 'deepseek'
    ? 'https://api.deepseek.com'
    : provider === 'anthropic'
      ? 'https://api.anthropic.com'
      : 'https://api.openai.com/v1';
  let base = String(raw || fallback).trim().replace(/\/+$/, '');
  base = base.replace(/\/v1\/messages$/i, '/v1');
  return base;
}

function rootOf(base: string): string {
  return base.replace(/\/v1$/i, '');
}

function amount(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Settings store secrets as `{ $secretRef }` on disk and as strings once
 * decrypted. A profile that reaches this module still holding the reference has
 * not been hydrated: sending it would put `[object Object]` in the header, and
 * every gateway would answer 401 — which then looked like "no balance endpoint".
 * Treat anything that is not a non-empty string as missing instead of guessing.
 */
function usableKey(profile: { apiKey?: unknown }): string {
  const value = profile?.apiKey;
  return typeof value === 'string' ? value.trim() : '';
}

async function readJson(url: string, apiKey: string, userAgent?: string): Promise<{ status: number; body: any } | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (response.status >= 300 && response.status < 400) return null;
  const text = await response.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return null;
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { return { status: response.status, body: null }; }
  return { status: response.status, body };
}

function fromDeepSeek(body: any): ProviderBalance | null {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const info = infos[0];
  const remaining = amount(info?.total_balance);
  if (remaining === undefined) return null;
  return {
    status: 'ok',
    currency: String(info.currency || 'CNY').toUpperCase(),
    remaining,
    granted: amount(info.granted_balance),
    toppedUp: amount(info.topped_up_balance),
    source: 'DeepSeek 余额接口',
    updatedAt: Date.now(),
  };
}

function fromCredits(body: any, source: string): ProviderBalance | null {
  const data = body?.data && typeof body.data === 'object' ? body.data : body;
  const total = amount(data?.total_credits) ?? amount(data?.credits);
  const used = amount(data?.total_usage) ?? amount(data?.usage);
  const remaining = amount(data?.limit_remaining)
    ?? (total !== undefined ? total - (used || 0) : undefined);
  if (remaining === undefined && total === undefined) return null;
  return {
    status: 'ok',
    currency: 'USD',
    remaining: remaining ?? total,
    used,
    total,
    source,
    updatedAt: Date.now(),
  };
}

function fromBilling(subscription: any, usage: any): ProviderBalance | null {
  const limit = amount(subscription?.hard_limit_usd) ?? amount(subscription?.soft_limit_usd);
  if (limit === undefined) return null;
  // One API returns the remaining quota in hard_limit_usd; OpenAI returns the
  // monthly ceiling. Both are shown as the available allowance, and usage is
  // reported separately instead of subtracting twice.
  const usedCents = amount(usage?.total_usage);
  return {
    status: 'ok',
    currency: 'USD',
    remaining: limit,
    used: usedCents === undefined ? undefined : usedCents / 100,
    source: '网关账单接口',
    updatedAt: Date.now(),
  };
}

/**
 * WorkBuddy / workbuddy2api style gateways rotate a pool of upstream accounts
 * and publish that pool at GET {root}/status (Bearer auth). Each account carries
 * `credits` (remaining) and `credits_total` (the quota it was granted), so the
 * pool's numbers are the caller's real allowance on this kind of relay.
 *
 * The shape is distinctive enough to detect: no `accounts` array, or entries
 * without numeric credits, means this is some other gateway and we return null
 * so the remaining probes still run.
 */
function fromWorkbuddyPool(body: any): ProviderBalance | null {
  const accounts = Array.isArray(body?.accounts) ? body.accounts : null;
  if (!accounts || accounts.length === 0) return null;
  let remaining = 0;
  let total = 0;
  let counted = 0;
  let usable = 0;
  for (const account of accounts) {
    const credits = amount(account?.credits);
    if (credits === undefined) continue;
    counted += 1;
    remaining += credits;
    const quota = amount(account?.credits_total);
    if (quota !== undefined && quota > 0) total += quota;
    if (account?.cooling !== true && account?.disabled !== true) usable += 1;
  }
  if (!counted) return null;
  const pooled = total > 0 ? total : undefined;
  return {
    status: 'ok',
    currency: 'credits',
    remaining: Math.max(0, remaining),
    total: pooled,
    used: pooled === undefined ? undefined : Math.max(0, pooled - remaining),
    source: usable < counted
      ? `WorkBuddy 账号池 · ${counted} 个账号（${usable} 个可用）`
      : `WorkBuddy 账号池 · ${counted} 个账号`,
    updatedAt: Date.now(),
  };
}

async function tryWorkbuddyPool(base: string, profile: ModelProfileLike, credential: string): Promise<ProviderBalance | null> {
  const result = await readJson(`${rootOf(base)}/status`, credential, profile.userAgent);
  if (result?.status !== 200) return null;
  return fromWorkbuddyPool(result.body);
}

async function tryDeepSeek(base: string, profile: ModelProfileLike, credential: string): Promise<ProviderBalance | null> {
  const result = await readJson(`${rootOf(base)}/user/balance`, credential, profile.userAgent);
  if (result?.status !== 200) return null;
  return fromDeepSeek(result.body);
}

async function tryCredits(url: string, profile: ModelProfileLike, source: string, credential: string): Promise<ProviderBalance | null> {
  const result = await readJson(url, credential, profile.userAgent);
  if (result?.status !== 200) return null;
  return fromCredits(result.body, source);
}

async function tryBilling(base: string, profile: ModelProfileLike, credential: string): Promise<ProviderBalance | null> {
  const subscription = await readJson(`${rootOf(base)}/dashboard/billing/subscription`, credential, profile.userAgent);
  if (subscription?.status !== 200) return null;
  const usage = await readJson(`${rootOf(base)}/dashboard/billing/usage`, credential, profile.userAgent);
  return fromBilling(subscription.body, usage?.status === 200 ? usage.body : null);
}

/**
 * Sub2API (Wei-Shaw/sub2api) relays answer GET /v1/usage with the caller's own
 * allowance. Shape: { mode: 'quota_limited', quota: { limit, used, remaining },
 * remaining, rate_limits: [...] }. `remaining` may legitimately be negative —
 * that is how an overdrawn key looks — so it must not be clamped.
 */
function fromSub2ApiUsage(body: any): ProviderBalance | null {
  if (!body || typeof body !== 'object') return null;
  const num = (value: unknown): number | null => (Number.isFinite(Number(value)) ? Number(value) : null);
  const quota = body.quota && typeof body.quota === 'object' ? body.quota : null;
  const remaining = quota ? num(quota.remaining) : num(body.remaining);
  if (remaining === null) return null;
  const used = quota ? num(quota.used) : null;
  const limit = quota ? num(quota.limit) : null;
  const rateLimits = Array.isArray(body.rate_limits) ? body.rate_limits.length : 0;
  return {
    status: 'ok',
    currency: 'USD',
    remaining,
    ...(used !== null ? { used } : {}),
    ...(limit !== null ? { total: limit } : {}),
    source: rateLimits > 0 ? `Sub2API · ${rateLimits} 个限额窗口` : 'Sub2API',
    updatedAt: Date.now(),
  };
}

async function trySub2Api(base: string, profile: ModelProfileLike, credential: string): Promise<ProviderBalance | null> {
  const root = rootOf(base);
  for (const path of ['/v1/usage', '/usage']) {
    const result = await readJson(`${root}${path}`, credential, profile.userAgent);
    if (!result || result.status !== 200) continue;
    const value = fromSub2ApiUsage(result.body);
    if (value) return value;
  }
  return null;
}

/** Extract a balance from the shapes relays commonly expose. */
function fromGeneric(body: any): ProviderBalance | null {
  if (!body || typeof body !== 'object') return null;
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  const num = (value: unknown): number | null => (Number.isFinite(Number(value)) ? Number(value) : null);
  // New API / One API expose quota in 1/500000 USD units.
  const quota = num(data.quota);
  if (quota !== null) {
    const used = num(data.used_quota) ?? 0;
    const total = (quota + used) / 500000;
    return { status: 'ok', currency: 'USD', remaining: quota / 500000, used: used / 500000, total, source: '站点额度接口', updatedAt: Date.now() };
  }
  const available = num(data.total_available) ?? num(data.available) ?? num(data.balance) ?? num(data.credits) ?? num(data.remain);
  if (available === null) return null;
  const currency = String(data.currency || body.currency || '').toUpperCase();
  return {
    status: 'ok',
    currency: currency === 'CNY' || currency === 'USD' || currency === 'EUR' ? currency : 'credits',
    remaining: available,
    ...(num(data.used) !== null ? { used: num(data.used)! } : {}),
    source: '站点余额接口',
    updatedAt: Date.now(),
  };
}

async function tryGeneric(base: string, profile: ModelProfileLike, credential: string): Promise<ProviderBalance | null> {
  const root = rootOf(base);
  const paths = [
    '/api/user/self', '/api/v1/user/self', '/v1/dashboard/billing/credit_grants',
    '/dashboard/billing/credit_grants', '/api/credits', '/user/info',
  ];
  for (const path of paths) {
    const result = await readJson(`${root}${path}`, credential, profile.userAgent);
    if (!result || result.status !== 200) continue;
    const value = fromGeneric(result.body);
    if (value) return value;
  }
  return null;
}

/** Resolve a balance for one profile. Never throws; failures become a status. */
export async function fetchProviderBalance(profile: ModelProfileLike, options: { force?: boolean } = {}): Promise<ProviderBalance> {
  const key = cacheKey(profile);
  if (!options.force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }
  const finish = (value: ProviderBalance): ProviderBalance => {
    cache.set(key, { value, at: Date.now() });
    return value;
  };
  const credential = usableKey(profile);
  if (!credential) return finish({ status: 'unsupported', message: '尚未配置 API 密钥', updatedAt: Date.now() });

  const base = normaliseBase(profile.baseURL, profile.provider);
  let host = '';
  try { host = new URL(base).host; } catch { return finish({ status: 'unsupported', message: '接口地址无效', updatedAt: Date.now() }); }

  const attempts: Array<Promise<ProviderBalance | null>> = [];
  if (profile.provider === 'deepseek' || host.endsWith('deepseek.com')) {
    attempts.push(tryDeepSeek(base, profile, credential));
  } else if (host.endsWith('openrouter.ai')) {
    attempts.push(tryCredits(`${new URL(base).origin}/api/v1/credits`, profile, 'OpenRouter 信用额度', credential));
  } else {
    // Sub2API is the most common relay family here and answers a distinctive
    // /v1/usage, so it goes first; every probe is a cheap 404 for the others.
    attempts.push(trySub2Api(base, profile, credential));
    // Pool gateways answer /status with a distinctive body; probing it first
    // keeps a 404-heavy relay from burning the other three requests.
    attempts.push(tryWorkbuddyPool(base, profile, credential));
    attempts.push(tryBilling(base, profile, credential));
    attempts.push(tryCredits(`${rootOf(base)}/v1/credits`, profile, '网关信用额度', credential));
    attempts.push(tryDeepSeek(base, profile, credential));
    attempts.push(tryGeneric(base, profile, credential));
  }

  for (const attempt of attempts) {
    const value = await attempt;
    if (value) return finish(value);
  }
  // Reachable gateways that simply do not implement a balance route stay quiet;
  // a 404 is not an error the user can act on.
  return finish({
    status: 'unsupported',
    message: '该服务商未提供余额接口',
    updatedAt: Date.now(),
  });
}

/** Only for tests; the cache is process-local. */
export function clearBalanceCache(): void {
  cache.clear();
}
