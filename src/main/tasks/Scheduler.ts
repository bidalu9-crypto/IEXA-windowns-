// =============================================================================
// Scheduled task runner.
//
// One unref'd timer checks the wall clock; a due task creates or reuses its
// conversation, binds the chosen model, and sends the saved prompt through the
// ordinary chat path. A desktop app cannot fire while it is closed, so a missed
// occurrence is recorded and rolled forward instead of replaying in a burst on
// launch — firing twenty stale prompts at once would be worse than skipping.
// =============================================================================
import {
  ScheduledTask,
  loadScheduledTasks,
  nextRunAfter,
  normalizeInput,
  normalizeSchedule,
  saveScheduledTasks,
} from './ScheduledTasks';

export interface SchedulerHost {
  /** Create a conversation already bound to the task's model. */
  createSession(input: { title: string; profileId: string }): Promise<string>;
  /** Re-point an existing conversation at the task's model. */
  bindSession(sessionId: string, profileId: string): Promise<void> | void;
  /** Send one prompt and resolve when the turn reaches its terminal state. */
  sendPrompt(sessionId: string, prompt: string): Promise<void>;
}

export interface SchedulerOptions {
  file: string;
  host: SchedulerHost;
  tickMs?: number;
  now?: () => number;
  /** How late a due task may still run (default 10 minutes). */
  graceMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_GRACE_MS = 10 * 60_000;

/** Tests shorten the cadence; production keeps the 30-second sweep. */
function configuredTickMs(value: number | undefined): number {
  const override = Number(process.env.IEXA_SCHEDULER_TICK_MS);
  if (Number.isFinite(override) && override >= 50) return override;
  return value ?? DEFAULT_TICK_MS;
}

export class TaskScheduler {
  private tasks: ScheduledTask[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly running = new Set<string>();
  private readonly listeners = new Set<(task: ScheduledTask) => void>();
  private readonly host: SchedulerHost;
  private readonly tickMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: SchedulerOptions) {
    this.host = options.host;
    this.tickMs = configuredTickMs(options.tickMs);
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(`[Scheduler] ${message}`));
    this.tasks = loadScheduledTasks(options.file);
    for (const task of this.tasks) this.repairSchedule(task);
    this.persist();
  }

  list(): ScheduledTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  find(id: string): ScheduledTask | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  onChange(listener: (task: ScheduledTask) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(raw: unknown, defaults: { profileId?: string } = {}): ScheduledTask {
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const input = normalizeInput({ ...body, profileId: body.profileId || defaults.profileId });
    const now = this.now();
    const task: ScheduledTask = {
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
    task.nextRunAt = task.enabled ? nextRunAfter(task.schedule, now) : null;
    this.tasks.unshift(task);
    this.persist();
    this.emit(task);
    return { ...task };
  }

  update(id: string, patch: Record<string, unknown>): ScheduledTask {
    const task = this.require(id);
    const now = this.now();
    if (patch.title !== undefined) {
      const title = String(patch.title).trim().slice(0, 80);
      if (title) {
        task.title = title;
        task.customTitle = true;
      } else {
        task.customTitle = false;
        task.title = task.prompt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) || '定时任务';
      }
    }
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).trim();
      if (!prompt) throw new Error('请填写提示词');
      if (prompt.length > 20000) throw new Error('提示词不能超过 20000 字');
      task.prompt = prompt;
      if (!task.customTitle) {
        task.title = prompt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) || '定时任务';
      }
    }
    if (patch.profileId !== undefined) {
      const profileId = String(patch.profileId).trim();
      if (!profileId) throw new Error('请选择一个模型');
      task.profileId = profileId;
    }
    if (patch.sessionMode !== undefined) {
      task.sessionMode = patch.sessionMode === 'existing' ? 'existing' : 'new';
      if (task.sessionMode === 'new') task.sessionId = undefined;
    }
    if (patch.sessionId !== undefined && task.sessionMode === 'existing') {
      const sessionId = String(patch.sessionId).trim();
      if (!sessionId) throw new Error('请选择一个已有会话');
      task.sessionId = sessionId;
    }
    if (task.sessionMode === 'existing' && !task.sessionId) throw new Error('请选择一个已有会话');
    if (patch.schedule !== undefined) task.schedule = normalizeSchedule(patch.schedule);
    if (patch.enabled !== undefined) task.enabled = patch.enabled === true;
    task.updatedAt = now;
    task.nextRunAt = task.enabled ? nextRunAfter(task.schedule, now) : null;
    this.persist();
    this.emit(task);
    return { ...task };
  }

  remove(id: string): boolean {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    const [task] = this.tasks.splice(index, 1);
    this.persist();
    this.emit(task);
    return true;
  }

  /** Run a task now without disturbing its schedule. */
  async runNow(id: string): Promise<ScheduledTask> {
    const task = this.require(id);
    if (this.running.has(task.id)) throw new Error('这个任务正在执行');
    await this.execute(task, false);
    return { ...task };
  }

  start(): void {
    if (this.timer) return;
    // A task whose saved slot predates this launch is reported, then rolled
    // forward: replaying every missed occurrence would fire a burst at login.
    for (const task of this.tasks) this.recoverMissed(task);
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests: one deterministic pass over the due list. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.tasks.filter((task) =>
        task.enabled
        && !this.running.has(task.id)
        && task.nextRunAt !== null
        && task.nextRunAt <= now);
      for (const task of due) {
        if (now - (task.nextRunAt as number) > this.graceMs) {
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
    } finally {
      this.ticking = false;
    }
  }

  private async execute(task: ScheduledTask, scheduled: boolean): Promise<void> {
    this.running.add(task.id);
    const startedAt = this.now();
    try {
      let sessionId = task.sessionId;
      if (task.sessionMode === 'existing' && task.sessionId) {
        await this.host.bindSession(task.sessionId, task.profileId);
      } else {
        sessionId = await this.host.createSession({ title: task.title, profileId: task.profileId });
        task.sessionId = undefined;
      }
      if (!sessionId) throw new Error('无法创建会话');
      await this.host.sendPrompt(sessionId, task.prompt);
      task.lastStatus = 'ok';
      task.lastError = undefined;
      task.lastSessionId = sessionId;
      task.runCount += 1;
    } catch (error) {
      task.lastStatus = 'error';
      task.lastError = (error as Error)?.message || '执行失败';
      task.runCount += 1;
      this.log(`task ${task.id} failed: ${task.lastError}`);
    } finally {
      this.running.delete(task.id);
      task.lastRunAt = startedAt;
      if (scheduled) this.rollForward(task, this.now());
      this.persist();
      this.emit(task);
    }
  }

  private rollForward(task: ScheduledTask, from: number): void {
    const anchor = Math.max(task.nextRunAt ?? 0, from);
    task.nextRunAt = task.enabled ? nextRunAfter(task.schedule, anchor) : null;
  }

  private recoverMissed(task: ScheduledTask): void {
    if (!task.enabled) { task.nextRunAt = null; return; }
    const now = this.now();
    if (task.nextRunAt === null) { task.nextRunAt = nextRunAfter(task.schedule, now); return; }
    if (task.nextRunAt > now) return;
    if (now - task.nextRunAt <= this.graceMs) return; // still due; tick will run it
    task.lastStatus = 'missed';
    task.lastError = '应用当时未运行';
    task.nextRunAt = nextRunAfter(task.schedule, now);
  }

  private repairSchedule(task: ScheduledTask): void {
    try {
      task.schedule = normalizeSchedule(task.schedule);
      task.prompt = String(task.prompt || '');
      task.runCount = Number(task.runCount) || 0;
      if (!task.enabled) task.nextRunAt = null;
      else if (task.nextRunAt === null) task.nextRunAt = nextRunAfter(task.schedule, this.now());
    } catch {
      task.enabled = false;
      task.nextRunAt = null;
    }
  }

  private require(id: string): ScheduledTask {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error('定时任务不存在');
    return task;
  }

  private persist(): void {
    try {
      saveScheduledTasks(this.options.file, this.tasks);
    } catch (error) {
      this.log(`failed to persist: ${(error as Error).message}`);
    }
  }

  private emit(task: ScheduledTask): void {
    for (const listener of this.listeners) {
      try { listener({ ...task }); } catch { /* a listener must not break scheduling */ }
    }
  }
}
