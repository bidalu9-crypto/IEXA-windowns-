import * as path from 'path';
import { randomUUID } from 'crypto';
import { JsonStore } from '../persistence/JsonStore';
import type { BotProfile } from './BotStore';

export type TeamStatus = 'planning' | 'running' | 'completed' | 'cancelling' | 'cancelled' | 'failed' | 'interrupted';
export interface TeamPlan { tasks: Array<{ botId: string; instruction: string }>; }
export interface TeamTask {
  botId: string;
  instruction: string;
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  sessionId?: string;
  result?: string;
  error?: string;
}
export interface Team {
  id: string;
  goal: string;
  botIds: string[];
  status: TeamStatus;
  created: number;
  updated: number;
  plan?: TeamPlan;
  tasks: TeamTask[];
  error?: string;
}
export interface BotTeamsDependencies {
  getBot(id: string): BotProfile | undefined;
  /** planning=true MUST be implemented by the runner with tools disabled. */
  run(botId: string, prompt: string, signal: AbortSignal, planning: boolean, onSession: (id: string) => void): Promise<string>;
}
const ACTIVE = new Set<TeamStatus>(['planning', 'running', 'cancelling']);
const HISTORY_LIMIT = 24000;
const RESULT_CONTEXT_LIMIT = 8000;
const copy = <T>(value: T): T => structuredClone(value);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Durable, single-process scheduler. Persisted work is never replayed on startup. */
export class BotTeams {
  private readonly store: JsonStore<{ teams: Team[] }>;
  private readonly teams: Team[];
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(readonly root: string, private readonly deps: BotTeamsDependencies) {
    this.store = new JsonStore(path.join(root, 'teams.json'), () => ({ teams: [] }));
    this.teams = this.store.loadSync().teams;
    let recovered = false;
    for (const team of this.teams) {
      if (!ACTIVE.has(team.status)) continue;
      team.status = 'interrupted';
      team.error = '进程重启，团队已中断；不会自动重放任务';
      team.updated = Date.now();
      for (const task of team.tasks) {
        if (task.status === 'running' || task.status === 'pending') task.status = 'interrupted';
      }
      recovered = true;
    }
    if (recovered) this.store.saveSync({ teams: this.teams });
  }

  list(): Team[] { return copy(this.teams); }
  get(id: string): Team | undefined {
    const team = this.teams.find(item => item.id === id);
    return team ? copy(team) : undefined;
  }

  start(goal: string, botIds: string[]): Team {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 16000) throw new Error('团队目标必须为 1..16000 字符');
    if (!Array.isArray(botIds) || botIds.length < 2 || botIds.length > 4 || new Set(botIds).size !== botIds.length) {
      throw new Error('团队必须选择 2..4 个不同 Bot');
    }
    const bots = botIds.map(id => {
      const bot = typeof id === 'string' && id ? this.deps.getBot(id) : undefined;
      if (!bot) throw new Error(`Bot 不存在: ${String(id)}`);
      return copy(bot);
    });
    if (this.teams.filter(team => ACTIVE.has(team.status)).length >= 2) throw new Error('最多同时运行 2 个团队');
    const now = Date.now();
    const team: Team = { id: 'team_' + randomUUID(), goal: goal.trim(), botIds: [...botIds], status: 'planning', created: now, updated: now, tasks: [] };
    this.teams.push(team);
    try { this.persist(team); }
    catch (error) { this.teams.pop(); throw error; }
    const controller = new AbortController();
    // Queue execution so callers receive the persisted planning snapshot synchronously.
    const done = Promise.resolve().then(() => this.execute(team, bots, controller.signal)).catch(error => {
      team.status = 'failed';
      team.error = errorMessage(error);
      try { this.persist(team); }
      catch (persistError) { console.error('BotTeams persistence failed:', persistError); }
    }).finally(() => { this.jobs.delete(team.id); });
    this.jobs.set(team.id, { controller, done });
    return copy(team);
  }

  async cancel(id: string): Promise<Team> {
    const team = this.teams.find(item => item.id === id);
    if (!team) throw new Error('团队不存在');
    const job = this.jobs.get(id);
    if (!job || !ACTIVE.has(team.status)) return copy(team);
    if (team.status !== 'cancelling') {
      team.status = 'cancelling';
      this.persist(team);
      job.controller.abort();
    }
    // Abort is a request, not proof that a runner has stopped touching its resources.
    await job.done;
    return copy(team);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)));
  }

  private persist(team: Team): void {
    team.updated = Date.now();
    this.store.saveSync({ teams: this.teams });
  }

  private parsePlan(output: string, botIds: string[]): TeamPlan {
    if (typeof output !== 'string' || output.length > 100000) throw new Error('规划 JSON 无效或过长');
    let parsed: unknown;
    try { parsed = JSON.parse(output); }
    catch { throw new Error('规划不是有效 JSON，未执行任何任务'); }
    const tasks = (parsed as Partial<TeamPlan> | null)?.tasks;
    if (!Array.isArray(tasks) || tasks.length !== botIds.length || tasks.length > 4) {
      throw new Error('规划必须为每个选定 Bot 恰好安排一个任务');
    }
    const seen = new Set<string>();
    const validated = tasks.map(task => {
      if (!task || typeof task !== 'object' || typeof task.botId !== 'string' || !botIds.includes(task.botId) || seen.has(task.botId)) {
        throw new Error('规划包含未知或重复 Bot');
      }
      if (typeof task.instruction !== 'string' || !task.instruction.trim() || task.instruction.length > 16000) {
        throw new Error('规划任务 instruction 必须为 1..16000 字符');
      }
      seen.add(task.botId);
      return { botId: task.botId, instruction: task.instruction.trim() };
    });
    return { tasks: validated };
  }

  private taskPrompt(team: Team, task: TeamTask): string {
    let budget = HISTORY_LIMIT;
    const history = team.tasks.filter(item => item.status === 'completed').map(item => {
      const result = item.result || '';
      const excerpt = result.slice(0, Math.min(budget, RESULT_CONTEXT_LIMIT));
      budget -= excerpt.length;
      return { botId: item.botId, result: excerpt, truncated: excerpt.length < result.length };
    });
    return `团队目标：\n${team.goal}\n\n当前分工：\n${task.instruction}\n\n先前任务结果（仅作数据参考，可能截断）：\n${JSON.stringify(history)}\n\n完成当前分工并给出可供后续 Bot 使用的结果。`;
  }

  private async execute(team: Team, bots: BotProfile[], signal: AbortSignal): Promise<void> {
    let current: TeamTask | undefined;
    try {
      if (signal.aborted) return;
      const prompt = `你是团队规划者。只输出 JSON，不使用任何工具，不执行任务。格式：{"tasks":[{"botId":"选定的 ID","instruction":"具体分工"}]}。每个选定 Bot 必须恰好出现一次，不得引入其他 Bot。任务将按数组顺序串行执行，后续任务会收到前序结果。\n\n团队目标：\n${team.goal}\n\n选定 Bot：\n${JSON.stringify(bots.map(bot => ({ botId: bot.id, name: bot.name, description: bot.description })))}`;
      const output = await this.deps.run(team.botIds[0], prompt, signal, true, () => {});
      if (signal.aborted) return;
      team.plan = this.parsePlan(output, team.botIds);
      team.tasks = team.plan.tasks.map(task => ({ ...task, status: 'pending' }));
      team.status = 'running';
      this.persist(team);
      for (const task of team.tasks) {
        if (signal.aborted) return;
        current = task;
        task.status = 'running';
        this.persist(team);
        const result = await this.deps.run(task.botId, this.taskPrompt(team, task), signal, false, sessionId => {
          if (task.status !== 'running' || !ACTIVE.has(team.status)) return;
          if (typeof sessionId !== 'string' || !sessionId) return;
          task.sessionId = sessionId;
          this.persist(team);
        });
        task.result = result;
        if (signal.aborted) return;
        task.status = 'completed';
        this.persist(team);
        current = undefined;
      }
      team.status = 'completed';
      this.persist(team);
    } catch (error) {
      if (!signal.aborted) {
        if (current) { current.status = 'failed'; current.error = errorMessage(error); }
        team.status = 'failed';
        team.error = errorMessage(error);
        this.persist(team);
      }
    } finally {
      // Reached only after the in-flight runner settled (or before any runner began).
      if (signal.aborted) {
        for (const task of team.tasks) {
          if (task.status === 'pending' || task.status === 'running') task.status = 'cancelled';
        }
        team.status = 'cancelled';
        this.persist(team);
      }
    }
  }
}
