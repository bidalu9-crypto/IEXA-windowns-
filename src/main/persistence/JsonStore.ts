import * as fs from 'fs';
import * as path from 'path';

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

  private read(filePath: string): { ok: true; value: T } | { ok: false } {
    try { return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) as T }; }
    catch { return { ok: false }; }
  }
}

export function writeTextAtomic(filePath: string, content: string | Buffer, backup = true): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (backup && fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, 'w');
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.renameSync(tempPath, filePath);
}
