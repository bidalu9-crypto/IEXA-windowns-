import { redactSecrets } from '../errors/IexaError';

export interface TraceEvent { at: number; name: string; data?: Record<string, unknown>; }
export class Trace {
  private readonly events: TraceEvent[] = [];
  event(name: string, data?: Record<string, unknown>): void { this.events.push({ at: Date.now(), name, data: data ? JSON.parse(redactSecrets(JSON.stringify(data))) : undefined }); }
  snapshot(): TraceEvent[] { return [...this.events]; }
}
