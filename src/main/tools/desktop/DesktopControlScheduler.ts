export interface DesktopLease { owner: string; operationId: string; acquiredAt: number; signal: AbortSignal; }
interface Entry { owner: string; operationId: string; signal?: AbortSignal; run: (lease: DesktopLease) => Promise<unknown>; resolve: (value: any) => void; reject: (error: Error) => void; abort: () => void; }

/** One process-wide queue, shared by parent and child ToolRuntime instances.
 * Never release the lease until transport cancellation has settled. */
export class DesktopControlScheduler {
  private queue: Entry[] = [];
  private active?: DesktopLease;
  private activeController?: AbortController;
  private paused = false;
  pause(): void {
    this.paused = true;
    const reason = new Error("User takeover: desktop control paused by operator.");
    for (const entry of this.queue.splice(0)) { entry.signal?.removeEventListener("abort", entry.abort); entry.reject(reason); }
    this.activeController?.abort(reason);
  }
  resume(): void { this.paused = false; this.drain(); }
  constructor(private readonly leaseMs = 90_000) {}
  snapshot() { return { paused: this.paused, active: this.active && { owner: this.active.owner, operationId: this.active.operationId, acquiredAt: this.active.acquiredAt }, queued: this.queue.map(e => ({ owner: e.owner, operationId: e.operationId })) }; }
  run<T>(owner: string, operationId: string, signal: AbortSignal | undefined, run: (lease: DesktopLease) => Promise<T>): Promise<T> {
    if (this.paused) return Promise.reject(new Error('User takeover: desktop control paused by operator.'));
    if (signal?.aborted) return Promise.reject(new Error('Desktop action cancelled in queue.'));
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { owner, operationId, signal, run, resolve, reject, abort: () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal?.removeEventListener('abort', entry.abort);
        reject(new Error('Desktop action cancelled in queue.'));
      } };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry); this.drain();
    });
  }
  private drain(): void {
    if (this.active || this.paused) return;
    const entry = this.queue.shift(); if (!entry) return;
    entry.signal?.removeEventListener('abort', entry.abort);
    const controller = new AbortController(); this.activeController = controller;
    const abort = () => controller.abort(entry.signal?.reason);
    entry.signal?.addEventListener('abort', abort, { once: true });
    if (entry.signal?.aborted) abort();
    const lease = { owner: entry.owner, operationId: entry.operationId, acquiredAt: Date.now(), signal: controller.signal };
    this.active = lease;
    const timer = setTimeout(() => controller.abort(new Error('Desktop control lease expired.')), this.leaseMs);
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Desktop action cancelled before lease execution.');
      return entry.run(lease);
    }).then(entry.resolve, entry.reject).finally(() => {
      clearTimeout(timer); entry.signal?.removeEventListener('abort', abort);
      this.active = undefined; this.activeController = undefined; this.drain();
    });
  }
}
export const desktopControlScheduler = new DesktopControlScheduler();
