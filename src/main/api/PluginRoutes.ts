/**
 * Local extension plugins: install, lifecycle, tool invocation and sandboxed UI.
 *
 * Plugin UI bytes are served with an opaque-origin CSP (no connect-src), so a
 * panel can render but never reach the API or the host document. Granting that
 * capability is a desktop-only action, which is why the request's desktop
 * authentication state is passed in explicitly.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody, HttpError } from './HttpServer';
import { PluginManager } from '../plugins/PluginManager';
import { PluginMarket } from '../plugins/PluginMarket';
import { MIME_TYPES } from './FileRoutes';

export interface PluginRouteContext {
  plugins: PluginManager;
  market: PluginMarket;
  skillsChanged: () => void;
}

export async function handlePluginRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: PluginRouteContext,
  desktopAuthenticated: boolean,
): Promise<boolean> {
if (url.pathname === '/api/plugins' && req.method === 'GET') {
      jsonReply(res, 200, { plugins: ctx.plugins.list(), pluginsDir: ctx.plugins.pluginsDir });
      return true;
    }

if (url.pathname === '/api/plugins/install' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req) || '{}') as { path?: string };
        const plugin = ctx.plugins.install(String(body.path || ''));
        ctx.skillsChanged();
        jsonReply(res, 201, { plugin });
      } catch (error) { jsonReply(res, 400, { error: (error as Error).message }); }
      return true;
    }

if (url.pathname === '/api/plugins/market/search' && req.method === 'GET') {
      try {
        const result = await ctx.market.search(
          url.searchParams.get('url') || '',
          url.searchParams.get('q') || '',
        );
        jsonReply(res, 200, result);
      } catch (error) { jsonReply(res, 400, { error: (error as Error).message }); }
      return true;
    }

if (url.pathname === '/api/plugins/market/install' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req) || '{}') as { url?: string; id?: string };
        const plugin = await ctx.market.install(String(body.url || ''), String(body.id || ''), ctx.plugins);
        ctx.skillsChanged();
        jsonReply(res, 201, { plugin });
      } catch (error) { jsonReply(res, 400, { error: (error as Error).message }); }
      return true;
    }

if (url.pathname.startsWith('/api/plugins/')) {
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const id = parts[2] || '';
      const action = parts[3] || '';
      try {
        if (!id) throw new Error('插件 ID 无效。');
        if ((action === 'ui' || action === 'panel') && req.method === 'GET') {
          const relative = parts.slice(action === 'panel' ? 5 : 4).join('/');
          const asset = ctx.plugins.resolveUiAsset(id, relative, action === 'panel' ? parts[4] : undefined);
          const ext = path.extname(asset.path).toLowerCase();
          const headers: Record<string, string> = {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
          };
          res.writeHead(200, headers); fs.createReadStream(asset.path).pipe(res); return true;
        }
        if (action === 'enable' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}') as { enabled?: boolean };
          const plugin = ctx.plugins.setEnabled(id, body.enabled === true);
          ctx.skillsChanged(); jsonReply(res, 200, { plugin }); return true;
        }
        if (action === 'reload' && req.method === 'POST') {
          const plugin = ctx.plugins.reload(id);
          ctx.skillsChanged(); jsonReply(res, 200, { plugin }); return true;
        }
        if (action === 'ui-grant' && req.method === 'POST') {
          if (!desktopAuthenticated) throw new HttpError(403, '插件面板仅限本地工作台。');
          const body = JSON.parse(await readBody(req, 4096) || '{}');
          jsonReply(res, 200, ctx.plugins.createUIGrant(id, typeof body.panelId === 'string' ? body.panelId : undefined)); return true;
        }
        if (action === 'ui-grant' && req.method === 'DELETE') {
          const body = JSON.parse(await readBody(req, 4096) || '{}');
          ctx.plugins.revokeUIGrant(id, String(body.token || '')); jsonReply(res, 200, { ok: true }); return true;
        }
        if (action === 'ui-state' && req.method === 'GET') { jsonReply(res, 200, ctx.plugins.readUIState(id)); return true; }
        if (action === 'ui-state' && req.method === 'PUT') {
          const body = JSON.parse(await readBody(req, 70 * 1024) || '{}');
          jsonReply(res, 200, ctx.plugins.writeUIState(id, body.revision, body.value)); return true;
        }
        if (action === 'invoke' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 2 * 1024 * 1024) || '{}') as { tool?: string; arguments?: unknown };
          const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {};
          const controller = new AbortController();
          const abort = () => { if (!res.writableEnded) controller.abort(); };
          res.on('close', abort);
          try { const result = await ctx.plugins.invoke(id, String(body.tool || ''), args, controller.signal); if (!res.destroyed) jsonReply(res, 200, { result }); }
          finally { res.removeListener('close', abort); }
          return true;
        }
        if (!action && req.method === 'DELETE') {
          ctx.plugins.remove(id); ctx.skillsChanged(); jsonReply(res, 200, { ok: true }); return true;
        }
        jsonReply(res, 404, { error: '插件接口不存在。' });
      } catch (error) { jsonReply(res, 400, { error: (error as Error).message }); }
      return true;
    }
  return false;
}
