import * as path from 'path';
/** Shared across FileTools instances and undo requests. Lock ordering prevents deadlock. */
const locks = new Map<string, Promise<void>>();
export async function withFileLocks<T>(paths: string[], work: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)))].sort();
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) {
      const previous = locks.get(key) || Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>(resolve => { release = resolve; });
      locks.set(key, current);
      await previous;
      releases.push(() => { release(); if (locks.get(key) === current) locks.delete(key); });
    }
    return await work();
  } finally { for (const release of releases.reverse()) release(); }
}
