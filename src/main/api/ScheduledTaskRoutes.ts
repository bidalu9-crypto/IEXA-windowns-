// =============================================================================
// Scheduled task API.
//
// The list is decorated with the model and conversation labels the editor and
// the rows need, so a client never has to join three caches to render a card.
// =============================================================================
import * as http from 'http';
import { URL } from 'url';
import { jsonReply, readBody } from './HttpServer';
import { TaskScheduler } from '../tasks/Scheduler';
import { describeSchedule } from '../tasks/ScheduledTasks';

export interface ScheduledTaskRouteContext {
  scheduler: TaskScheduler;
  listProfiles(): Array<{ id: string; name: string; model: string }>;
  listSessions(): Array<{ id: string; title: string }>;
  allowWrite: boolean;
  now(): number;
}

const MAX_BODY = 64 * 1024;

function decorate(task: ReturnType<TaskScheduler['list']>[number], ctx: ScheduledTaskRouteContext) {
  const profile = ctx.listProfiles().find((item) => item.id === task.profileId);
  const session = task.sessionId ? ctx.listSessions().find((item) => item.id === task.sessionId) : undefined;
  return {
    ...task,
    profileLabel: profile ? (profile.name || profile.model) : '模型已移除',
    profileModel: profile?.model || '',
    profileMissing: !profile,
    sessionTitle: session?.title || (task.sessionMode === 'existing' ? '会话已移除' : ''),
    scheduleLabel: describeSchedule(task.schedule),
  };
}

function readOnly(res: http.ServerResponse): void {
  jsonReply(res, 403, { error: '当前设备只能查看定时任务。' });
}

export async function handleScheduledTaskRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ScheduledTaskRouteContext,
): Promise<boolean> {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/scheduled-tasks')) return false;

  const profiles = ctx.listProfiles();
  const sessions = ctx.listSessions();
  const knownProfile = (id: string) => profiles.some((item) => item.id === id);
  const knownSession = (id: string) => sessions.some((item) => item.id === id);

  const replyList = () => jsonReply(res, 200, {
    tasks: ctx.scheduler.list().map((task) => decorate(task, ctx)),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: ctx.now(),
  });

  try {
    if (pathname === '/api/scheduled-tasks' && req.method === 'GET') {
      replyList();
      return true;
    }

    if (pathname === '/api/scheduled-tasks' && req.method === 'POST') {
      if (!ctx.allowWrite) { readOnly(res); return true; }
      const body = JSON.parse(await readBody(req, MAX_BODY) || '{}');
      const profileId = String(body.profileId || '').trim();
      if (!knownProfile(profileId)) { jsonReply(res, 400, { error: '请选择一个可用的模型' }); return true; }
      if (body.sessionMode === 'existing' && !knownSession(String(body.sessionId || ''))) {
        jsonReply(res, 400, { error: '选择的会话不存在' });
        return true;
      }
      const task = ctx.scheduler.create(body);
      jsonReply(res, 200, { task: decorate(task, ctx) });
      return true;
    }

    const match = /^\/api\/scheduled-tasks\/([A-Za-z0-9_-]+)(\/run)?$/.exec(pathname);
    if (!match) { jsonReply(res, 404, { error: 'Not found' }); return true; }
    const id = match[1];
    const isRun = !!match[2];
    if (!ctx.scheduler.find(id)) { jsonReply(res, 404, { error: '定时任务不存在' }); return true; }

    if (isRun && req.method === 'POST') {
      if (!ctx.allowWrite) { readOnly(res); return true; }
      const result = await ctx.scheduler.runNow(id);
      jsonReply(res, 200, { task: decorate(result, ctx) });
      return true;
    }

    if (req.method === 'PATCH') {
      if (!ctx.allowWrite) { readOnly(res); return true; }
      const patch = JSON.parse(await readBody(req, MAX_BODY) || '{}');
      if (patch.profileId !== undefined && !knownProfile(String(patch.profileId))) {
        jsonReply(res, 400, { error: '请选择一个可用的模型' });
        return true;
      }
      if (patch.sessionMode === 'existing' && patch.sessionId !== undefined && !knownSession(String(patch.sessionId))) {
        jsonReply(res, 400, { error: '选择的会话不存在' });
        return true;
      }
      const updated = ctx.scheduler.update(id, patch);
      jsonReply(res, 200, { task: decorate(updated, ctx) });
      return true;
    }

    if (req.method === 'DELETE') {
      if (!ctx.allowWrite) { readOnly(res); return true; }
      ctx.scheduler.remove(id);
      jsonReply(res, 200, { ok: true, id });
      return true;
    }

    jsonReply(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (error) {
    jsonReply(res, 400, { error: (error as Error)?.message || '定时任务操作失败' });
    return true;
  }
}
