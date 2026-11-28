"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeIsolatedWorkspace = void 0;
exports.controlNativeIsolatedWorkspaces = controlNativeIsolatedWorkspaces;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const net = __importStar(require("net"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const stripBom_1 = require("../../persistence/stripBom");
const DesktopHelperPath_1 = require("./DesktopHelperPath");
const liveWorkspaces = new Set();
async function controlNativeIsolatedWorkspaces(operation, signal) {
    return Promise.all([...liveWorkspaces].map(workspace => workspace.operatorControl(operation, signal)));
}
/** Native desktop UI isolation only. Existing user windows, filesystem/network and
 * account credentials are not moved or sandboxed. Never switch the input desktop. */
class NativeIsolatedWorkspace {
    executableOverride;
    child;
    pending;
    ready;
    closed = false;
    failed = false;
    directory;
    // The explicit executable override is internal; the legacy root is not a project search path.
    constructor(_appRoot = (0, DesktopHelperPath_1.desktopApplicationRoot)(), executableOverride) {
        this.executableOverride = executableOverride;
    }
    async ensureStarted(signal) {
        if (signal?.aborted)
            throw new Error('Isolated workspace creation cancelled.');
        if (this.closed || this.failed)
            throw new Error('Isolated workspace closed or lost; do not replay prior actions. Start a new explicit workspace.');
        if (this.ready) {
            if (this.child?.exitCode !== null || this.child?.signalCode !== null)
                throw new Error('Isolated worker host exited; previous app state may be lost.');
            return this.ready;
        }
        this.pending ??= this.start(signal).catch(error => {
            const cancelled = signal?.aborted === true;
            this.cleanupAttempt();
            if (!cancelled)
                this.failed = true;
            throw error;
        }).finally(() => { this.pending = undefined; });
        return this.pending;
    }
    executable() {
        const exe = this.executableOverride || (0, DesktopHelperPath_1.resolveDesktopHelper)()?.executable;
        try {
            if (exe && fs.statSync(exe).isFile()) {
                const capability = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(path.join(path.dirname(exe), 'isolated-desktop-capability.json'), 'utf8')));
                const hash = (0, crypto_1.createHash)('sha256').update(fs.readFileSync(exe.replace(/\.exe$/i, '.dll'))).digest('hex');
                if (capability.version === 1 && hash === String(capability.sha256).toLowerCase())
                    return exe;
            }
        }
        catch { /* An old helper must not be launched with unrecognized isolation arguments. */ }
        throw new Error('A rebuilt native isolated-desktop helper and matching capability hash are required; no foreground fallback.');
    }
    async start(signal) {
        if (process.platform !== 'win32')
            throw new Error('Native isolated workspace requires Windows.');
        const exe = this.executable();
        const port = await new Promise((resolve, reject) => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(error => error ? reject(error) : resolve(p)); });
        });
        if (signal?.aborted || this.closed)
            throw new Error('Isolated workspace creation cancelled.');
        this.directory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'iExA-WIN', 'desktop-workspaces', (0, crypto_1.randomUUID)());
        fs.mkdirSync(this.directory, { recursive: true });
        fs.writeFileSync(path.join(this.directory, 'request.json'), JSON.stringify({ Port: port, ParentPid: process.pid }), { mode: 0o600 });
        const fd = fs.openSync(path.join(this.directory, 'host.log'), 'a');
        try {
            this.child = (0, child_process_1.spawn)(exe, ['--isolated-host', this.directory], { windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, IEXA_ISOLATED_DESKTOP: '' } });
        }
        finally {
            fs.closeSync(fd);
        }
        let launchError;
        this.child.on('error', error => { launchError = error; });
        this.child.unref();
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (signal?.aborted || this.closed)
                throw new Error('Isolated workspace creation cancelled.');
            if (launchError)
                throw launchError;
            const errorFile = path.join(this.directory, 'error.json');
            if (fs.existsSync(errorFile))
                throw new Error(`Isolated host failed: ${fs.readFileSync(errorFile, 'utf8')}`);
            if (this.child.exitCode !== null || this.child.signalCode !== null)
                throw new Error(`Isolated host exited before readiness. See ${this.directory}`);
            const readyFile = path.join(this.directory, 'ready.json');
            if (fs.existsSync(readyFile)) {
                let info;
                try {
                    info = JSON.parse((0, stripBom_1.stripBom)(fs.readFileSync(readyFile, 'utf8')));
                }
                catch { /* Partial readiness file, no action dispatched. */ }
                if (info) {
                    if (info.hostPid !== this.child.pid || info.port !== port || !info.jobBound || !/^iExA-Owned-[a-f0-9]{32}$/.test(info.desktopName))
                        throw new Error('Isolated host identity mismatch.');
                    try {
                        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
                        const health = await response.json();
                        if (response.ok && health.pid === info.pid && health.product === 'IEXA Desktop Agent' && health.protocolVersion === 6 && health.isolatedDesktop?.verified === true && health.isolatedDesktop.desktopName === info.desktopName) {
                            this.ready = info;
                            liveWorkspaces.add(this);
                            return info;
                        }
                    }
                    catch { /* Only readiness polling retries, never app actions. */ }
                }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Isolated worker did not become ready. See ${this.directory}`);
    }
    cleanupAttempt() {
        liveWorkspaces.delete(this);
        const directory = this.directory;
        const child = this.child;
        try {
            if (directory)
                fs.writeFileSync(path.join(directory, 'stop'), '');
        }
        catch { }
        if (child && child.exitCode === null && child.signalCode === null)
            child.kill();
        this.child = undefined;
        this.ready = undefined;
        this.directory = undefined;
        if (directory) {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            }
            catch { }
        }
    }
    async operatorControl(operation, signal) {
        const info = this.ready;
        if (!info || this.closed)
            return { ok: true, closed: true };
        try {
            const endpoint = `http://127.0.0.1:${info.port}`;
            const response = await fetch(`${endpoint}/health`, { signal: signal || AbortSignal.timeout(1200) });
            const health = await response.json();
            if (!response.ok || health.pid !== info.pid || health.isolatedDesktop?.desktopName !== info.desktopName)
                throw new Error('Isolated worker identity changed.');
            const result = await fetch(`${endpoint}/${operation}`, { method: 'POST', signal: signal || AbortSignal.timeout(1200) });
            const body = await result.json();
            if (!result.ok || body.ok !== true)
                throw new Error('Native operator control failed.');
            return { ok: true, desktopName: info.desktopName, operation };
        }
        catch (error) {
            return { ok: false, desktopName: info.desktopName, error: error.message };
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        liveWorkspaces.delete(this);
        if (this.directory)
            fs.writeFileSync(path.join(this.directory, 'stop'), '');
        const child = this.child;
        if (child && child.exitCode === null && child.signalCode === null) {
            const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null)
                child.kill(); }, 5000);
            timer.unref();
            child.once('exit', () => clearTimeout(timer));
        }
    }
    diagnostics() { return { directory: this.directory, ready: this.ready, closed: this.closed, failed: this.failed }; }
}
exports.NativeIsolatedWorkspace = NativeIsolatedWorkspace;
//# sourceMappingURL=NativeIsolatedWorkspace.js.map