"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleScheduledTaskRoute = handleScheduledTaskRoute;
const HttpServer_1 = require("./HttpServer");
const ScheduledTasks_1 = require("../tasks/ScheduledTasks");
const MAX_BODY = 64 * 1024;
function decorate(task, ctx) {
    const profile = ctx.listProfiles().find((item) => item.id === task.profileId);
    const session = task.sessionId ? ctx.listSessions().find((item) => item.id === task.sessionId) : undefined;
    return {
        ...task,
        profileLabel: profile ? (profile.name || profile.model) : '模型已移除',
        profileModel: profile?.model || '',
        profileMissing: !profile,
        sessionTitle: session?.title || (task.sessionMode === 'existing' ? '会话已移除' : ''),
        scheduleLabel: (0, ScheduledTasks_1.describeSchedule)(task.schedule),
    };
}
function readOnly(res) {
    (0, HttpServer_1.jsonReply)(res, 403, { error: '当前设备只能查看定时任务。' });
}
async function handleScheduledTaskRoute(req, res, url, ctx) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/scheduled-tasks'))
        return false;
    const profiles = ctx.listProfiles();
    const sessions = ctx.listSessions();
    const knownProfile = (id) => profiles.some((item) => item.id === id);
    const knownSession = (id) => sessions.some((item) => item.id === id);
    const replyList = () => (0, HttpServer_1.jsonReply)(res, 200, {
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
            if (!ctx.allowWrite) {
                readOnly(res);
                return true;
            }
            const body = JSON.parse(await (0, HttpServer_1.readBody)(req, MAX_BODY) || '{}');
            const profileId = String(body.profileId || '').trim();
            if (!knownProfile(profileId)) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '请选择一个可用的模型' });
                return true;
            }
            if (body.sessionMode === 'existing' && !knownSession(String(body.sessionId || ''))) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '选择的会话不存在' });
                return true;
            }
            const task = ctx.scheduler.create(body);
            (0, HttpServer_1.jsonReply)(res, 200, { task: decorate(task, ctx) });
            return true;
        }
        const match = /^\/api\/scheduled-tasks\/([A-Za-z0-9_-]+)(\/run)?$/.exec(pathname);
        if (!match) {
            (0, HttpServer_1.jsonReply)(res, 404, { error: 'Not found' });
            return true;
        }
        const id = match[1];
        const isRun = !!match[2];
        if (!ctx.scheduler.find(id)) {
            (0, HttpServer_1.jsonReply)(res, 404, { error: '定时任务不存在' });
            return true;
        }
        if (isRun && req.method === 'POST') {
            if (!ctx.allowWrite) {
                readOnly(res);
                return true;
            }
            const result = await ctx.scheduler.runNow(id);
            (0, HttpServer_1.jsonReply)(res, 200, { task: decorate(result, ctx) });
            return true;
        }
        if (req.method === 'PATCH') {
            if (!ctx.allowWrite) {
                readOnly(res);
                return true;
            }
            const patch = JSON.parse(await (0, HttpServer_1.readBody)(req, MAX_BODY) || '{}');
            if (patch.profileId !== undefined && !knownProfile(String(patch.profileId))) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '请选择一个可用的模型' });
                return true;
            }
            if (patch.sessionMode === 'existing' && patch.sessionId !== undefined && !knownSession(String(patch.sessionId))) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: '选择的会话不存在' });
                return true;
            }
            const updated = ctx.scheduler.update(id, patch);
            (0, HttpServer_1.jsonReply)(res, 200, { task: decorate(updated, ctx) });
            return true;
        }
        if (req.method === 'DELETE') {
            if (!ctx.allowWrite) {
                readOnly(res);
                return true;
            }
            ctx.scheduler.remove(id);
            (0, HttpServer_1.jsonReply)(res, 200, { ok: true, id });
            return true;
        }
        (0, HttpServer_1.jsonReply)(res, 405, { error: 'Method not allowed' });
        return true;
    }
    catch (error) {
        (0, HttpServer_1.jsonReply)(res, 400, { error: error?.message || '定时任务操作失败' });
        return true;
    }
}
//# sourceMappingURL=ScheduledTaskRoutes.js.map