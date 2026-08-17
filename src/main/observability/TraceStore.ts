import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { TraceEvent } from './Trace';

export class TraceStore {
  constructor(private readonly root: string) {}

  append(sessionId: string, events: TraceEvent[]): void {
    if (events.length === 0) return;
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
    mkdirSync(this.root, { recursive: true });
    appendFileSync(path.join(this.root, `${sessionId}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  }

  read(sessionId: string, limit = 300): TraceEvent[] {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
    const file = path.join(this.root, `${sessionId}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').trim().split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEvent)
      .slice(-Math.max(1, Math.min(limit, 1000)));
  }
}
