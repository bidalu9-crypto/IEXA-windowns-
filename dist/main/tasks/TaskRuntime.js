"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTaskScheduler = createTaskScheduler;
// =============================================================================
// Scheduled-task runtime assembly.
//
// The scheduler itself is transport-agnostic; this module gives it the three
// things only the server knows: how to open a conversation, how to pin its
// model, and how to send a prompt through the ordinary chat endpoint. Keeping
// the assembly here is what stops server.ts from becoming the scheduler's home.
// =============================================================================
const Scheduler_1 = require("./Scheduler");
function createTaskScheduler(deps) {
    return new Scheduler_1.TaskScheduler({
        file: deps.file,
        host: {
            createSession: async ({ title, profileId }) => {
                const store = deps.loadSessionStore();
                const profile = deps.loadSettings().profiles.find((item) => item.id === profileId) || null;
                const now = Date.now();
                const projectRoot = deps.getProjectRoot();
                const session = {
                    id: `sess_${now}_${Math.random().toString(36).slice(2, 6)}`,
                    title: title || '定时任务',
                    titleSource: 'manual',
                    titleGenAttempts: 0,
                    created: now,
                    updated: now,
                    messageCount: 0,
                    modelBinding: profile ? deps.modelBindingForProfile(profile) : undefined,
                    projectRoot: projectRoot || '',
                    projectName: projectRoot ? require('path').basename(projectRoot) : '无项目',
                    pinned: false,
                };
                store.sessions.push(session);
                store.activeSessionId = session.id;
                deps.saveSessionStore(store);
                await deps.saveMessages(session.id, []);
                deps.broadcastSessionEvent('session_changed', { sessionId: session.id, reason: 'created', session });
                return session.id;
            },
            bindSession: (sessionId, profileId) => {
                const store = deps.loadSessionStore();
                const session = store.sessions.find((item) => item.id === sessionId);
                if (!session)
                    throw new Error('会话已不存在');
                const profile = deps.loadSettings().profiles.find((item) => item.id === profileId);
                if (!profile)
                    throw new Error('模型已不存在');
                const binding = deps.modelBindingForProfile(profile);
                if (session.modelBinding?.profileId === binding.profileId && session.modelBinding?.model === binding.model)
                    return;
                session.modelBinding = binding;
                deps.saveSessionStore(store);
            },
            sendPrompt: async (sessionId, prompt) => {
                const endpoint = deps.endpoint();
                if (!endpoint)
                    throw new Error('本地服务尚未就绪');
                const response = await fetch(`${endpoint.baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${endpoint.token}`,
                        'Content-Type': 'application/json',
                        'X-IEXA-Scheduled': '1',
                    },
                    body: JSON.stringify({ sessionId, message: prompt }),
                    // A provider that never closes its stream must not pin the task as
                    // running forever; the cap is generous because real turns can be long.
                    signal: AbortSignal.timeout(30 * 60_000),
                });
                if (!response.ok) {
                    const raw = await response.text().catch(() => '');
                    let detail = raw;
                    try {
                        detail = JSON.parse(raw).error || raw;
                    }
                    catch { /* plain text body */ }
                    throw new Error(detail || `请求失败（${response.status}）`);
                }
                // Draining the stream is what waits for the turn to finish; the chunks
                // themselves are already being persisted and broadcast by the chat route.
                const reader = response.body?.getReader();
                if (!reader)
                    return;
                for (;;) {
                    const { done } = await reader.read();
                    if (done)
                        break;
                }
            },
        },
    });
}
//# sourceMappingURL=TaskRuntime.js.map