"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePluginRoute = handlePluginRoute;
/**
 * Local extension plugins: install, lifecycle, tool invocation and sandboxed UI.
 *
 * Plugin UI bytes are served with an opaque-origin CSP (no connect-src), so a
 * panel can render but never reach the API or the host document. Granting that
 * capability is a desktop-only action, which is why the request's desktop
 * authentication state is passed in explicitly.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const HttpServer_1 = require("./HttpServer");
const FileRoutes_1 = require("./FileRoutes");
async function handlePluginRoute(req, res, url, ctx, desktopAuthenticated) {
    if (url.pathname === '/api/plugins' && req.method === 'GET') {
        (0, HttpServer_1.jsonReply)(res, 200, { plugins: ctx.plugins.list(), pluginsDir: ctx.plugins.pluginsDir });
        return true;
    }
    if (url.pathname === '/api/plugins/install' && req.method === 'POST') {
        try {
            const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
            const plugin = ctx.plugins.install(String(body.path || ''));
            ctx.skillsChanged();
            (0, HttpServer_1.jsonReply)(res, 201, { plugin });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (url.pathname === '/api/plugins/market/search' && req.method === 'GET') {
        try {
            const result = await ctx.market.search(url.searchParams.get('url') || '', url.searchParams.get('q') || '');
            (0, HttpServer_1.jsonReply)(res, 200, result);
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (url.pathname === '/api/plugins/market/install' && req.method === 'POST') {
        try {
            const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
            const plugin = await ctx.market.install(String(body.url || ''), String(body.id || ''), ctx.plugins);
            ctx.skillsChanged();
            (0, HttpServer_1.jsonReply)(res, 201, { plugin });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (url.pathname.startsWith('/api/plugins/')) {
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const id = parts[2] || '';
        const action = parts[3] || '';
        try {
            if (!id)
                throw new Error('插件 ID 无效。');
            if ((action === 'ui' || action === 'panel') && req.method === 'GET') {
                const relative = parts.slice(action === 'panel' ? 5 : 4).join('/');
                const asset = ctx.plugins.resolveUiAsset(id, relative, action === 'panel' ? parts[4] : undefined);
                const ext = path.extname(asset.path).toLowerCase();
                const headers = {
                    'Content-Type': FileRoutes_1.MIME_TYPES[ext] || 'application/octet-stream',
                    'Cache-Control': 'no-store',
                    'Content-Security-Policy': "default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
                };
                res.writeHead(200, headers);
                fs.createReadStream(asset.path).pipe(res);
                return true;
            }
            if (action === 'enable' && req.method === 'POST') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
                const plugin = ctx.plugins.setEnabled(id, body.enabled === true);
                ctx.skillsChanged();
                (0, HttpServer_1.jsonReply)(res, 200, { plugin });
                return true;
            }
            if (action === 'reload' && req.method === 'POST') {
                const plugin = ctx.plugins.reload(id);
                ctx.skillsChanged();
                (0, HttpServer_1.jsonReply)(res, 200, { plugin });
                return true;
            }
            if (action === 'ui-grant' && req.method === 'POST') {
                if (!desktopAuthenticated)
                    throw new HttpServer_1.HttpError(403, '插件面板仅限本地工作台。');
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req, 4096) || '{}');
                (0, HttpServer_1.jsonReply)(res, 200, ctx.plugins.createUIGrant(id, typeof body.panelId === 'string' ? body.panelId : undefined));
                return true;
            }
            if (action === 'ui-grant' && req.method === 'DELETE') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req, 4096) || '{}');
                ctx.plugins.revokeUIGrant(id, String(body.token || ''));
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true });
                return true;
            }
            if (action === 'ui-state' && req.method === 'GET') {
                (0, HttpServer_1.jsonReply)(res, 200, ctx.plugins.readUIState(id));
                return true;
            }
            if (action === 'ui-state' && req.method === 'PUT') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req, 70 * 1024) || '{}');
                (0, HttpServer_1.jsonReply)(res, 200, ctx.plugins.writeUIState(id, body.revision, body.value));
                return true;
            }
            if (action === 'invoke' && req.method === 'POST') {
                const body = JSON.parse(await (0, HttpServer_1.readBody)(req, 2 * 1024 * 1024) || '{}');
                const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {};
                const controller = new AbortController();
                const abort = () => { if (!res.writableEnded)
                    controller.abort(); };
                res.on('close', abort);
                try {
                    const result = await ctx.plugins.invoke(id, String(body.tool || ''), args, controller.signal);
                    if (!res.destroyed)
                        (0, HttpServer_1.jsonReply)(res, 200, { result });
                }
                finally {
                    res.removeListener('close', abort);
                }
                return true;
            }
            if (!action && req.method === 'DELETE') {
                ctx.plugins.remove(id);
                ctx.skillsChanged();
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true });
                return true;
            }
            (0, HttpServer_1.jsonReply)(res, 404, { error: '插件接口不存在。' });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    return false;
}
//# sourceMappingURL=PluginRoutes.js.map