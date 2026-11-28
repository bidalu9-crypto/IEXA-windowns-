"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskScheduler = void 0;
// =============================================================================
// Scheduled task runner.
//
// One unref'd timer checks the wall clock; a due task creates or reuses its
// conversation, binds the chosen model, and sends the saved prompt through the
// ordinary chat path. A desktop app cannot fire while it is closed, so a missed
// occurrence is recorded and rolled forward instead of replaying in a burst on
// launch — firing twenty stale prompts at once would be worse than skipping.
// =============================================================================
const ScheduledTasks_1 = require("./ScheduledTasks");
const DEFAULT_TICK_MS = 30_000;
const DEFAULT_GRACE_MS = 10 * 60_000;
/** Tests shorten the cadence; production keeps the 30-second sweep. */
function configuredTickMs(value) {
    const override = Number(process.env.IEXA_SCHEDULER_TICK_MS);
    if (Number.isFinite(override) && override >= 50)
        return override;
    return value ?? DEFAULT_TICK_MS;
}
class TaskScheduler {
    options;
    tasks = [];
    timer = null;
    ticking = false;
    running = new Set();
    listeners = new Set();
    host;
    tickMs;
    graceMs;
    now;
    log;
    constructor(options) {
        this.options = options;
        this.host = options.host;
        this.tickMs = configuredTickMs(options.tickMs);
        this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
        this.now = options.now ?? Date.now;
        this.log = options.log ?? ((message) => console.error(`[Scheduler] ${message}`));
        this.tasks = (0, ScheduledTasks_1.loadScheduledTasks)(options.file);
        for (const task of this.tasks)
            this.repairSchedule(task);
        this.persist();
    }
    list() {
        return this.tasks.map((task) => ({ ...task }));
    }
    find(id) {
        return this.tasks.find((task) => task.id === id);
    }
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    create(raw, defaults = {}) {
        const body = (raw && typeof raw === 'object' ? raw : {});
        const input = (0, ScheduledTasks_1.normalizeInput)({ ...body, profileId: body.profileId || defaults.profileId });
        const now = this.now();
        const task = {
            id: `task_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
            title: input.title || '定时任务',
            customTitle: input.customTitle === true,
            prompt: input.prompt,
            profileId: input.profileId,
            sessionMode: input.sessionMode || 'new',
            sessionId: input.sessionId,
            schedule: input.schedule,
            enabled: input.enabled !== false,
            createdAt: now,
            updatedAt: now,
            nextRunAt: null,
            runCount: 0,
        };
        task.nextRunAt = task.enabled ? (0, ScheduledTasks_1.nextRunAfter)(task.schedule, now) : null;
        this.tasks.unshift(task);
        this.persist();
        this.emit(task);
        return { ...task };
    }
    update(id, patch) {
        const task = this.require(id);
        const now = this.now();
        if (patch.title !== undefined) {
            const title = String(patch.title).trim().slice(0, 80);
            if (title) {
                task.title = title;
                task.customTitle = true;
            }
            else {
                task.customTitle = false;
                task.title = task.prompt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) || '定时任务';
            }
        }
        if (patch.prompt !== undefined) {
            const prompt = String(patch.prompt).trim();
            if (!prompt)
                throw new Error('请填写提示词');
            if (prompt.length > 20000)
                throw new Error('提示词不能超过 20000 字');
            task.prompt = prompt;
            if (!task.customTitle) {
                task.title = prompt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) || '定时任务';
            }
        }
        if (patch.profileId !== undefined) {
            const profileId = String(patch.profileId).trim();
            if (!profileId)
                throw new Error('请选择一个模型');
            task.profileId = profileId;
        }
        if (patch.sessionMode !== undefined) {
            task.sessionMode = patch.sessionMode === 'existing' ? 'existing' : 'new';
            if (task.sessionMode === 'new')
                task.sessionId = undefined;
        }
        if (patch.sessionId !== undefined && task.sessionMode === 'existing') {
            const sessionId = String(patch.sessionId).trim();
            if (!sessionId)
                throw new Error('请选择一个已有会话');
            task.sessionId = sessionId;
        }
        if (task.sessionMode === 'existing' && !task.sessionId)
            throw new Error('请选择一个已有会话');
        if (patch.schedule !== undefined)
            task.schedule = (0, ScheduledTasks_1.normalizeSchedule)(patch.schedule);
        if (patch.enabled !== undefined)
            task.enabled = patch.enabled === true;
        task.updatedAt = now;
        task.nextRunAt = task.enabled ? (0, ScheduledTasks_1.nextRunAfter)(task.schedule, now) : null;
        this.persist();
        this.emit(task);
        return { ...task };
    }
    remove(id) {
        const index = this.tasks.findIndex((task) => task.id === id);
        if (index < 0)
            return false;
        const [task] = this.tasks.splice(index, 1);
        this.persist();
        this.emit(task);
        return true;
    }
    /** Run a task now without disturbing its schedule. */
    async runNow(id) {
        const task = this.require(id);
        if (this.running.has(task.id))
            throw new Error('这个任务正在执行');
        await this.execute(task, false);
        return { ...task };
    }
    start() {
        if (this.timer)
            return;
        // A task whose saved slot predates this launch is reported, then rolled
        // forward: replaying every missed occurrence would fire a burst at login.
        for (const task of this.tasks)
            this.recoverMissed(task);
        this.timer = setInterval(() => void this.tick(), this.tickMs);
        this.timer.unref?.();
        void this.tick();
    }
    stop() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    /** Exposed for tests: one deterministic pass over the due list. */
    async tick() {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            const now = this.now();
            const due = this.tasks.filter((task) => task.enabled
                && !this.running.has(task.id)
                && task.nextRunAt !== null
                && task.nextRunAt <= now);
            for (const task of due) {
                if (now - task.nextRunAt > this.graceMs) {
                    task.lastStatus = 'missed';
                    task.lastError = '应用当时未运行';
                    this.rollForward(task, now);
                    this.persist();
                    this.emit(task);
                    continue;
                }
                // Sequential on purpose: a burst of tasks must not race for the same
                // conversation or the same provider quota.
                await this.execute(task, true);
            }
        }
        finally {
            this.ticking = false;
        }
    }
    async execute(task, scheduled) {
        this.running.add(task.id);
        const startedAt = this.now();
        try {
            let sessionId = task.sessionId;
            if (task.sessionMode === 'existing' && task.sessionId) {
                await this.host.bindSession(task.sessionId, task.profileId);
            }
            else {
                sessionId = await this.host.createSession({ title: task.title, profileId: task.profileId });
                task.sessionId = undefined;
            }
            if (!sessionId)
                throw new Error('无法创建会话');
            await this.host.sendPrompt(sessionId, task.prompt);
            task.lastStatus = 'ok';
            task.lastError = undefined;
            task.lastSessionId = sessionId;
            task.runCount += 1;
        }
        catch (error) {
            task.lastStatus = 'error';
            task.lastError = error?.message || '执行失败';
            task.runCount += 1;
            this.log(`task ${task.id} failed: ${task.lastError}`);
        }
        finally {
            this.running.delete(task.id);
            task.lastRunAt = startedAt;
            if (scheduled)
                this.rollForward(task, this.now());
            this.persist();
            this.emit(task);
        }
    }
    rollForward(task, from) {
        const anchor = Math.max(task.nextRunAt ?? 0, from);
        task.nextRunAt = task.enabled ? (0, ScheduledTasks_1.nextRunAfter)(task.schedule, anchor) : null;
    }
    recoverMissed(task) {
        if (!task.enabled) {
            task.nextRunAt = null;
            return;
        }
        const now = this.now();
        if (task.nextRunAt === null) {
            task.nextRunAt = (0, ScheduledTasks_1.nextRunAfter)(task.schedule, now);
            return;
        }
        if (task.nextRunAt > now)
            return;
        if (now - task.nextRunAt <= this.graceMs)
            return; // still due; tick will run it
        task.lastStatus = 'missed';
        task.lastError = '应用当时未运行';
        task.nextRunAt = (0, ScheduledTasks_1.nextRunAfter)(task.schedule, now);
    }
    repairSchedule(task) {
        try {
            task.schedule = (0, ScheduledTasks_1.normalizeSchedule)(task.schedule);
            task.prompt = String(task.prompt || '');
            task.runCount = Number(task.runCount) || 0;
            if (!task.enabled)
                task.nextRunAt = null;
            else if (task.nextRunAt === null)
                task.nextRunAt = (0, ScheduledTasks_1.nextRunAfter)(task.schedule, this.now());
        }
        catch {
            task.enabled = false;
            task.nextRunAt = null;
        }
    }
    require(id) {
        const task = this.tasks.find((item) => item.id === id);
        if (!task)
            throw new Error('定时任务不存在');
        return task;
    }
    persist() {
        try {
            (0, ScheduledTasks_1.saveScheduledTasks)(this.options.file, this.tasks);
        }
        catch (error) {
            this.log(`failed to persist: ${error.message}`);
        }
    }
    emit(task) {
        for (const listener of this.listeners) {
            try {
                listener({ ...task });
            }
            catch { /* a listener must not break scheduling */ }
        }
    }
}
exports.TaskScheduler = TaskScheduler;
//# sourceMappingURL=Scheduler.js.map