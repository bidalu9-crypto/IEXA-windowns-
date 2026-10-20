/**
 * Account balance lookup for a configured model profile.
 *
 * Providers expose this in incompatible ways, so the service tries the shapes
 * that actually exist in the wild and normalises the first usable answer:
 *
 *   DeepSeek        GET {root}/user/balance
 *   OpenRouter      GET {origin}/api/v1/credits
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

async function tryDeepSeek(base: string, profile: ModelProfileLike): Promise<ProviderBalance | null> {
  const result = await readJson(`${rootOf(base)}/user/balance`, profile.apiKey, profile.userAgent);
  if (result?.status !== 200) return null;
  return fromDeepSeek(result.body);
}

async function tryCredits(url: string, profile: ModelProfileLike, source: string): Promise<ProviderBalance | null> {
  const result = await readJson(url, profile.apiKey, profile.userAgent);
  if (result?.status !== 200) return null;
  return fromCredits(result.body, source);
}

async function tryBilling(base: string, profile: ModelProfileLike): Promise<ProviderBalance | null> {
  const subscription = await readJson(`${rootOf(base)}/dashboard/billing/subscription`, profile.apiKey, profile.userAgent);
  if (subscription?.status !== 200) return null;
  const usage = await readJson(`${rootOf(base)}/dashboard/billing/usage`, profile.apiKey, profile.userAgent);
  return fromBilling(subscription.body, usage?.status === 200 ? usage.body : null);
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
  if (!profile.apiKey) return finish({ status: 'unsupported', message: '尚未配置 API 密钥', updatedAt: Date.now() });

  const base = normaliseBase(profile.baseURL, profile.provider);
  let host = '';
  try { host = new URL(base).host; } catch { return finish({ status: 'unsupported', message: '接口地址无效', updatedAt: Date.now() }); }

  const attempts: Array<Promise<ProviderBalance | null>> = [];
  if (profile.provider === 'deepseek' || host.endsWith('deepseek.com')) {
    attempts.push(tryDeepSeek(base, profile));
  } else if (host.endsWith('openrouter.ai')) {
    attempts.push(tryCredits(`${new URL(base).origin}/api/v1/credits`, profile, 'OpenRouter 信用额度'));
  } else {
    attempts.push(tryBilling(base, profile));
    attempts.push(tryCredits(`${rootOf(base)}/v1/credits`, profile, '网关信用额度'));
    attempts.push(tryDeepSeek(base, profile));
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
