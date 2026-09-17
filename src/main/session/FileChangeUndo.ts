import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ToolExecutionResult } from '../providers/types';
import { resolveScopedPath } from '../security/PathSandbox';
import { withFileLocks } from '../tools/FileWriteLocks';
type Change = NonNullable<ToolExecutionResult['fileChange']>;
const summary = require(path.join(__dirname, '../../../src/renderer/services/FileChangeSummary.js')) as { group(changes: Change[]): Array<Change & { records: Change[] }> };
export const groupFileChanges = summary.group;
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function undoUnavailable(changes: Change[]): string | undefined {
  if (!changes.length) return '没有可撤销的文件修改';
  for (const file of summary.group(changes)) {
    let previous: Change | undefined;
    for (const record of file.records) {
      const r = record.rollback;
      if (!r || r.version !== 1 || !record.absolutePath || !/^[a-f0-9]{64}$/.test(r.afterSha256) ||
          typeof r.beforeBase64 !== 'string' || r.beforeBase64.length > 700000) return record.undoUnavailable || '旧记录没有完整撤销快照';
      if (previous && (!r.beforeExists || sha256(Buffer.from(r.beforeBase64, 'base64')) !== previous.rollback!.afterSha256)) return '同一文件的多次修改之间有其他写入，请逐项审查';
      previous = record;
    }
  }
  return undefined;
}
/** No client-supplied paths/content. Preflight the entire turn before changing any file. */
export async function undoFileChanges(changes: Change[], roots: string[], alreadyUndone: string[] = [], onRestored: (file: string) => Promise<void> = async () => {}): Promise<string[]> {
  const reason = undoUnavailable(changes);
  if (reason) throw new Error(reason);
  const groups = summary.group(changes).filter(file => !alreadyUndone.includes(file.absolutePath!));
  return withFileLocks(groups.map(file => file.absolutePath!), async () => {
    const plans: Array<{ target: string; before: Buffer; existed: boolean; mode: number; hash: string }> = [];
    const validatePath = (target: string) => {
      const actual = resolveScopedPath(target, roots);
      const normalize = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
      if (normalize(actual) !== normalize(target)) throw new Error(`文件路径已改变：${target}`);
      return actual;
    };
    for (const file of groups) {
      const target = validatePath(file.absolutePath!);
      const first = file.records[0].rollback!, last = file.records[file.records.length - 1].rollback!;
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`文件类型已改变：${file.path}`);
      const current = await fs.readFile(target);
      if (sha256(current) !== last.afterSha256) throw new Error(`文件已有后续修改，未撤销：${file.path}`);
      plans.push({ target, before: Buffer.from(first.beforeBase64, 'base64'), existed: first.beforeExists, mode: stat.mode, hash: last.afterSha256 });
    }
    const restored: string[] = [];
    for (const plan of plans) {
      validatePath(plan.target);
      // Recheck immediately before replacing; external editors do not share our locks.
      if (sha256(await fs.readFile(plan.target)) !== plan.hash) throw new Error(`文件已有后续修改，未撤销：${plan.target}`);
      if (!plan.existed) await fs.unlink(plan.target);
      else {
        const temp = `${plan.target}.${randomUUID()}.undo.tmp`;
        let created = false;
        try {
          const handle = await fs.open(temp, 'wx', plan.mode); created = true;
          try { await handle.writeFile(plan.before); await handle.sync(); } finally { await handle.close(); }
          validatePath(plan.target);
          if (sha256(await fs.readFile(plan.target)) !== plan.hash) throw new Error(`文件已有后续修改，未撤销：${plan.target}`);
          await fs.rename(temp, plan.target); created = false;
        } finally { if (created) await fs.unlink(temp).catch(() => {}); }
      }
      restored.push(plan.target);
      // Persist progress after each successful replacement so partial I/O failures are explicit/retryable.
      await onRestored(plan.target);
    }
    return restored;
  });
}
