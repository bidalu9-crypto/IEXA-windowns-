"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRuntimeRoute = handleRuntimeRoute;
const HttpServer_1 = require("./HttpServer");
async function handleRuntimeRoute(req, res, url, context) {
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const jobs = context.loadJobs().filter((job) => !sessionId || job.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt);
        // The policy travels with the data so the panel cannot describe a retention
        // window that no longer matches the server's constants.
        (0, HttpServer_1.jsonReply)(res, 200, { jobs, retention: context.jobsRetention });
        return true;
    }
    if (url.pathname === '/api/jobs' && req.method === 'DELETE') {
        const sessionId = url.searchParams.get('sessionId') || '';
        (0, HttpServer_1.jsonReply)(res, 200, { ok: true, ...context.clearJobs(sessionId) });
        return true;
    }
    if (url.pathname === '/api/goal' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        (0, HttpServer_1.jsonReply)(res, 200, { goal: sessionId ? context.getGoal(sessionId) : null });
        return true;
    }
    if (url.pathname === '/api/goal' && req.method === 'DELETE') {
        const sessionId = url.searchParams.get('sessionId') || '';
        (0, HttpServer_1.jsonReply)(res, 200, { ok: sessionId ? context.clearGoal(sessionId) : false });
        return true;
    }
    if (url.pathname === '/api/shell-sessions' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        (0, HttpServer_1.jsonReply)(res, 200, { sessions: sessionId ? context.listShellSessions(sessionId) : [] });
        return true;
    }
    if (url.pathname === '/api/shell-sessions' && req.method === 'DELETE') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const id = url.searchParams.get('id') || '';
        if (!sessionId || !id) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: 'sessionId 和 id 必填。' });
            return true;
        }
        const result = await context.closeShellSession(id, sessionId);
        (0, HttpServer_1.jsonReply)(res, result.success ? 200 : 404, { ok: result.success, message: result.output });
        return true;
    }
    if (url.pathname === '/api/agent/state' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const agent = sessionId ? context.agents.get(sessionId) : undefined;
        (0, HttpServer_1.jsonReply)(res, 200, { running: context.isSessionRunning?.(sessionId) ?? agent?.isRunning() ?? false, state: agent?.getState() || null, observability: agent?.getObservability() || null });
        return true;
    }
    if (url.pathname === '/api/traces' && req.method === 'GET') {
        try {
            const sessionId = url.searchParams.get('sessionId') || '';
            const limit = Number(url.searchParams.get('limit') || 300);
            if (!sessionId) {
                (0, HttpServer_1.jsonReply)(res, 400, { error: 'sessionId required' });
                return true;
            }
            (0, HttpServer_1.jsonReply)(res, 200, { trace: context.readTraces(sessionId, limit) });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '读取 Trace 失败。' });
        }
        return true;
    }
    if (url.pathname === '/api/permissions' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || undefined;
        (0, HttpServer_1.jsonReply)(res, 200, { mode: context.getPermissionMode(), permissions: context.permissionBroker.list(sessionId).map(context.permissionPayload) });
        return true;
    }
    if (url.pathname === '/api/permissions/mode' && req.method === 'GET') {
        (0, HttpServer_1.jsonReply)(res, 200, { mode: context.getPermissionMode() });
        return true;
    }
    if (url.pathname === '/api/permissions/mode' && req.method === 'PUT') {
        try {
            const parsed = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const mode = context.normalizePermissionMode(parsed.mode);
            context.setPermissionMode(mode);
            for (const agent of context.agents.values())
                agent.setPermissionMode(mode);
            (0, HttpServer_1.jsonReply)(res, 200, { ok: true, mode });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '权限模式无效。' });
        }
        return true;
    }
    if (url.pathname === '/api/permissions/approve' && req.method === 'POST') {
        try {
            const parsed = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const id = String(parsed.id || parsed.requestId || '');
            const decision = parsed.scope === 'once' ? 'allow_once' : 'allow_session';
            if (!id || !context.permissionBroker.resolve(id, decision))
                (0, HttpServer_1.jsonReply)(res, 404, { error: '权限请求不存在或已结束。' });
            else
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, id, decision });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '权限请求无效。' });
        }
        return true;
    }
    if (url.pathname === '/api/permissions/deny' && req.method === 'POST') {
        try {
            const parsed = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const id = String(parsed.id || parsed.requestId || '');
            if (!id || !context.permissionBroker.resolve(id, 'deny'))
                (0, HttpServer_1.jsonReply)(res, 404, { error: '权限请求不存在或已结束。' });
            else
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, id, decision: 'deny' });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '权限请求无效。' });
        }
        return true;
    }
    if (url.pathname === '/api/questions' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || undefined;
        (0, HttpServer_1.jsonReply)(res, 200, { questions: context.questionBroker.list(sessionId).map(context.questionPayload) });
        return true;
    }
    if (url.pathname === '/api/questions/answer' && req.method === 'POST') {
        try {
            const parsed = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const id = String(parsed.id || parsed.requestId || '');
            const rawAnswers = Array.isArray(parsed.answers) ? parsed.answers : [];
            const answers = rawAnswers.map((item) => {
                const record = (item || {});
                const freeText = typeof record.freeText === 'string' ? record.freeText.slice(0, 4000) : undefined;
                return {
                    id: String(record.id || ''),
                    selected: Array.isArray(record.selected) ? record.selected.map((value) => String(value).slice(0, 200)).slice(0, 24) : [],
                    freeText: freeText && freeText.trim() ? freeText : undefined,
                    skipped: record.skipped === true,
                };
            }).filter((answer) => answer.id);
            if (!id || !answers.length)
                (0, HttpServer_1.jsonReply)(res, 400, { error: '回答数据无效。' });
            else if (!context.questionBroker.resolve(id, answers))
                (0, HttpServer_1.jsonReply)(res, 404, { error: '提问不存在或已结束。' });
            else
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, id });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '回答提交失败。' });
        }
        return true;
    }
    if (url.pathname === '/api/questions/cancel' && req.method === 'POST') {
        try {
            const parsed = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const id = String(parsed.id || parsed.requestId || '');
            if (!id || !context.questionBroker.resolve(id, null))
                (0, HttpServer_1.jsonReply)(res, 404, { error: '提问不存在或已结束。' });
            else
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, id });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '取消失败。' });
        }
        return true;
    }
    if (url.pathname === '/api/permissions/grant' && req.method === 'POST') {
        try {
            const parsed = JSON.parse(await (0, HttpServer_1.readBody)(req));
            const sessionId = String(parsed.sessionId || '');
            const toolName = String(parsed.toolName || '');
            const agent = context.agents.get(sessionId);
            if (!agent || !toolName)
                (0, HttpServer_1.jsonReply)(res, 404, { error: '未找到活动会话或工具。' });
            else {
                agent.grantPermission(toolName);
                (0, HttpServer_1.jsonReply)(res, 200, { ok: true, sessionId, toolName });
            }
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message || '权限请求无效。' });
        }
        return true;
    }
    if (url.pathname === '/api/pause' && req.method === 'POST') {
        let sessionId = url.searchParams.get('sessionId') || '';
        if (!sessionId) {
            try {
                sessionId = JSON.parse(await (0, HttpServer_1.readBody)(req)).sessionId || '';
            }
            catch { /* optional body */ }
        }
        const agent = sessionId ? context.agents.get(sessionId) : undefined;
        if (!agent || !agent.pause()) {
            (0, HttpServer_1.jsonReply)(res, 409, { error: 'no_live_turn' });
            return true;
        }
        (0, HttpServer_1.jsonReply)(res, 202, { ok: true, sessionId });
        return true;
    }
    if (url.pathname === '/api/resume' && req.method === 'POST') {
        let sessionId = url.searchParams.get('sessionId') || '';
        if (!sessionId) {
            try {
                sessionId = JSON.parse(await (0, HttpServer_1.readBody)(req)).sessionId || '';
            }
            catch { /* optional body */ }
        }
        const agent = sessionId ? context.agents.get(sessionId) : undefined;
        if (!agent) {
            (0, HttpServer_1.jsonReply)(res, 409, { error: 'no_live_turn' });
            return true;
        }
        const resumed = await agent.resume();
        (0, HttpServer_1.jsonReply)(res, resumed ? 202 : 409, resumed ? { ok: true, sessionId } : { error: 'not_paused' });
        return true;
    }
    if (url.pathname === '/api/cancel' && req.method === 'POST') {
        let sessionId = url.searchParams.get('sessionId') || '';
        if (!sessionId) {
            try {
                sessionId = JSON.parse(await (0, HttpServer_1.readBody)(req)).sessionId || '';
            }
            catch { /* legacy clients may send no body */ }
        }
        if (sessionId) {
            context.cancelSession(sessionId);
            context.permissionBroker.cancelSession(sessionId);
            context.questionBroker.cancelSession(sessionId);
            // Acknowledgement is a stop request, not proof that the executor has settled.
            context.cancelLiveJobs(sessionId, false);
        }
        const agent = sessionId ? context.agents?.get(sessionId) : undefined;
        (0, HttpServer_1.jsonReply)(res, 200, { ok: true, sessionId, settled: !(context.isSessionRunning?.(sessionId) ?? agent?.isRunning() ?? false), status: agent?.getState()?.status || 'idle' });
        return true;
    }
    return false;
}
//# sourceMappingURL=RuntimeRoutes.js.map