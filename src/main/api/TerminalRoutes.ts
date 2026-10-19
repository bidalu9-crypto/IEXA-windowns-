/**
 * Workbench terminal sessions.
 *
 * This is the human-facing terminal. Agent shells are a different manager and
 * are never reachable from here, so a person cannot type into a model's tty.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody, HttpError } from './HttpServer';
import { TerminalManager } from '../terminals/TerminalManager';

export interface TerminalRouteContext {
  terminals: TerminalManager;
  getProjectRoot: () => string | null;
  workspaceDir: string;
}

export async function handleTerminalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: TerminalRouteContext,
): Promise<boolean> {
if (url.pathname === '/api/terminal/sessions' && req.method === 'GET') {
      jsonReply(res, 200, { sessions: ctx.terminals.list() });
      return true;
    }

if (url.pathname === '/api/terminal/sessions' && req.method === 'POST') {
      const projectRoot = ctx.getProjectRoot() || ctx.workspaceDir;
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        jsonReply(res, 201, { session: ctx.terminals.create(projectRoot, body.shell) });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return true;
    }

if (url.pathname.startsWith('/api/terminal/sessions/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[3] || '';
      const action = parts[4] || '';
      try {
        if (!id) throw new Error('终端会话 ID 无效。');
        if (!action && req.method === 'GET') {
          const after = Number(url.searchParams.get('after') || '0');
          jsonReply(res, 200, ctx.terminals.output(id, after));
          return true;
        }
        if ((action === 'input' || action === 'execute') && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          ctx.terminals.write(id, action === 'input' ? String(body.input || '') : String(body.command || ''), action === 'execute');
          jsonReply(res, 200, { ok: true });
          return true;
        }
        if (action === 'resize' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          ctx.terminals.resize(id, Number(body.cols), Number(body.rows));
          jsonReply(res, 200, { ok: true });
          return true;
        }
        if (action === 'terminate' && req.method === 'POST') {
          await ctx.terminals.terminate(id);
          jsonReply(res, 200, { ok: true });
          return true;
        }
        jsonReply(res, 404, { error: '终端接口不存在' });
      } catch (error) {
        jsonReply(res, 400, { error: (error as Error).message });
      }
      return true;
    }
  return false;
}
