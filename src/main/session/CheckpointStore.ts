// =============================================================================
// IEXA PC - Session checkpoints
//
// A checkpoint is one user request's worth of file changes: for every file the
// agent touched we keep the snapshot taken *before its first edit in that run*,
// plus the hash of the file after the run's last edit. Rewinding walks the
// checkpoints backwards and reuses undoFileChanges, so the same hash-chain and
// path-lock guarantees apply. If any file changed after the snapshot was taken,
// the rewind aborts instead of overwriting newer work.
// =============================================================================

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutionResult } from '../providers/types';
import { undoFileChanges } from './FileChangeUndo';

export type FileChange = NonNullable<ToolExecutionResult['fileChange']>;

export interface CheckpointSummary {
  id: string;
  sessionId: string;
  label: string;
  createdAt: number;
  files: string[];
  changeCount: number;
  bytes: number;
}

interface CheckpointRecord extends CheckpointSummary {
  /** One merged record per file: first `before` + last `afterSha256`. */
  changes: FileChange[];
}

const MAX_CHECKPOINTS = 20;
const MAX_FILES_PER_CHECKPOINT = 80;
const MAX_BYTES_PER_CHECKPOINT = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BASE64 = 700_000;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

function summarize(record: CheckpointRecord): CheckpointSummary {
  const { changes: _changes, ...summary } = record;
  return summary;
}

function mergePerFile(changes: FileChange[]): FileChange[] {
  const order: string[] = [];
  const merged = new Map<string, FileChange>();
  for (const change of changes) {
    const absolute = change.absolutePath;
    if (!absolute || !change.rollback || change.rollback.version !== 1) continue;
    if (typeof change.rollback.beforeBase64 !== 'string' || change.rollback.beforeBase64.length > MAX_SNAPSHOT_BASE64) continue;
    const existing = merged.get(absolute);
    if (!existing) {
      order.push(absolute);
      merged.set(absolute, { ...change, rollback: { ...change.rollback } });
      continue;
    }
    // Keep the earliest `before`; take the latest `after` so the rewind validates
    // against the state at the end of the run, not an intermediate write.
    merged.set(absolute, {
      ...change,
      rollback: {
        version: 1,
        beforeExists: existing.rollback!.beforeExists,
        beforeBase64: existing.rollback!.beforeBase64,
        afterSha256: change.rollback.afterSha256,
      },
    });
  }
  return order.map((absolute) => merged.get(absolute)!).slice(0, MAX_FILES_PER_CHECKPOINT);
}

export class CheckpointStore {
  constructor(private readonly directory: string) {}

  private file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error('会话标识无效。');
    return path.join(this.directory, `${sessionId}.json`);
  }

  load(sessionId: string): CheckpointRecord[] {
    const target = this.file(sessionId); // validation must not be swallowed by the read fallback
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is CheckpointRecord =>
        Boolean(item) && typeof item.id === 'string' && typeof item.createdAt === 'number' && Array.isArray(item.changes));
    } catch { return []; }
  }

  private save(sessionId: string, records: CheckpointRecord[]): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const target = this.file(sessionId);
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(records), 'utf8');
    fs.renameSync(temp, target);
  }

  list(sessionId: string): CheckpointSummary[] {
    return this.load(sessionId).map(summarize).sort((a, b) => b.createdAt - a.createdAt);
  }

  append(sessionId: string, label: string, changes: FileChange[]): CheckpointSummary | undefined {
    const merged = mergePerFile(changes);
    if (!merged.length) return undefined;

    const bytes = merged.reduce((total, change) => total + change.rollback!.beforeBase64.length + 512, 0);
    if (bytes > MAX_BYTES_PER_CHECKPOINT) return undefined; // too large to keep safely

    const record: CheckpointRecord = {
      id: `cp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      sessionId,
      label: (label || '未命名请求').replace(/\s+/g, ' ').slice(0, 80),
      createdAt: Date.now(),
      files: merged.map((change) => change.path),
      changeCount: merged.length,
      bytes,
      changes: merged,
    };

    const records = this.load(sessionId);
    records.push(record);
    // Drop the oldest checkpoints, keeping the newest MAX_CHECKPOINTS entries.
    while (records.length > MAX_CHECKPOINTS) records.shift();
    this.save(sessionId, records);
    return summarize(record);
  }

  /**
   * Rewind to (and including) the given checkpoint: every checkpoint created
   * after it is undone, newest first. Nothing is truncated unless every undo
   * succeeded, so a conflicted file leaves the history intact.
   */
  async rewind(sessionId: string, checkpointId: string, roots: string[]): Promise<{ restored: string[]; removed: number }> {
    const records = this.load(sessionId);
    const index = records.findIndex((record) => record.id === checkpointId);
    if (index < 0) throw new Error('检查点不存在或已被清理。');

    const restored = new Set<string>();
    for (let cursor = records.length - 1; cursor > index; cursor--) {
      try {
        const files = await undoFileChanges(records[cursor].changes, roots);
        for (const file of files) restored.add(file);
      } catch (error) {
        throw new Error(`回退失败（${records[cursor].label}）：${(error as Error).message}`);
      }
    }
    const kept = records.slice(0, index + 1);
    this.save(sessionId, kept);
    return { restored: [...restored], removed: records.length - kept.length };
  }

  clear(sessionId: string): void {
    try { fs.unlinkSync(this.file(sessionId)); } catch { /* already absent */ }
  }
}
