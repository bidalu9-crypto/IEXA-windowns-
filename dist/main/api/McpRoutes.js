"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMcpRoute = handleMcpRoute;
const HttpServer_1 = require("./HttpServer");
async function handleMcpRoute(req, res, url, ctx) {
    if (url.pathname === '/api/mcp/servers' && req.method === 'GET') {
        (0, HttpServer_1.jsonReply)(res, 200, { servers: ctx.mcp.list() });
        return true;
    }
    if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
        try {
            const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
            (0, HttpServer_1.jsonReply)(res, 201, { server: ctx.mcp.add({
                    name: String(body.name || ''), transport: body.transport === 'http' ? 'http' : 'stdio', command: body.command,
                    args: Array.isArray(body.args) ? body.args : [], url: body.url, enabled: body.enabled !== false,
                }) });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (url.pathname.startsWith('/api/mcp/servers/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const id = parts[3] || '';
        const action = parts[4] || '';
        try {
            if (!id)
                throw new Error('MCP Server ID 无效。');
            if (!action && req.method === 'DELETE') {
                ctx.mcp.remove(id);
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true });
                return true;
            }
            if (action === 'connect' && req.method === 'POST') {
                (0, HttpServer_1.jsonReply)(res, 200, { server: await ctx.mcp.connect(id) });
                return true;
            }
            if (action === 'disconnect' && req.method === 'POST') {
                (0, HttpServer_1.jsonReply)(res, 200, { server: ctx.mcp.disconnect(id) });
                return true;
            }
            if (action === 'call' && req.method === 'POST') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
                const result = await ctx.mcp.callTool(id, String(body.name || ''), body.arguments && typeof body.arguments === 'object' ? body.arguments : {});
                (0, HttpServer_1.jsonReply)(res, 200, { result });
                return true;
            }
            if (action === 'resource' && req.method === 'POST') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
                const result = await ctx.mcp.readResource(id, String(body.uri || ''));
                (0, HttpServer_1.jsonReply)(res, 200, { result });
                return true;
            }
            (0, HttpServer_1.jsonReply)(res, 404, { error: 'MCP 接口不存在' });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    return false;
}
//# sourceMappingURL=McpRoutes.js.map