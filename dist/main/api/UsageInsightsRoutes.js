"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleUsageInsightsRoute = handleUsageInsightsRoute;
const HttpServer_1 = require("./HttpServer");
const UsageInsights_1 = require("../usage/UsageInsights");
const RANGES = ['24h', '7d', '30d', 'all'];
async function handleUsageInsightsRoute(req, res, url, ctx) {
    if (url.pathname !== '/api/usage/insights')
        return false;
    if (req.method !== 'GET') {
        (0, HttpServer_1.jsonReply)(res, 405, { error: 'method_not_allowed' });
        return true;
    }
    try {
        const requested = String(url.searchParams.get('range') || '7d');
        const range = RANGES.includes(requested) ? requested : '7d';
        const profiles = ctx.listProfiles();
        const byId = new Map(profiles.map((profile) => [profile.id, profile]));
        const sessions = ctx.listSessions();
        const bindingById = new Map(sessions.map((session) => [session.id, session.modelBinding]));
        const meta = new Map(sessions.map((session) => [session.id, {
                title: session.title,
                model: session.modelBinding?.model || '',
                provider: session.modelBinding?.provider || '',
            }]));
        const priceFor = (sessionId, provider, model) => {
            const binding = bindingById.get(sessionId);
            const bound = binding?.profileId ? byId.get(binding.profileId) : undefined;
            const fallback = bound || profiles.find((profile) => profile.provider === provider && profile.model === model);
            return fallback?.tokenPrice || null;
        };
        (0, HttpServer_1.jsonReply)(res, 200, (0, UsageInsights_1.collectUsageInsights)({ workspaceDir: ctx.workspaceDir, range, priceFor, meta }));
    }
    catch (error) {
        (0, HttpServer_1.jsonReply)(res, 500, { error: error.message || '无法生成用量洞察。' });
    }
    return true;
}
//# sourceMappingURL=UsageInsightsRoutes.js.map