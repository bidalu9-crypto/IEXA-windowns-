import { JsonStore } from '../persistence/JsonStore';

export type GoalStatus = 'active' | 'done' | 'blocked';

export interface GoalRecord {
  sessionId: string;
  objective: string;
  doneWhen: string;
  status: GoalStatus;
  notes: string[];
  createdAt: number;
  updatedAt: number;
}

interface GoalFile { version: 1; goals: GoalRecord[]; }

const MAX_OBJECTIVE = 4000;
const MAX_DONE_WHEN = 1000;
const MAX_NOTE = 400;
const MAX_NOTES = 12;
const MAX_GOALS = 100;

const clip = (value: unknown, limit: number): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/**
 * The objective used to evaporate at the first compaction: the summary kept
 * the recent turns and dropped the reason they existed. A goal is stored
 * outside the transcript and re-injected every turn, so it survives both
 * compaction and a process restart.
 */
export class GoalStore {
  private readonly store: JsonStore<GoalFile>;
  private cache?: GoalFile;

  constructor(filePath: string) {
    this.store = new JsonStore<GoalFile>(filePath, () => ({ version: 1, goals: [] }));
  }

  private load(): GoalFile {
    if (this.cache) return this.cache;
    const parsed = this.store.loadSync();
    const goals = Array.isArray(parsed?.goals) ? parsed.goals.filter(item =>
      item && typeof item.sessionId === 'string' && typeof item.objective === 'string') : [];
    this.cache = { version: 1, goals };
    return this.cache;
  }

  private save(): void {
    if (!this.cache) return;
    if (this.cache.goals.length > MAX_GOALS) {
      this.cache.goals = [...this.cache.goals].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_GOALS);
    }
    this.store.saveSync(this.cache);
  }

  get(sessionId: string): GoalRecord | null {
    return this.load().goals.find(item => item.sessionId === sessionId) || null;
  }

  set(sessionId: string, objective: string, doneWhen = ''): GoalRecord {
    const now = Date.now();
    const file = this.load();
    const existing = file.goals.find(item => item.sessionId === sessionId);
    const record: GoalRecord = {
      sessionId,
      objective: clip(objective, MAX_OBJECTIVE),
      doneWhen: clip(doneWhen, MAX_DONE_WHEN),
      status: 'active',
      notes: existing?.notes?.slice(-MAX_NOTES) || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    file.goals = [...file.goals.filter(item => item.sessionId !== sessionId), record];
    this.save();
    return record;
  }

  update(sessionId: string, patch: { status?: GoalStatus; note?: string; doneWhen?: string }): GoalRecord | null {
    const record = this.get(sessionId);
    if (!record) return null;
    if (patch.status) record.status = patch.status;
    if (patch.doneWhen !== undefined) record.doneWhen = clip(patch.doneWhen, MAX_DONE_WHEN);
    if (patch.note) {
      record.notes = [...record.notes, clip(patch.note, MAX_NOTE)].slice(-MAX_NOTES);
    }
    record.updatedAt = Date.now();
    this.save();
    return record;
  }

  clear(sessionId: string): boolean {
    const file = this.load();
    const before = file.goals.length;
    file.goals = file.goals.filter(item => item.sessionId !== sessionId);
    if (file.goals.length === before) return false;
    this.save();
    return true;
  }

  format(record: GoalRecord): string {
    const status = record.status === 'done' ? '已完成' : record.status === 'blocked' ? '受阻' : '进行中';
    const lines = [`目标：${record.objective}`, `完成标准：${record.doneWhen || '(未声明)'}`, `状态：${status}`];
    if (record.notes.length) lines.push('进度记录：', ...record.notes.map(note => `- ${note}`));
    return lines.join('\n');
  }

  /** Fresh each turn, so a compaction between turns cannot drop the objective. */
  promptBlock(sessionId: string): string {
    const record = this.get(sessionId);
    if (!record || record.status === 'done') return '';
    return `当前目标（跨压缩保持，除非用户改变方向，否则不要偏离）：\n${this.format(record)}`;
  }
}
