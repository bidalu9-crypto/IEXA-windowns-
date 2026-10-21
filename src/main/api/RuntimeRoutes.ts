import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody } from './HttpServer';
import { PermissionBroker, PermissionDecision, PermissionMode } from '../security/PermissionManager';
import { QuestionBroker, PendingQuestion } from '../runtime/QuestionBroker';

interface RuntimeAgent {
  getState(): unknown;
  getObservability(): unknown;
  setPermissionMode(mode: PermissionMode): void;
  grantPermission(toolName: string): void;
  isRunning(): boolean;
  cancel(): void;
  pause(): boolean;
  resume(): Promise<boolean>;
  isPaused(): boolean;
}

export interface RuntimeRoutesContext {
  agents: Map<string, RuntimeAgent>;
  permissionBroker: PermissionBroker;
  permissionPayload(item: Parameters<RuntimeRoutesContext['permissionBroker']['list']>[0] extends never ? never : any): Record<string, unknown>;
  questionBroker: QuestionBroker;
  questionPayload(item: PendingQuestion): Record<string, unknown>;
  getPermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  normalizePermissionMode(value: unknown): PermissionMode;
  loadJobs(): unknown[];
  /** Purge settled job records; without a session id the whole audit trail is cleared. */
  clearJobs(sessionId?: string): { removed: number; remaining: number };
  jobsRetention: { days: number; perSession: number; total: number };
  readTraces(sessionId: string, limit: number): unknown[];
  cancelSession(sessionId: string): void;
  clearRunningSession(sessionId: string): void;
  cancelLiveJobs(sessionId: string, settled?: boolean): void;
  /** Objective kept outside the transcript so compaction cannot drop it. */
  getGoal(sessionId: string): unknown;
  clearGoal(sessionId: string): boolean;
  /** Active persistent shells belonging to this conversation. */
  listShellSessions(sessionId: string): unknown[];
  closeShellSession(id: string, sessionId: string): Promise<{ output: string; success: boolean }>;
}

export async function handleRuntimeRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: RuntimeRoutesContext): Promise<boolean> {
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    const jobs = context.loadJobs().filter((job: any) => !sessionId || job.sessionId === sessionId).sort((a: any, b: any) => b.createdAt - a.createdAt);
    // The policy travels with the data so the panel cannot describe a retention
    // window that no longer matches the server's constants.
    jsonReply(res, 200, { jobs, retention: context.jobsRetention });
    return true;
  }
  if (url.pathname === '/api/jobs' && req.method === 'DELETE') {
    const sessionId = url.searchParams.get('sessionId') || '';
    jsonReply(res, 200, { ok: true, ...context.clearJobs(sessionId) });
    return true;
  }
  if (url.pathname === '/api/goal' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    jsonReply(res, 200, { goal: sessionId ? context.getGoal(sessionId) : null });
    return true;
  }
  if (url.pathname === '/api/goal' && req.method === 'DELETE') {
    const sessionId = url.searchParams.get('sessionId') || '';
    jsonReply(res, 200, { ok: sessionId ? context.clearGoal(sessionId) : false });
    return true;
  }
  if (url.pathname === '/api/shell-sessions' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || '';
    jsonReply(res, 200, { sessions: sessionId ? context.listShellSessions(sessionId) : [] });
    return true;
  }
  if (url.pathname === '/api/shell-sessions' && req.method === 'DELETE') {
    const sessionId = url.searchParams.get('sessionId') || '';
    const id = url.searchParams.get('id') || '';
    if (!sessionId || !id) { jsonReply(res, 400, { error: 'sessionId 和 id 必填。' }); return true; }
    const result = await context.closeShellSession(id, sessionId);
    jsonReply(res, result.success ? 200 : 404, { ok: result.success, message: result.output });
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
  if (url.pathname === '/api/questions' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') || undefined;
    jsonReply(res, 200, { questions: context.questionBroker.list(sessionId).map(context.questionPayload) });
    return true;
  }
  if (url.pathname === '/api/questions/answer' && req.method === 'POST') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const id = String(parsed.id || parsed.requestId || '');
      const rawAnswers = Array.isArray(parsed.answers) ? parsed.answers : [];
      const answers = rawAnswers.map((item: unknown) => {
        const record = (item || {}) as Record<string, unknown>;
        const freeText = typeof record.freeText === 'string' ? record.freeText.slice(0, 4000) : undefined;
        return {
          id: String(record.id || ''),
          selected: Array.isArray(record.selected) ? record.selected.map((value) => String(value).slice(0, 200)).slice(0, 24) : [],
          freeText: freeText && freeText.trim() ? freeText : undefined,
          skipped: record.skipped === true,
        };
      }).filter((answer: { id: string }) => answer.id);
      if (!id || !answers.length) jsonReply(res, 400, { error: '回答数据无效。' });
      else if (!context.questionBroker.resolve(id, answers)) jsonReply(res, 404, { error: '提问不存在或已结束。' });
      else jsonReply(res, 200, { ok: true, id });
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '回答提交失败。' }); }
    return true;
  }
  if (url.pathname === '/api/questions/cancel' && req.method === 'POST') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const id = String(parsed.id || parsed.requestId || '');
      if (!id || !context.questionBroker.resolve(id, null)) jsonReply(res, 404, { error: '提问不存在或已结束。' });
      else jsonReply(res, 200, { ok: true, id });
    } catch (error: unknown) { jsonReply(res, 400, { error: (error as Error).message || '取消失败。' }); }
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
  if (url.pathname === '/api/pause' && req.method === 'POST') {
    let sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) {
      try { sessionId = JSON.parse(await readBody(req)).sessionId || ''; } catch { /* optional body */ }
    }
    const agent = sessionId ? context.agents.get(sessionId) : undefined;
    if (!agent || !agent.pause()) { jsonReply(res, 409, { error: 'no_live_turn' }); return true; }
    jsonReply(res, 202, { ok: true, sessionId });
    return true;
  }
  if (url.pathname === '/api/resume' && req.method === 'POST') {
    let sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) {
      try { sessionId = JSON.parse(await readBody(req)).sessionId || ''; } catch { /* optional body */ }
    }
    const agent = sessionId ? context.agents.get(sessionId) : undefined;
    if (!agent) { jsonReply(res, 409, { error: 'no_live_turn' }); return true; }
    const resumed = await agent.resume();
    jsonReply(res, resumed ? 202 : 409, resumed ? { ok: true, sessionId } : { error: 'not_paused' });
    return true;
  }
  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    let sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) {
      try { sessionId = JSON.parse(await readBody(req)).sessionId || ''; } catch { /* legacy clients may send no body */ }
    }
    if (sessionId) {
      context.cancelSession(sessionId);
      context.permissionBroker.cancelSession(sessionId);
      context.questionBroker.cancelSession(sessionId);
      // Acknowledgement is a stop request, not proof that the executor has settled.
      context.cancelLiveJobs(sessionId, false);
    }
    jsonReply(res, 200, { ok: true });
    return true;
  }
  return false;
}
