// =============================================================================
// Scheduled tasks: data model, wall-clock schedule math and the JSON store.
//
// Schedules are wall-clock, not intervals: "每天 09:00" fires at 09:00 local
// even across a DST change, and a monthly task pinned to the 31st falls back to
// the last day of shorter months instead of silently skipping them.
// =============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { stripBom } from '../persistence/stripBom';

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';

export interface ScheduledTaskSchedule {
  frequency: ScheduleFrequency;
  /** Local wall-clock time, `HH:mm`. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. Weekly only. */
  weekday?: number;
  /** 1–31. Monthly only; clamped to the last day of shorter months. */
  dayOfMonth?: number;
}

export type ScheduledTaskStatus = 'ok' | 'error' | 'missed';

export interface ScheduledTask {
  id: string;
  title: string;
  /** True when the title was typed by the user instead of derived from the prompt. */
  customTitle?: boolean;
  prompt: string;
  profileId: string;
  /** `new` opens a fresh conversation per run; `existing` reuses one. */
  sessionMode: 'new' | 'existing';
  sessionId?: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt?: number;
  lastStatus?: ScheduledTaskStatus;
  lastError?: string;
  lastSessionId?: string;
  runCount: number;
}

export interface ScheduledTaskInput {
  title?: string;
  customTitle?: boolean;
  prompt: string;
  profileId: string;
  sessionMode?: 'new' | 'existing';
  sessionId?: string;
  schedule: ScheduledTaskSchedule;
  enabled?: boolean;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_PROMPT = 20000;
const MAX_TITLE = 80;

export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(String(value || ''));
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function normalizeSchedule(raw: unknown): ScheduledTaskSchedule {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const frequency = input.frequency === 'weekly' || input.frequency === 'monthly' ? input.frequency : 'daily';
  const time = String(input.time || '').trim();
  if (!parseClockTime(time)) throw new Error('时间需要 HH:mm 格式');
  const schedule: ScheduledTaskSchedule = { frequency, time };
  if (frequency === 'weekly') {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('每周任务需要一个星期值');
    schedule.weekday = weekday;
  }
  if (frequency === 'monthly') {
    const day = Number(input.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('每月任务需要一个 1–31 的日期');
    schedule.dayOfMonth = day;
  }
  return schedule;
}

export function normalizeInput(raw: unknown): ScheduledTaskInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('请填写提示词');
  if (prompt.length > MAX_PROMPT) throw new Error(`提示词不能超过 ${MAX_PROMPT} 字`);
  const profileId = String(input.profileId || '').trim();
  if (!profileId) throw new Error('请选择一个模型');
  const sessionMode = input.sessionMode === 'existing' ? 'existing' : 'new';
  const sessionId = sessionMode === 'existing' ? String(input.sessionId || '').trim() : undefined;
  if (sessionMode === 'existing' && !sessionId) throw new Error('请选择一个已有会话');
  const fallbackTitle = prompt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) || '定时任务';
  const rawTitle = String(input.title || '').trim();
  return {
    title: rawTitle.slice(0, MAX_TITLE) || fallbackTitle,
    customTitle: rawTitle.length > 0,
    prompt,
    profileId,
    sessionMode,
    sessionId,
    schedule: normalizeSchedule(input.schedule),
    enabled: input.enabled !== false,
  };
}

/** Next wall-clock occurrence strictly after `after` (epoch ms). */
export function nextRunAfter(schedule: ScheduledTaskSchedule, after: number): number | null {
  const clock = parseClockTime(schedule.time);
  if (!clock) return null;
  const { hour, minute } = clock;
  const base = new Date(after);
  const stamp = (year: number, month: number, day: number) =>
    new Date(year, month, day, hour, minute, 0, 0).getTime();

  if (schedule.frequency === 'weekly') {
    const target = Number.isInteger(schedule.weekday) ? Number(schedule.weekday) : base.getDay();
    const delta = (target - base.getDay() + 7) % 7;
    let next = stamp(base.getFullYear(), base.getMonth(), base.getDate() + delta);
    if (next <= after) next = stamp(base.getFullYear(), base.getMonth(), base.getDate() + delta + 7);
    return next;
  }

  if (schedule.frequency === 'monthly') {
    const wanted = Math.min(31, Math.max(1, Number(schedule.dayOfMonth) || 1));
    const monthDay = (year: number, month: number) => {
      const days = new Date(year, month + 1, 0).getDate();
      return Math.min(wanted, days);
    };
    let next = stamp(base.getFullYear(), base.getMonth(), monthDay(base.getFullYear(), base.getMonth()));
    if (next <= after) {
      const monthIndex = base.getMonth() + 1;
      const year = base.getFullYear() + Math.floor(monthIndex / 12);
      const month = monthIndex % 12;
      next = stamp(year, month, monthDay(year, month));
    }
    return next;
  }

  let next = stamp(base.getFullYear(), base.getMonth(), base.getDate());
  if (next <= after) next = stamp(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  return next;
}

export function describeSchedule(schedule: ScheduledTaskSchedule): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (schedule.frequency === 'weekly') return `每周${weekdays[schedule.weekday ?? 0]} ${schedule.time}`;
  if (schedule.frequency === 'monthly') return `每月 ${schedule.dayOfMonth ?? 1} 日 ${schedule.time}`;
  return `每天 ${schedule.time}`;
}

export function loadScheduledTasks(file: string): ScheduledTask[] {
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    const list = Array.isArray(parsed) ? parsed : parsed?.tasks;
    if (!Array.isArray(list)) return [];
    return list.filter((task): task is ScheduledTask => !!task && typeof task === 'object' && typeof task.id === 'string');
  } catch {
    return [];
  }
}

export function saveScheduledTasks(file: string, tasks: ScheduledTask[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename keeps a crash mid-write from truncating the schedule file.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, tasks }, null, 2), 'utf8');
  fs.renameSync(temp, file);
}
