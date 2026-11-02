// Tools that let the model manage its own workspace surfaces: the Bot roster and
// the scheduled tasks. Both already existed as HTTP routes for the UI; the model
// could not reach them, so "create me a Bot for X" required the user to click.
//
// Two rules keep this from widening the blast radius of a tool call:
//
//  - A Bot may only be granted tools the *calling* agent already has. Without
//    that check a model could mint a Bot with shell access and hand itself a
//    capability the user never approved.
//  - A scheduled task is created disabled. It runs later, unattended, with a
//    prompt nobody reviews at execution time; making the user switch it on is
//    the only place a human can still say no.
import type { BotProfile, BotStore } from '../bots/BotStore';
import type { ToolExecutionResult } from '../providers/types';
import type { TaskScheduler } from '../tasks/Scheduler';
import type { ScheduledTask } from '../tasks/ScheduledTasks';
import { describeSchedule } from '../tasks/ScheduledTasks';

const MAX_BOTS = 100;

function text(value: unknown, limit: number): string {
  const raw = String(value ?? '').trim();
  if (raw.length > limit) throw new Error(`文字超长（上限 ${limit} 字）`);
  return raw;
}

/** One line per Bot: enough to pick one without dumping personas into context. */
function summariseBot(bot: BotProfile): string {
  const tools = bot.allowedTools.length ? bot.allowedTools.join(', ') : '未授权任何工具';
  return `- ${bot.name}${bot.id ? ` (${bot.id})` : ''} · 模型 ${bot.profileId} · 工具：${tools}`;
}

export class BotTools {
  constructor(
    private readonly store: BotStore,
    /** Tools the calling agent may use; a new Bot can never exceed this set. */
    private readonly callerTools: () => string[],
    /** Profile used when the model does not name one explicitly. */
    private readonly defaultProfile: () => string,
  ) {}

  list(): ToolExecutionResult {
    const bots = this.store.list();
    if (!bots.length) return { output: '（还没有创建任何 Bot。可用 bot_create 创建。）', success: true };
    return { output: `共 ${bots.length} 个 Bot：\n${bots.map(summariseBot).join('\n')}`, success: true };
  }

  create(args: Record<string, unknown>): ToolExecutionResult {
    const name = text(args.name, 80);
    if (!name) return { output: 'Bot 需要一个名字。', success: false };
    const existing = this.store.list();
    if (existing.length >= MAX_BOTS) return { output: `Bot 数量已达上限（${MAX_BOTS}）。`, success: false };
    if (existing.some((bot) => bot.name === name)) return { output: `已经有一个叫「${name}」的 Bot。`, success: false };

    // A Bot is a fresh agent; every tool it gets must already be reachable from
    // here, otherwise this call would be a privilege escalator.
    const legal = new Set(this.callerTools());
    const requested = Array.isArray(args.allowedTools) ? args.allowedTools.map((tool) => String(tool).trim()) : [];
    const rejected = requested.filter((tool) => tool && !legal.has(tool));
    if (rejected.length) {
      return {
        output: `这些工具当前不可授予：${rejected.join(', ')}。可授予：${[...legal].join(', ') || '（无）'}`,
        success: false,
      };
    }

    const profileId = text(args.profileId, 200) || this.defaultProfile();
    if (!profileId) return { output: '需要一个模型（profileId）来运行这个 Bot。', success: false };

    const bot = this.store.save({
      name,
      description: text(args.description, 600),
      persona: text(args.persona, 12000),
      memory: text(args.memory, 16000),
      profileId,
      allowedTools: requested.filter(Boolean),
    });
    return {
      output: `已创建 Bot「${bot.name}」。可以在侧栏「Bot 团队」里打开它并开始聊天。\n${summariseBot(bot)}`,
      success: true,
    };
  }

  remove(args: Record<string, unknown>): ToolExecutionResult {
    const id = text(args.botId, 80);
    const name = text(args.name, 80);
    const bots = this.store.list();
    const bot = id ? bots.find((item) => item.id === id) : bots.find((item) => item.name === name);
    if (!bot) return { output: id ? `找不到 Bot：${id}` : `找不到名为「${name}」的 Bot。`, success: false };
    if (args.confirm !== true) {
      return { output: `将删除 Bot「${bot.name}」。这会移除它的配置与该 Bot 的记忆目录，聊天历史仍保留。确认请传 confirm: true。`, success: false };
    }
    this.store.remove(bot.id);
    return { output: `已删除 Bot「${bot.name}」。它名下的聊天历史仍然保留，只是不能再继续对话。`, success: true };
  }
}

/** Local ISO-ish rendering: "每天 09:00" already comes from describeSchedule. */
function summariseTask(task: ScheduledTask): string {
  const when = describeSchedule(task.schedule);
  const state = task.enabled ? '启用' : '未启用';
  const last = task.lastStatus ? `，上次 ${task.lastStatus}` : '';
  return `- ${task.title} (${task.id}) · ${when} · ${state}${last}`;
}

export class ScheduledTaskTools {
  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly defaultProfile: () => string,
    /** Session the task reports back to when the model does not name one. */
    private readonly defaultSession: () => string,
  ) {}

  list(): ToolExecutionResult {
    const tasks = this.scheduler.list();
    if (!tasks.length) return { output: '（还没有定时任务。可用 schedule_create 创建。）', success: true };
    return { output: `共 ${tasks.length} 个定时任务：\n${tasks.map(summariseTask).join('\n')}`, success: true };
  }

  create(args: Record<string, unknown>): ToolExecutionResult {
    const prompt = text(args.prompt, 20000);
    if (!prompt) return { output: '定时任务需要 prompt（到点要发给模型的提示词）。', success: false };
    const profileId = text(args.profileId, 200) || this.defaultProfile();
    if (!profileId) return { output: '需要一个模型（profileId）来执行这个任务。', success: false };

    const raw: Record<string, unknown> = {
      prompt,
      profileId,
      customTitle: false,
      sessionMode: args.sessionMode === 'existing' ? 'existing' : 'new',
      // Deliberately disabled: this prompt will run later with nobody watching.
      enabled: false,
      schedule: args.schedule,
    };
    if (args.title) raw.title = text(args.title, 80);
    if (raw.sessionMode === 'existing') raw.sessionId = text(args.sessionId, 80) || this.defaultSession();

    let task: ScheduledTask;
    try {
      task = this.scheduler.create(raw, { profileId });
    } catch (error) {
      return { output: `创建失败：${(error as Error).message}`, success: false };
    }
    return {
      output: [
        `已创建定时任务「${task.title}」(${task.id})。`,
        `时间：${describeSchedule(task.schedule)}`,
        '状态：未启用。定时任务会在你不在场时自动执行，所以默认不开启；',
        '请在侧栏「定时任务」里确认内容后再启用它，或用 schedule_enable 打开。',
      ].join('\n'),
      success: true,
    };
  }

  remove(args: Record<string, unknown>): ToolExecutionResult {
    const id = text(args.taskId, 80);
    const tasks = this.scheduler.list();
    const task = id ? tasks.find((item) => item.id === id) : undefined;
    if (!task) return { output: `找不到定时任务：${id || '(未提供 taskId)'}`, success: false };
    if (args.confirm !== true) {
      return { output: `将删除定时任务「${task.title}」。确认请传 confirm: true。`, success: false };
    }
    this.scheduler.remove(task.id);
    return { output: `已删除定时任务「${task.title}」。`, success: true };
  }

  /** Enabling is a separate, explicit call so it cannot happen by accident. */
  manage(args: Record<string, unknown>): ToolExecutionResult {
    const id = text(args.taskId, 80);
    const task = id ? this.scheduler.find(id) : undefined;
    if (!task) return { output: `找不到定时任务：${id || '(未提供 taskId)'}`, success: false };
    const action = String(args.action || '');

    if (action === 'delete') {
      if (args.confirm !== true) {
        return { output: `将删除定时任务「${task.title}」。确认请传 confirm: true。`, success: false };
      }
      this.scheduler.remove(task.id);
      return { output: `已删除定时任务「${task.title}」。`, success: true };
    }

    const enable = action === 'enable';
    if (!enable && action !== 'disable') {
      return { output: 'action 只能是 enable、disable 或 delete。', success: false };
    }
    if (args.confirm !== true) {
      return {
        output: `${enable ? '启用' : '停用'}「${task.title}」(${describeSchedule(task.schedule)})？确认请传 confirm: true。`,
        success: false,
      };
    }
    const updated = this.scheduler.update(task.id, { enabled: enable });
    return { output: `「${updated.title}」现在${updated.enabled ? '已启用，会按计划执行' : '已停用，不会再自动执行'}。`, success: true };
  }
}
