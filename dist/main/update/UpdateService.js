"use strict";
// =============================================================================
// iExA PC - Auto-update service
//
// Thin, testable wrapper around electron-updater. The adapter is injected so the
// state machine can be exercised without Electron, and the service stays inert
// outside a packaged build (no app-update.yml in development).
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateService = void 0;
const DEFAULT_DELAY_MS = 15_000;
class UpdateService {
    options;
    state = { status: 'idle' };
    scheduled;
    disposed = false;
    constructor(options) {
        this.options = options;
        if (!options.enabled) {
            this.state = { status: 'disabled' };
            return;
        }
        options.adapter.autoDownload = false;
        options.adapter.autoInstallOnAppQuit = true;
        options.adapter.on('checking-for-update', () => this.publish({ status: 'checking' }));
        options.adapter.on('update-available', (info) => this.publish({ status: 'available', version: info?.version }));
        options.adapter.on('update-not-available', (info) => this.publish({ status: 'not-available', version: info?.version }));
        options.adapter.on('error', (error) => this.publish({ status: 'error', message: String(error?.message || error) }));
        options.adapter.on('download-progress', (progress) => this.publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0))) }));
        options.adapter.on('update-downloaded', (info) => this.publish({ status: 'downloaded', version: info?.version }));
    }
    publish(next) {
        if (this.disposed)
            return;
        const event = { ...next, at: Date.now() };
        this.state = { ...this.state, ...event };
        if (event.status !== 'downloading')
            this.state.checkedAt = event.at;
        try {
            this.options.onStatus?.(event);
        }
        catch { /* observers cannot break the updater */ }
    }
    /** Schedule the first check a short while after startup. */
    start() {
        if (!this.options.enabled || this.disposed)
            return;
        const schedule = this.options.schedule || ((callback, delay) => setTimeout(callback, delay));
        this.scheduled = schedule(() => { void this.check(true); }, this.options.initialDelayMs ?? DEFAULT_DELAY_MS);
    }
    async check(silent = false) {
        if (!this.options.enabled) {
            this.publish({ status: 'disabled' });
            return;
        }
        try {
            await this.options.adapter.checkForUpdates();
        }
        catch (error) {
            this.publish({ status: 'error', message: error?.message || String(error) });
            if (!silent)
                throw error;
        }
    }
    async download() {
        if (!this.options.enabled || this.state.status === 'downloaded')
            return;
        try {
            await this.options.adapter.downloadUpdate();
        }
        catch (error) {
            this.publish({ status: 'error', message: error?.message || String(error) });
            throw error;
        }
    }
    install() {
        if (!this.options.enabled || this.state.status !== 'downloaded')
            return;
        try {
            this.options.adapter.quitAndInstall();
        }
        catch (error) {
            this.publish({ status: 'error', message: error?.message || String(error) });
        }
    }
    getState() {
        return { ...this.state };
    }
    dispose() {
        this.disposed = true;
        if (this.scheduled !== undefined) {
            try {
                (this.options.cancelSchedule || clearTimeout)(this.scheduled);
            }
            catch { /* already fired */ }
            this.scheduled = undefined;
        }
    }
}
exports.UpdateService = UpdateService;
//# sourceMappingURL=UpdateService.js.map