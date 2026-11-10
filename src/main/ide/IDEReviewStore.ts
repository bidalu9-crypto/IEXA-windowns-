import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { FileWorkspace, IDEError } from './FileWorkspace';
import { withFileLocks } from '../tools/FileWriteLocks';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const stores = new Set<IDEReviewStore>();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface IDEReviewRecord {
  id: string; workspaceId: string; path: string; before: string; after: string;
  beforeExists: boolean; revision: string; createdAt: number; updatedAt: number;
}
export interface IDEReviewAction {
  reviewId: string; action: 'accept' | 'reject'; revision: string;
  content?: string; baseline?: string; complete?: boolean; remove?: boolean;
}

/** Called while the ordinary Agent file tool owns its existing write lock.
 * Full snapshots stay local to the IDE; tool/SSE summaries remain bounded. */
export function recordIDEFileChange(absolutePath: string, before: string, after: string, beforeExists: boolean, afterBytes: Buffer): void {
  for (const store of stores) {
    try { store.record(absolutePath, before, after, beforeExists, hash(afterBytes)); }
    catch { /* Review observers must never turn a successful tool write into a failure. */ }
  }
}

export class IDEReviewStore extends EventEmitter {
  private readonly records = new Map<string, IDEReviewRecord>();
  private timer?: ReturnType<typeof setTimeout>;
  private persistence = Promise.resolve();
  private disposed = false;
  constructor(private readonly files: FileWorkspace, private readonly stateFile?: string) {
    super();
    if (stateFile) {
      try {
        if (fs.statSync(stateFile).size <= MAX_TOTAL * 2) {
          const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          for (const record of (Array.isArray(saved.records) ? saved.records : []).slice(-64)) {
            try {
              this.files.resolve(record.workspaceId, record.path, true);
              if (typeof record.id !== 'string' || typeof record.before !== 'string' || typeof record.after !== 'string' || !/^[a-f0-9]{64}$/.test(record.revision)) continue;
              if (Buffer.byteLength(record.before) > MAX_FILE || Buffer.byteLength(record.after) > MAX_FILE) continue;
              this.records.set(record.id, record);
            } catch { /* Removed projects do not regain access via a review record. */ }
          }
          this.trim();
        }
      } catch { /* First use or corrupt state leaves actual files untouched. */ }
    }
    stores.add(this);
  }
  record(absolutePath: string, before: string, after: string, beforeExists: boolean, revision: string): void {
    if (this.disposed || before === after && beforeExists) return;
    const project = this.files.projects().sort((a, b) => b.root.length - a.root.length).find(project => {
      const relative = path.relative(project.root, absolutePath);
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
    if (!project) return;
    const relative = path.relative(project.root, absolutePath).replace(/\\/g, '/');
    this.files.resolve(project.id, relative);
    if (Buffer.byteLength(before) > MAX_FILE || Buffer.byteLength(after) > MAX_FILE) {
      this.emit('change', { type: 'review', workspaceId: project.id, reason: 'size', message: 'AI 改动超过 4 MiB 审阅上限，请在 Git 差异中检查。' });
      return;
    }
    const existing = [...this.records.values()].find(record => record.workspaceId === project.id && record.path === relative);
    // Only consecutive, unchanged snapshots can be merged. A user's intervening
    // disk edit starts a new baseline, preserving it during a later rejection.
    const continuous = existing?.after === before;
    const id = existing?.id || randomUUID();
    const now = Date.now();
    const record: IDEReviewRecord = {
      id, workspaceId: project.id, path: relative,
      before: continuous ? existing!.before : before, after,
      beforeExists: continuous ? existing!.beforeExists : beforeExists,
      revision, createdAt: continuous ? existing!.createdAt : now, updatedAt: now,
    };
    this.records.delete(id); this.records.set(id, record);
    this.trim(); this.persist();
    this.emit('change', { type: 'review', workspaceId: project.id, reviewId: id });
  }
  list(workspaceId: string): { records: Omit<IDEReviewRecord, 'before' | 'after'>[] } {
    this.files.project(workspaceId);
    return { records: [...this.records.values()].filter(record => record.workspaceId === workspaceId).map(({ before, after, ...record }) => ({ ...record })) };
  }
  read(workspaceId: string, reviewId: string): IDEReviewRecord {
    this.files.project(workspaceId);
    const record = this.records.get(reviewId);
    if (!record || record.workspaceId !== workspaceId) throw new IDEError('IDE_REVIEW_MISSING', '这项 AI 改动已审阅或已更新，请刷新。');
    this.files.resolve(workspaceId, record.path, true);
    return { ...record };
  }
  async action(workspaceId: string, input: IDEReviewAction): Promise<{ record: IDEReviewRecord | null; content?: string; revision?: string; removed?: boolean }> {
    let record = this.read(workspaceId, input.reviewId);
    if (!['accept', 'reject'].includes(input.action) || typeof input.revision !== 'string' || input.revision !== record.revision) throw new IDEError('IDE_REVIEW_CONFLICT', 'AI 改动版本已变化，请刷新后审阅。');
    for (const value of [input.content, input.baseline]) if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > MAX_FILE)) throw new IDEError('IDE_SIZE', '审阅内容超过 4 MiB 上限。');
    const current = this.files.read(workspaceId, record.path);
    if (current.revision !== input.revision) throw new IDEError('IDE_REVIEW_CONFLICT', '文件已有后续修改，原内容已保留。请刷新并检查差异后再审阅。');
    let content = current.content, revision = current.revision, removed = false;
    let finished = false;
    const commit = () => {
      // Runs under the same file lock as disk validation/write, so a later AI
      // writer always observes the updated review baseline.
      const latest = this.records.get(record.id);
      if (!latest || latest.revision !== input.revision) throw new IDEError('IDE_REVIEW_CONFLICT', '审阅期间又有 AI 修改，请刷新。');
      record = { ...record, after: content, revision, updatedAt: Date.now(), ...(input.action === 'accept' && typeof input.baseline === 'string' ? { before: input.baseline, beforeExists: true } : {}) };
      finished = !!input.complete || removed || record.beforeExists && record.before === record.after;
      if (finished) this.records.delete(record.id); else this.records.set(record.id, record);
      this.persist();
    };
    if (input.action === 'reject') {
      if (input.remove) {
        if (record.beforeExists || !input.complete) throw new IDEError('IDE_REVIEW_ACTION', '只可完整拒绝 AI 新建的文件。');
        const target = this.files.resolve(workspaceId, record.path);
        await withFileLocks([target], async () => {
          this.files.resolve(workspaceId, record.path);
          if (this.files.read(workspaceId, record.path).revision !== input.revision) throw new IDEError('IDE_REVIEW_CONFLICT', '删除前文件已变化，已保留文件。');
          if (!fs.statSync(target).isFile()) throw new IDEError('IDE_FILE', '审阅只可操作文本文件。');
          await fs.promises.unlink(target);
          removed = true; commit();
        });
        this.files.emit('change', { type: 'files', workspaceId, path: record.path });
      } else {
        if (typeof input.content !== 'string') throw new IDEError('IDE_REVIEW_ACTION', '缺少要恢复的完整文件内容。');
        await this.files.write(workspaceId, record.path, input.content, input.revision, result => { content = result.content; revision = result.revision; commit(); });
      }
    } else {
      const target = this.files.resolve(workspaceId, record.path);
      await withFileLocks([target], async () => {
        const disk = this.files.read(workspaceId, record.path);
        if (disk.revision !== input.revision) throw new IDEError('IDE_REVIEW_CONFLICT', '接受前文件已变化，已保留文件。');
        commit();
      });
    }
    this.emit('change', { type: 'review', workspaceId, reviewId: record.id, removed: finished });
    return { record: finished ? null : { ...record }, ...(removed ? { removed: true } : { content, revision }) };
  }
  private trim(): void {
    let bytes = [...this.records.values()].reduce((total, record) => total + Buffer.byteLength(record.before) + Buffer.byteLength(record.after), 0);
    while (this.records.size > 64 || bytes > MAX_TOTAL) {
      const record = this.records.values().next().value as IDEReviewRecord | undefined;
      if (!record) break;
      bytes -= Buffer.byteLength(record.before) + Buffer.byteLength(record.after); this.records.delete(record.id);
      this.emit('change', { type: 'review', workspaceId: record.workspaceId, reviewId: record.id, removed: true, reason: 'limit', message: '较早的 AI 审阅快照超出保留上限，磁盘文件保持原样，请通过 Git 差异检查。' });
    }
  }
  private persist(): void {
    if (!this.stateFile || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 80);
    this.timer.unref();
  }
  private flush(): Promise<void> {
    if (!this.stateFile) return Promise.resolve();
    const content = JSON.stringify({ version: 1, records: [...this.records.values()] });
    const filename = this.stateFile;
    this.persistence = this.persistence.then(async () => {
      const temporary = filename + '.' + randomUUID() + '.tmp';
      try {
        await fs.promises.mkdir(path.dirname(filename), { recursive: true });
        await fs.promises.writeFile(temporary, content, { mode: 0o600 });
        await fs.promises.rename(temporary, filename);
      } catch (error) { this.emit('change', { type: 'review-storage', message: 'AI 审阅快照保存失败：' + (error as Error).message }); }
      finally { await fs.promises.unlink(temporary).catch(() => {}); }
    });
    return this.persistence;
  }
  async dispose(): Promise<void> {
    stores.delete(this); this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.flush(); this.removeAllListeners();
  }
}
