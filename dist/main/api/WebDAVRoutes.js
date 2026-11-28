"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWebDAVRoute = handleWebDAVRoute;
const HttpServer_1 = require("./HttpServer");
async function handleWebDAVRoute(req, res, url, context) {
    if (url.pathname === '/api/webdav/config') {
        if (req.method === 'GET') {
            const config = context.loadConfig();
            (0, HttpServer_1.jsonReply)(res, 200, { ...config, password: context.maskPassword(config.password) });
            return true;
        }
        if (req.method === 'POST') {
            try {
                const input = JSON.parse(await (0, HttpServer_1.readBody)(req));
                const existing = context.loadConfig();
                if (input.password && input.password !== context.maskPassword(existing.password))
                    existing.password = input.password;
                existing.url = input.url || existing.url;
                existing.username = input.username || existing.username;
                existing.enabled = input.enabled !== undefined ? input.enabled : existing.enabled;
                existing.autoSync = input.autoSync !== undefined ? input.autoSync : existing.autoSync;
                context.saveConfig(existing);
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true });
            }
            catch {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '无效的 JSON' });
            }
            return true;
        }
    }
    if (url.pathname === '/api/webdav/test' && req.method === 'POST') {
        try {
            const { url: endpoint, username, password } = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const result = await context.testConnection({ url: endpoint, username, password, enabled: true, autoSync: false, lastSync: 0 });
            (0, HttpServer_1.jsonReply)(res, result.ok ? 200 : 400, result);
        }
        catch {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '无效的 JSON' });
        }
        return true;
    }
    if (url.pathname === '/api/webdav/sync' && req.method === 'POST') {
        const config = context.loadConfig();
        if (!config.url) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: 'WebDAV 未配置' });
            return true;
        }
        const result = await context.syncAll(config, context.workspaceDir, context.sessionsDir, context.settingsFile, context.sessionsStoreFile);
        (0, HttpServer_1.jsonReply)(res, result.ok ? 200 : 500, result);
        return true;
    }
    if (url.pathname === '/api/webdav/status' && req.method === 'GET') {
        const config = context.loadConfig();
        (0, HttpServer_1.jsonReply)(res, 200, { configured: !!config.url, enabled: config.enabled, autoSync: config.autoSync, lastSync: config.lastSync });
        return true;
    }
    if (url.pathname === '/api/webdav/conflicts' && req.method === 'GET') {
        (0, HttpServer_1.jsonReply)(res, 200, { conflicts: context.listConflicts(context.workspaceDir) });
        return true;
    }
    if (!url.pathname.startsWith('/api/webdav/conflicts/'))
        return false;
    const [encodedId, action] = url.pathname.slice('/api/webdav/conflicts/'.length).split('/');
    const id = decodeURIComponent(encodedId || '');
    if (!id || !/^conflict_[A-Za-z0-9_-]+$/.test(id)) {
        (0, HttpServer_1.jsonReply)(res, 400, { error: '无效的冲突标识。' });
        return true;
    }
    if (!action && req.method === 'GET') {
        const preview = context.previewConflict(context.workspaceDir, id);
        if (!preview)
            (0, HttpServer_1.jsonReply)(res, 404, { error: '冲突不存在或已处理。' });
        else
            (0, HttpServer_1.jsonReply)(res, 200, preview);
        return true;
    }
    if (action === 'resolve' && req.method === 'POST') {
        try {
            const parsed = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const resolution = String(parsed.resolution || '');
            if (resolution !== 'local' && resolution !== 'remote' && resolution !== 'merge') {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '无效的处理方式。' });
                return true;
            }
            const config = context.loadConfig();
            if (!config.url) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: 'WebDAV 未配置。' });
                return true;
            }
            const resolved = await context.resolveConflict(config, context.workspaceDir, id, resolution, typeof parsed.content === 'string' ? parsed.content : undefined);
            if (!resolved)
                (0, HttpServer_1.jsonReply)(res, 404, { error: '冲突不存在或已处理。' });
            else
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, conflict: resolved });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '冲突处理失败。' });
        }
        return true;
    }
    return false;
}
//# sourceMappingURL=WebDAVRoutes.js.map