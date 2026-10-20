/**
 * Read-only account balance for one model profile.
 *
 * The key never leaves this process: the route resolves the profile server-side
 * and returns only the normalised amount.
 */
import * as http from 'http';
import { URL } from 'url';
import { jsonReply } from './HttpServer';
import { ModelProfileLike } from '../providers/BalanceTypes';
import { ProviderBalance } from '../providers/BalanceService';

export interface BalanceRoutesContext {
  findProfile(id: string): ModelProfileLike | null;
  fetchBalance(profile: ModelProfileLike, options: { force?: boolean }): Promise<ProviderBalance>;
}

export async function handleBalanceRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: BalanceRoutesContext,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/balance$/);
  if (!match || req.method !== 'GET') return false;
  const profile = ctx.findProfile(decodeURIComponent(match[1]));
  if (!profile) { jsonReply(res, 404, { error: '模型配置不存在。' }); return true; }
  try {
    const result = await ctx.fetchBalance(profile, { force: url.searchParams.get('refresh') === '1' });
    jsonReply(res, 200, result);
  } catch (error) {
    jsonReply(res, 200, {
      status: 'unsupported',
      message: (error as Error).message || '余额读取失败',
      updatedAt: Date.now(),
    });
  }
  return true;
}
