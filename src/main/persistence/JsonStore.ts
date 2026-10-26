import * as fs from 'fs';
import * as path from 'path';
const pendingWrites = new Map<string, Promise<void>>();

/** Crash-tolerant JSON persistence with a last-known-good backup. */
export class JsonStore<T> {
  constructor(private readonly filePath: string, private readonly fallback: () => T) {}

  loadSync(): T {
    const primary = this.read(this.filePath);
    if (primary.ok) return primary.value;
    const backup = this.read(`${this.filePath}.bak`);
    return backup.ok ? backup.value : this.fallback();
  }

  saveSync(value: T): void { writeTextAtomic(this.filePath, JSON.stringify(value, null, 2), true); }

  async save(value: T): Promise<void> {
    const content = JSON.stringify(value);
    const previous = pendingWrites.get(this.filePath) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await backupByLink(this.filePath);
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        const file = await fs.promises.open(temporary, 'w');
        try { await file.writeFile(content); await file.sync(); }
        finally { await file.close(); }
        await fs.promises.rename(temporary, this.filePath);
      } finally {
        await fs.promises.unlink(temporary).catch(() => {});
      }
    });
    pendingWrites.set(this.filePath, write);
    try { await write; }
    finally { if (pendingWrites.get(this.filePath) === write) pendingWrites.delete(this.filePath); }
  }

  private read(filePath: string): { ok: true; value: T } | { ok: false } {
    try { return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as T }; }
    catch { return { ok: false }; }
  }
}

/**
 * Refresh `<file>.bak` as a hard link to `file`.
 *
 * Hard links are O(1): the rename that follows swaps the directory entry, while
 * `.bak` keeps the previous inode alive. Callers must therefore replace the file
 * (write temp + rename) instead of rewriting it in place — an in-place write
 * would mutate both names.
 *
 * Files below the threshold are copied: the copy costs nothing at that size and
 * stays correct even if a future caller writes in place. Filesystems without
 * link support (FAT/exFAT, cross-device targets) also fall back to a copy, so
 * the recovery guarantee never depends on the optimisation.
 */
const LINK_THRESHOLD_BYTES = 1024 * 1024;

function useLink(filePath: string): boolean {
  try { return fs.statSync(filePath).size >= LINK_THRESHOLD_BYTES; }
  catch { return false; }
}

export function backupByLinkSync(filePath: string): void {
  const target = `${filePath}.bak`;
  if (!fs.existsSync(filePath)) { fs.rmSync(target, { force: true }); return; }
  fs.rmSync(target, { force: true });
  if (useLink(filePath)) {
    try { fs.linkSync(filePath, target); return; }
    catch { /* fall through to a copy */ }
  }
  fs.copyFileSync(filePath, target);
}

export async function backupByLink(filePath: string): Promise<void> {
  const target = `${filePath}.bak`;
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat) { await fs.promises.rm(target, { force: true }).catch(() => {}); return; }
  await fs.promises.rm(target, { force: true }).catch(() => {});
  if (stat.size >= LINK_THRESHOLD_BYTES) {
    try { await fs.promises.link(filePath, target); return; }
    catch { /* fall through to a copy */ }
  }
  await fs.promises.copyFile(filePath, target);
}

export function writeTextAtomic(filePath: string, content: string | Buffer, backup = true): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (backup) backupByLinkSync(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, 'w');
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* already closed */ } descriptor = undefined; }
    fs.rmSync(tempPath, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try { fs.renameSync(tempPath, filePath); }
  catch (error) { fs.rmSync(tempPath, { force: true }); throw error; }
}
