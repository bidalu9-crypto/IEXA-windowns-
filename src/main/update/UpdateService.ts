// =============================================================================
// iExA PC - Auto-update service
//
// Thin, testable wrapper around electron-updater. The adapter is injected so the
// state machine can be exercised without Electron, and the service stays inert
// outside a packaged build (no app-update.yml in development).
// =============================================================================

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'disabled';

export interface UpdateEvent {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  message?: string;
  at: number;
}

export interface UpdateAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateServiceOptions {
  adapter: UpdateAdapter;
  /** False in development or when the build has no publish configuration. */
  enabled: boolean;
  currentVersion: string;
  onStatus?: (event: UpdateEvent) => void;
  /** Injectable timers keep tests deterministic. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  initialDelayMs?: number;
}

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: number;
}

const DEFAULT_DELAY_MS = 15_000;

export class UpdateService {
  private state: UpdateState = { status: 'idle' };
  private scheduled: unknown;
  private disposed = false;

  constructor(private readonly options: UpdateServiceOptions) {
    if (!options.enabled) {
      this.state = { status: 'disabled' };
      return;
    }
    options.adapter.autoDownload = false;
    options.adapter.autoInstallOnAppQuit = true;
    options.adapter.on('checking-for-update', () => this.publish({ status: 'checking' }));
    options.adapter.on('update-available', (info: { version?: string }) =>
      this.publish({ status: 'available', version: info?.version }));
    options.adapter.on('update-not-available', (info: { version?: string }) =>
      this.publish({ status: 'not-available', version: info?.version }));
    options.adapter.on('error', (error: Error | string) =>
      this.publish({ status: 'error', message: String((error as Error)?.message || error) }));
    options.adapter.on('download-progress', (progress: { percent?: number }) =>
      this.publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0))) }));
    options.adapter.on('update-downloaded', (info: { version?: string }) =>
      this.publish({ status: 'downloaded', version: info?.version }));
  }

  private publish(next: Omit<UpdateEvent, 'at'> & { at?: number }): void {
    if (this.disposed) return;
    const event: UpdateEvent = { ...next, at: Date.now() };
    this.state = { ...this.state, ...event };
    if (event.status !== 'downloading') this.state.checkedAt = event.at;
    try { this.options.onStatus?.(event); } catch { /* observers cannot break the updater */ }
  }

  /** Schedule the first check a short while after startup. */
  start(): void {
    if (!this.options.enabled || this.disposed) return;
    const schedule = this.options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.scheduled = schedule(() => { void this.check(true); }, this.options.initialDelayMs ?? DEFAULT_DELAY_MS);
  }

  async check(silent = false): Promise<void> {
    if (!this.options.enabled) { this.publish({ status: 'disabled' }); return; }
    try {
      await this.options.adapter.checkForUpdates();
    } catch (error) {
      this.publish({ status: 'error', message: (error as Error)?.message || String(error) });
      if (!silent) throw error;
    }
  }

  async download(): Promise<void> {
    if (!this.options.enabled || this.state.status === 'downloaded') return;
    try {
      await this.options.adapter.downloadUpdate();
    } catch (error) {
      this.publish({ status: 'error', message: (error as Error)?.message || String(error) });
      throw error;
    }
  }

  install(): void {
    if (!this.options.enabled || this.state.status !== 'downloaded') return;
    try { this.options.adapter.quitAndInstall(); }
    catch (error) { this.publish({ status: 'error', message: (error as Error)?.message || String(error) }); }
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled !== undefined) {
      try { (this.options.cancelSchedule || clearTimeout)(this.scheduled as never); } catch { /* already fired */ }
      this.scheduled = undefined;
    }
  }
}
