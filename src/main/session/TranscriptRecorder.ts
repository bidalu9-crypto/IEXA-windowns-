import { randomUUID } from 'crypto';

export type TranscriptItem = {
  id: string; sequence: number; timestamp: number;
} & ({ type: 'text' | 'thinking'; start: number; end: number; durationMs?: number }
  | { type: 'tool'; callId: string; name: string });
export interface TranscriptEvents {
  version: 1; turnId: string; revision: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  valid: boolean; invalidReason?: string; items: TranscriptItem[];
}

/** Ordered semantic events. Content is referenced by UTF-16 ranges into the
 * existing message fields, not duplicated per token. Adjacent deltas coalesce,
 * but no event ever crosses a text/thinking/tool boundary. */
export class TranscriptRecorder {
  readonly turnId = randomUUID();
  private text = '';
  private thinking = '';
  private revision = 0;
  private readonly items: TranscriptItem[] = [];
  private readonly toolIds = new Set<string>();
  private status: TranscriptEvents['status'] = 'running';
  private invalidReason?: string;
  constructor(private readonly clock: () => number = Date.now, private readonly maxItems = 8192) {}
  private add(item: Omit<Extract<TranscriptItem, { type: 'tool' }>, 'id' | 'sequence' | 'timestamp'> | { type: 'text' | 'thinking'; start: number; end: number }): void {
    if (this.items.length >= this.maxItems) { this.invalidReason = 'event_limit'; return; }
    this.items.push({ ...item, sequence: this.items.length + 1, id: `${this.turnId}:${this.items.length + 1}`, timestamp: this.clock() } as TranscriptItem);
  }
  private closeThinking(): void {
    const last = this.items.at(-1);
    if (last?.type === 'thinking' && last.durationMs === undefined) last.durationMs = Math.max(0, this.clock() - last.timestamp);
  }
  recordText(fullText: string): void {
    if (this.status !== 'running') return;
    const value = String(fullText || '');
    if (value === this.text) return;
    this.revision++;
    if (!value.startsWith(this.text)) this.invalidReason = 'text_replaced';
    this.closeThinking();
    const previous = this.text.length; this.text = value;
    const last = this.items.at(-1);
    if (last?.type === 'text') last.end = value.length;
    else if (value.length > previous) this.add({ type: 'text', start: previous, end: value.length });
  }
  recordThinking(delta: string): void {
    if (this.status !== 'running' || !delta) return;
    this.revision++;
    const start = this.thinking.length; this.thinking += delta;
    const last = this.items.at(-1);
    if (last?.type === 'thinking') last.end = this.thinking.length;
    else this.add({ type: 'thinking', start, end: this.thinking.length });
  }
  recordTool(callId: string, name: string): void {
    if (this.status !== 'running' || this.toolIds.has(callId)) return;
    this.closeThinking(); this.revision++; this.toolIds.add(callId);
    this.add({ type: 'tool', callId, name });
  }
  finish(status: Exclude<TranscriptEvents['status'], 'running'>): void {
    if (this.status !== 'running') return;
    this.closeThinking(); this.revision++; this.status = status;
  }
  snapshot(): TranscriptEvents {
    return { version: 1, turnId: this.turnId, revision: this.revision, status: this.status, valid: !this.invalidReason,
      ...(this.invalidReason ? { invalidReason: this.invalidReason } : {}), items: this.items.map(item => ({ ...item })) };
  }
}
