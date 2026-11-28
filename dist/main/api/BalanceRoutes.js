"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBalanceRoute = handleBalanceRoute;
const HttpServer_1 = require("./HttpServer");
async function handleBalanceRoute(req, res, url, ctx) {
    const match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/balance$/);
    if (!match || req.method !== 'GET')
        return false;
    const profile = ctx.findProfile(decodeURIComponent(match[1]));
    if (!profile) {
        (0, HttpServer_1.jsonReply)(res, 404, { error: '模型配置不存在。' });
        return true;
    }
    try {
        const result = await ctx.fetchBalance(profile, { force: url.searchParams.get('refresh') === '1' });
        (0, HttpServer_1.jsonReply)(res, 200, result);
    }
    catch (error) {
        (0, HttpServer_1.jsonReply)(res, 200, {
            status: 'unsupported',
            message: error.message || '余额读取失败',
            updatedAt: Date.now(),
        });
    }
    return true;
}
//# sourceMappingURL=BalanceRoutes.js.map