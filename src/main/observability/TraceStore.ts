import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, truncateSync, unlinkSync } from 'fs';
import * as path from 'path';
import { TraceEvent } from './Trace';

export interface TraceStoreOptions { maxFileBytes?: number; maxReadBytes?: number; maxFiles?: number; }

export class TraceStore {
  private readonly maxFileBytes: number;
  private readonly maxReadBytes: number;
  private readonly maxFiles: number;
  constructor(private readonly root: string, options: TraceStoreOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
    this.maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    for (const value of [this.maxFileBytes, this.maxReadBytes, this.maxFiles]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('TraceStore limits must be positive integers');
    }
  }

  private file(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
    return path.join(this.root, `${sessionId}.jsonl`);
  }

  /** Current file plus maxFiles-1 numbered backups, newest first. */
  private rotate(file: string): void {
    const oldest = this.maxFiles === 1 ? file : `${file}.${this.maxFiles - 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = this.maxFiles - 2; index >= 0; index--) {
      const source = index === 0 ? file : `${file}.${index}`;
      if (existsSync(source)) renameSync(source, `${file}.${index + 1}`);
    }
  }

  append(sessionId: string, events: TraceEvent[]): void {
    const file = this.file(sessionId);
    if (events.length === 0) return;
    mkdirSync(this.root, { recursive: true });
    let size = existsSync(file) ? statSync(file).size : 0;
    // Compact legacy oversized files to a bounded, line-aligned tail rather than
    // retaining an oversized backup or losing all of the recent history.
    if (size > this.maxFileBytes) {
      const fd = openSync(file, 'r');
      const tail = Buffer.alloc(Math.min(this.maxFileBytes, this.maxReadBytes));
      let read: number;
      try { read = readSync(fd, tail, 0, tail.length, size - tail.length); }
      finally { closeSync(fd); }
      const newline = tail.subarray(0, read).indexOf(10);
      const retained = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1, read);
      truncateSync(file, 0);
      if (retained.length) appendFileSync(file, retained);
      size = retained.length;
    }
    if (size > 0) {
      const fd = openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 10) {
          const tail = Buffer.alloc(Math.min(size, this.maxReadBytes));
          const count = readSync(fd, tail, 0, tail.length, size - tail.length);
          const newline = tail.subarray(0, count).lastIndexOf(10);
          size = newline < 0 ? 0 : size - tail.length + newline + 1;
          truncateSync(file, size); // Drop an interrupted append before writing a new JSON line.
        }
      } finally { closeSync(fd); }
    }
    let batch = '';
    const flush = () => { if (batch) { appendFileSync(file, batch, 'utf8'); batch = ''; } };
    for (const event of events) {
      const line = JSON.stringify(event) + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > this.maxFileBytes) continue; // A single event must not defeat rotation.
      if (size + bytes > this.maxFileBytes) { flush(); this.rotate(file); size = 0; }
      batch += line;
      size += bytes;
    }
    flush();
  }

  /** Total disk reads across current file and backups are capped by maxReadBytes. */
  read(sessionId: string, limit = 300): TraceEvent[] {
    const file = this.file(sessionId);
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), 1000)) : 300;
    const newest: TraceEvent[] = [];
    let remaining = this.maxReadBytes;
    for (let index = 0; index < this.maxFiles && remaining > 0 && newest.length < count; index++) {
      let fd: number;
      try { fd = openSync(index === 0 ? file : `${file}.${index}`, 'r'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, remaining);
        const start = size - length;
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const bytes = readSync(fd, buffer, read, length - read, start + read);
          if (!bytes) break;
          read += bytes;
        }
        remaining -= length;
        const text = buffer.subarray(0, read).toString('utf8');
        const lines = (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
        if (start > 0 && !text.includes('\n')) continue;
        for (let i = lines.length - 1; i >= 0 && newest.length < count; i--) {
          if (!lines[i].trim()) continue;
          try {
            const event = JSON.parse(lines[i]) as TraceEvent;
            if (event && typeof event.at === 'number' && typeof event.name === 'string') newest.push(event);
          } catch { /* Concurrent/interrupted trailing line or damaged record: retain other complete events. */ }
        }
      } finally { closeSync(fd); }
    }
    return newest.reverse();
  }
}
