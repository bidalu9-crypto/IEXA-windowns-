// =============================================================================
// Usage insights route — one read-only endpoint behind the context dashboard.
// =============================================================================
import * as http from 'http';
import { URL } from 'url';
import { jsonReply } from './HttpServer';
import { collectUsageInsights, UsageRange, TokenPrice } from '../usage/UsageInsights';

export interface UsageRouteContext {
  workspaceDir: string;
  listProfiles(): Array<{ id: string; provider: string; model: string; tokenPrice?: TokenPrice }>;
  listSessions(): Array<{
    id: string;
    title: string;
    modelBinding?: { profileId?: string; provider?: string; model?: string };
  }>;
}

const RANGES: UsageRange[] = ['24h', '7d', '30d', 'all'];

export async function handleUsageInsightsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: UsageRouteContext,
): Promise<boolean> {
  if (url.pathname !== '/api/usage/insights') return false;
  if (req.method !== 'GET') {
    jsonReply(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  try {
    const requested = String(url.searchParams.get('range') || '7d');
    const range: UsageRange = (RANGES as string[]).includes(requested) ? requested as UsageRange : '7d';

    const profiles = ctx.listProfiles();
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const sessions = ctx.listSessions();
    const bindingById = new Map(sessions.map((session) => [session.id, session.modelBinding]));
    const meta = new Map(sessions.map((session) => [session.id, {
      title: session.title,
      model: session.modelBinding?.model || '',
      provider: session.modelBinding?.provider || '',
    }]));

    const priceFor = (sessionId: string, provider: string, model: string): TokenPrice | null => {
      const binding = bindingById.get(sessionId);
      const bound = binding?.profileId ? byId.get(binding.profileId) : undefined;
      const fallback = bound || profiles.find((profile) => profile.provider === provider && profile.model === model);
      return fallback?.tokenPrice || null;
    };

    jsonReply(res, 200, collectUsageInsights({ workspaceDir: ctx.workspaceDir, range, priceFor, meta }));
  } catch (error) {
    jsonReply(res, 500, { error: (error as Error).message || '无法生成用量洞察。' });
  }
  return true;
}
