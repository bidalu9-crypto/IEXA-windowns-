import { redactSecrets } from '../errors/IexaError';

export interface TraceEvent { at: number; name: string; data?: Record<string, unknown>; }
export interface TraceOptions { maxEvents?: number; maxBytes?: number; maxEventBytes?: number; }

/** Bounded retained history. Incremental consumers MUST use cursor()/since(), not snapshot indices. */
export class Trace {
  private readonly events = new Map<number, { event: TraceEvent; bytes: number }>();
  private sequence = 0;
  private bytes = 0;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;

  constructor(options: TraceOptions = {}) {
    this.maxEvents = options.maxEvents ?? 2000;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? Math.min(16 * 1024, this.maxBytes);
    for (const value of [this.maxEvents, this.maxBytes, this.maxEventBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Trace limits must be positive integers');
    }
    if (this.maxEventBytes < 128 || this.maxBytes < this.maxEventBytes) throw new RangeError('Trace requires 128 <= maxEventBytes <= maxBytes');
  }

  event(name: string, data?: Record<string, unknown>): void {
    let event: TraceEvent = { at: Date.now(), name: name.slice(0, 128) };
    try {
      if (data) event.data = JSON.parse(redactSecrets(JSON.stringify(data)));
      if (Buffer.byteLength(JSON.stringify(event)) > this.maxEventBytes) event = { at: event.at, name: 'trace_event_truncated', data: { truncated: true } };
    } catch { event = { at: event.at, name: 'trace_event_unserializable' }; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.set(this.sequence++, { event, bytes });
    this.bytes += bytes;
    while (this.events.size > this.maxEvents || this.bytes > this.maxBytes) {
      const oldest = this.events.keys().next().value!;
      this.bytes -= this.events.get(oldest)!.bytes;
      this.events.delete(oldest);
    }
  }

  /** Exclusive monotonic cursor, independent of eviction and wall-clock timestamps. */
  cursor(): number { return this.sequence; }
  /** Earliest retained cursor; a smaller requested cursor indicates dropped history. */
  oldestCursor(): number { return this.events.keys().next().value ?? this.sequence; }
  since(cursor: number): TraceEvent[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError('Invalid trace cursor');
    return [...this.events].filter(([index]) => index >= cursor).map(([, value]) => JSON.parse(JSON.stringify(value.event)) as TraceEvent);
  }
  /** Retained history only. Do not save .length as an incremental persistence cursor. */
  snapshot(): TraceEvent[] { return this.since(this.oldestCursor()); }
}
