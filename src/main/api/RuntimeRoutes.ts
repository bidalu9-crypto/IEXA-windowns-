import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody } from './HttpServer';
import { PermissionBroker, PermissionDecision, PermissionMode } from '../security/PermissionManager';

interface RuntimeAgent {
  getState(): unknown;
  getObservability(): unknown;
  setPermissionMode(mode: PermissionMode): void;
  grantPermission(toolName: string): void;
}

export interface RuntimeRoutesContext {
  agents: Map<string, RuntimeAgent>;
  permissionBroker: PermissionBroker;
  permissionPayload(item: Parameters<RuntimeRoutesContext['permissionBroker']['list']>[0] extends never ? never : any): Record<string, unknown>;
  getPermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  normalizePermissionMode(value: unknown): PermissionMode;
  loadJobs(): unknown[];
  readTraces(sessionId: string, limit: number): unknown[];
  cancelSession(sessionId: string): void;
  clearRunningSession(sessionId: string): void;
  cancelLiveJobs(sessionId: string): void;
}

export async function handleRuntimeRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: RuntimeRoutesContext): Promise<boolean> {
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    const jobs = context.loadJobs().filter((job: any) => !sessionId || job.sessionId === sessionId).sort((a: any, b: any) => b.createdAt - a.createdAt);
    jsonReply(res, 200, { jobs });
    return true;
  }
  if (url.pathname === '/api/agent/state' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    const agent = sessionId ? context.agents.get(sessionId) : undefined;
    jsonReply(res, 200, { state: agent?.getState() || null, observability: agent?.getObservability() || null });
    return true;
  }
  if (url.pathname === '/api/traces' && req.method === 'GET') {
    try {
      const sessionId = url.searchParams.get('sessionId') || '';
      const limit = Number(url.searchParams.get('limit') || 300);
      if (!sessionId) { jsonReply(res, 400, { error: 'sessionId required' }); return true; }
      jsonReply(res, 200, { trace: context.readTraces(sessionId, limit) });
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '读取 Trace 失败。' }); }
    return true;
  }
  if (url.pathname === '/api/permissions' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || undefined;
    jsonReply(res, 200, { mode: context.getPermissionMode(), permissions: context.permissionBroker.list(sessionId).map(context.permissionPayload) });
    return true;
  }
  if (url.pathname === '/api/permissions/mode' && req.method === 'GET') {
    jsonReply(res, 200, { mode: context.getPermissionMode() });
    return true;
  }
  if (url.pathname === '/api/permissions/mode' && req.method === 'PUT') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const mode = context.normalizePermissionMode(parsed.mode);
      context.setPermissionMode(mode);
      for (const agent of context.agents.values()) agent.setPermissionMode(mode);
      jsonReply(res, 200, { ok: true, mode });
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '权限模式无效。' }); }
    return true;
  }
  if (url.pathname === '/api/permissions/approve' && req.method === 'POST') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const id = String(parsed.id || parsed.requestId || '');
      const decision: PermissionDecision = parsed.scope === 'once' ? 'allow_once' : 'allow_session';
      if (!id || !context.permissionBroker.resolve(id, decision)) jsonReply(res, 404, { error: '权限请求不存在或已结束。' });
      else jsonReply(res, 200, { ok: true, id, decision });
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '权限请求无效。' }); }
    return true;
  }
  if (url.pathname === '/api/permissions/deny' && req.method === 'POST') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const id = String(parsed.id || parsed.requestId || '');
      if (!id || !context.permissionBroker.resolve(id, 'deny')) jsonReply(res, 404, { error: '权限请求不存在或已结束。' });
      else jsonReply(res, 200, { ok: true, id, decision: 'deny' });
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '权限请求无效。' }); }
    return true;
  }
  if (url.pathname === '/api/permissions/grant' && req.method === 'POST') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const sessionId = String(parsed.sessionId || '');
      const toolName = String(parsed.toolName || '');
      const agent = context.agents.get(sessionId);
      if (!agent || !toolName) jsonReply(res, 404, { error: '未找到活动会话或工具。' });
      else { agent.grantPermission(toolName); jsonReply(res, 200, { ok: true, sessionId, toolName }); }
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '权限请求无效。' }); }
    return true;
  }
  if (url.pathname === '/api/cancel') {
    let sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) {
      try { sessionId = JSON.parse(await readBody(req)).sessionId || ''; } catch { /* legacy clients may send no body */ }
    }
    if (sessionId) {
      context.cancelSession(sessionId);
      context.permissionBroker.cancelSession(sessionId);
      context.clearRunningSession(sessionId);
      context.cancelLiveJobs(sessionId);
    }
    jsonReply(res, 200, { ok: true });
    return true;
  }
  return false;
}
