import { randomUUID } from 'crypto';

export type ToolExecutionStatus = 'queued' | 'awaiting_approval' | 'running' | 'cancelling' |
  'completed' | 'failed' | 'denied' | 'cancelled' | 'timed_out';
export interface ToolLifecycleEvent {
  desktop?: import('../tools/desktop/DesktopControlSession').DesktopEvent;
  version: 1;
  runId: string;
  sequence: number;
  sessionId: string;
  id: string;
  name: string;
  status: ToolExecutionStatus;
  timestamp: number;
  startedAt?: number;
  durationMs?: number;
}
export const TERMINAL_TOOL_STATES: ReadonlySet<ToolExecutionStatus> = new Set(['completed', 'failed', 'denied', 'cancelled', 'timed_out']);
const transitions: Record<ToolExecutionStatus, readonly ToolExecutionStatus[]> = {
  queued: ['awaiting_approval', 'running', 'cancelling', 'failed', 'denied', 'cancelled'],
  awaiting_approval: ['running', 'cancelling', 'failed', 'denied', 'cancelled'],
  running: ['cancelling', 'completed', 'failed', 'cancelled', 'timed_out'],
  cancelling: ['cancelled', 'timed_out', 'failed'],
  completed: [], failed: [], denied: [], cancelled: [], timed_out: [],
};

/** One monotonic sequence per run; never carries tool arguments, secrets or output. */
export class ToolLifecycle {
  readonly runId = randomUUID();
  private sequence = 0;
  private readonly states = new Map<string, ToolLifecycleEvent>();
  transition(sessionId: string, id: string, name: string, status: ToolExecutionStatus): ToolLifecycleEvent {
    const key = JSON.stringify([sessionId, id]);
    const previous = this.states.get(key);
    if (previous && previous.name !== name) throw new Error('Tool ID belongs to another tool.');
    if (previous?.status === status) return { ...previous };
    if (previous ? !transitions[previous.status].includes(status) : status !== 'queued') {
      throw new Error(`Invalid tool transition: ${previous?.status || 'new'} -> ${status}`);
    }
    const timestamp = Date.now();
    const startedAt = previous?.startedAt ?? (status === 'running' ? timestamp : undefined);
    const event: ToolLifecycleEvent = { version: 1, runId: this.runId, sequence: ++this.sequence, sessionId, id, name, status, timestamp,
      startedAt, durationMs: TERMINAL_TOOL_STATES.has(status) && startedAt !== undefined ? Math.max(0, timestamp - startedAt) : undefined };
    this.states.set(key, event);
    return { ...event };
  }
  progress(sessionId: string, id: string, desktop: NonNullable<ToolLifecycleEvent['desktop']>): ToolLifecycleEvent {
    const key = JSON.stringify([sessionId, id]);
    const previous = this.states.get(key);
    if (!previous || !['running', 'cancelling'].includes(previous.status)) throw new Error('Desktop progress requires an active tool.');
    const event = { ...previous, desktop, sequence: ++this.sequence, timestamp: Date.now() };
    this.states.set(key, event); return { ...event };
  }
  snapshot(): ToolLifecycleEvent[] { return [...this.states.values()].map(event => ({ ...event })); }
}
