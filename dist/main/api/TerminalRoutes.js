"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTerminalRoute = handleTerminalRoute;
const HttpServer_1 = require("./HttpServer");
const IDEContext_1 = require("../ide/IDEContext");
async function handleTerminalRoute(req, res, url, ctx) {
    if (url.pathname === '/api/terminal/sessions' && req.method === 'GET') {
        (0, HttpServer_1.jsonReply)(res, 200, { sessions: ctx.terminals.list() });
        return true;
    }
    if (url.pathname === '/api/terminal/sessions' && req.method === 'POST') {
        try {
            const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
            const projectRoot = body.ideProjectRoot === undefined ? ctx.getProjectRoot() || ctx.workspaceDir : (0, IDEContext_1.resolveIDEWorkspaceRoot)(body.ideProjectRoot);
            (0, HttpServer_1.jsonReply)(res, 201, { session: ctx.terminals.create(projectRoot, body.shell) });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (url.pathname.startsWith('/api/terminal/sessions/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const id = parts[3] || '';
        const action = parts[4] || '';
        try {
            if (!id)
                throw new Error('终端会话 ID 无效。');
            if (!action && req.method === 'GET') {
                const after = Number(url.searchParams.get('after') || '0');
                (0, HttpServer_1.jsonReply)(res, 200, ctx.terminals.output(id, after));
                return true;
            }
            if ((action === 'input' || action === 'execute') && req.method === 'POST') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
                ctx.terminals.write(id, action === 'input' ? String(body.input || '') : String(body.command || ''), action === 'execute');
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true });
                return true;
            }
            if (action === 'resize' && req.method === 'POST') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
                ctx.terminals.resize(id, Number(body.cols), Number(body.rows));
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true });
                return true;
            }
            if (action === 'terminate' && req.method === 'POST') {
                await ctx.terminals.terminate(id);
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true });
                return true;
            }
            (0, HttpServer_1.jsonReply)(res, 404, { error: '终端接口不存在' });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    return false;
}
//# sourceMappingURL=TerminalRoutes.js.map