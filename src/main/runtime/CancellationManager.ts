export class CancellationManager {
  private controllers = new Map<string, AbortController>();
  begin(sessionId: string): AbortSignal {
    this.cancel(sessionId);
    const controller = new AbortController(); this.controllers.set(sessionId, controller);
    return controller.signal;
  }
  signal(sessionId: string): AbortSignal | undefined { return this.controllers.get(sessionId)?.signal; }
  cancel(sessionId: string): void { this.controllers.get(sessionId)?.abort(); this.controllers.delete(sessionId); }
  finish(sessionId: string): void { this.controllers.delete(sessionId); }
}
