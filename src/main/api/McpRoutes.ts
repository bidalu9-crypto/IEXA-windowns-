/**
 * MCP servers: registration, connection lifecycle and tool/resource calls.
 *
 * Calls are proxied straight through; the manager owns timeouts and the
 * connected-client pool.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody, HttpError } from './HttpServer';
import { McpManager } from '../mcp/McpManager';

export interface McpRouteContext {
  mcp: McpManager;
}

export async function handleMcpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: McpRouteContext,
): Promise<boolean> {
if (url.pathname === '/api/mcp/servers' && req.method === 'GET') {
      jsonReply(res, 200, { servers: ctx.mcp.list() });
      return true;
    }

if (url.pathname === '/api/mcp/servers' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        jsonReply(res, 201, { server: ctx.mcp.add({
          name: String(body.name || ''), transport: body.transport === 'http' ? 'http' : 'stdio', command: body.command,
          args: Array.isArray(body.args) ? body.args : [], url: body.url, enabled: body.enabled !== false,
        }) });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return true;
    }

if (url.pathname.startsWith('/api/mcp/servers/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[3] || '';
      const action = parts[4] || '';
      try {
        if (!id) throw new Error('MCP Server ID 无效。');
        if (!action && req.method === 'DELETE') { ctx.mcp.remove(id); jsonReply(res, 200, { ok: true }); return true; }
        if (action === 'connect' && req.method === 'POST') { jsonReply(res, 200, { server: await ctx.mcp.connect(id) }); return true; }
        if (action === 'disconnect' && req.method === 'POST') { jsonReply(res, 200, { server: ctx.mcp.disconnect(id) }); return true; }
        if (action === 'call' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const result = await ctx.mcp.callTool(id, String(body.name || ''), body.arguments && typeof body.arguments === 'object' ? body.arguments : {});
          jsonReply(res, 200, { result }); return true;
        }
        if (action === 'resource' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const result = await ctx.mcp.readResource(id, String(body.uri || ''));
          jsonReply(res, 200, { result }); return true;
        }
        jsonReply(res, 404, { error: 'MCP 接口不存在' });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return true;
    }
  return false;
}
