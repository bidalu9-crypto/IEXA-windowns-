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
exports.DesktopAgent = void 0;
exports.formatDesktopResult = formatDesktopResult;
const child_process_1 = require("child_process");
const DesktopHelperLifetime_1 = require("./desktop/DesktopHelperLifetime");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const DesktopControlSession_1 = require("./desktop/DesktopControlSession");
const DesktopBackgroundAdapter_1 = require("./desktop/DesktopBackgroundAdapter");
const ChromiumCdpAdapter_1 = require("./desktop/ChromiumCdpAdapter");
const NativeIsolatedWorkspace_1 = require("./desktop/NativeIsolatedWorkspace");
const DesktopHelperPath_1 = require("./desktop/DesktopHelperPath");
const DesktopLiveState_1 = require("./desktop/DesktopLiveState");
const ENDPOINT = 'http://127.0.0.1:17891';
const PROTOCOL_VERSION = 6;
const nativeNeedsIdleCheck = new Set();
const nativeStarts = new Map();
class DesktopAgent {
    captureFramesByDefault;
    endpoint;
    isolation;
    healthyUntil = 0;
    nativeInstanceNonce;
    cdpAdapters = new Map();
    recoveryNoticesDelivered = new Set();
    control;
    appRoot = (0, DesktopHelperPath_1.desktopApplicationRoot)();
    isolatedWorkspace;
    isolatedTransport;
    // Retain the positional constructor API; project roots no longer locate binaries.
    constructor(_appRoot = (0, DesktopHelperPath_1.desktopApplicationRoot)(), captureFramesByDefault = false, journalDir, endpoint = ENDPOINT, isolation) {
        this.captureFramesByDefault = captureFramesByDefault;
        this.endpoint = endpoint;
        this.isolation = isolation;
        const url = new URL(endpoint);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
            throw new Error('Desktop endpoint must be a loopback HTTP origin.');
        this.control = new DesktopControlSession_1.DesktopControlSession((args, signal) => this.executeNative(args, signal), undefined, journalDir);
    }
    async execute(args, signal, context = { owner: 'local' }) {
        const result = await this.control.execute(args, signal, context);
        (0, DesktopLiveState_1.recordDesktopControlResult)(result, context.owner);
        if (result.success && args.detail !== 'raw') {
            try {
                result.output = formatDesktopResult(JSON.parse(result.output));
            }
            catch { }
        }
        const trace = result.metadata?.desktop;
        const recovery = trace?.recovered;
        if (recovery && args.detail !== 'raw' && !this.recoveryNoticesDelivered.has(context.owner) && (recovery.unresolvedOperationCount || recovery.journalIntegrity === 'partial')) {
            this.recoveryNoticesDelivered.add(context.owner);
            const unresolved = recovery.unresolvedOperations || [];
            const displayed = unresolved.slice(-8);
            const safe = (value, max) => String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, max);
            const operations = displayed.map((op) => `${safe(op.operationId, 80)} (action=${safe(op.action, 32) || 'unknown'}, phase=${safe(op.phase, 24)}, dispatched=${Number(op.dispatchedActions) || 0}, completedSteps=${Number(op.completedSteps) || 0})`).join('; ');
            const omitted = (recovery.unresolvedOperationCount || 0) > displayed.length ? `另有 ${recovery.unresolvedOperationCount - displayed.length} 项未列出。` : '';
            // Place this before the verbose observation so model-context compaction retains the warning.
            result.output = `恢复警告：${recovery.unresolvedOperationCount || 0} 项历史操作可能已执行但结果未确认。先观察并核对业务状态，不要重复提交。${omitted}${recovery.journalIntegrity === 'partial' ? '日志存在不完整记录，缺失记录不等于未执行。' : ''}\n${operations}\n` + result.output;
        }
        if (trace && args.detail !== 'raw') {
            const control = trace.control;
            if (control)
                result.output += `\n实际操控：${control.mode === 'foreground' ? '前台' : '后台'}；后端=${control.backend}；能力=${control.capability}；物理输入=${control.physicalInput ? '显式启用' : '禁用'}；前台回退=禁用。${control.providerMayChangeFocus ? ' 应用控件/页面事件可能改变焦点；此路径不代表独立桌面隔离。' : ''}`;
            if (args.action === 'batch' || !result.success)
                result.output += `\n派发记录：已派发=${trace.dispatchedActions ?? '未知'}；收到动作回执=${trace.acknowledgedActions ?? '未知'}；完成步骤=${trace.completedSteps ?? '未知'}。${trace.noAction === true ? '本次未派发动作；先修正参数或观察条件。' : result.success ? '动作回执已返回；仍须观察核对业务结果，勿因证据不足重放整批。' : '可能已有操作生效；先观察并核对实际结果，不重放整批或重复输入。'}`;
            result.output += `\n控制闭环：${trace.events.map((event) => event.phase).join(' → ')}\n验证：${trace.verified ? '指定界面文字已核对' : '未证明业务目标完成'}；恢复策略：重新观察，不重放输入。`;
        }
        return result;
    }
    resetControl() { this.recoveryNoticesDelivered.clear(); this.control.reset(); }
    close() { this.isolatedTransport?.close(); this.isolatedWorkspace?.close(); this.recoveryNoticesDelivered.clear(); this.control.reset(); for (const adapter of this.cdpAdapters.values())
        adapter.close(); this.cdpAdapters.clear(); }
    async healthy() {
        // Idle shutdown invalidates native observation state; do not trust cached liveness.
        try {
            const r = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(600) });
            if (!r.ok)
                return false;
            const health = await r.json();
            const valid = health.product === 'IEXA Desktop Agent'
                && health.protocolVersion === PROTOCOL_VERSION
                && health.lifecycle?.version === 1
                && health.automationEngine === 'FlaUI 5'
                && typeof health.instanceNonce === 'string'
                && health.instanceNonce.length >= 16;
            const isolationValid = !this.isolation?.expectedDesktopName || health.isolatedDesktop?.verified === true && health.isolatedDesktop?.desktopName === this.isolation.expectedDesktopName;
            if (valid && isolationValid) {
                this.healthyUntil = Date.now() + 5000;
                this.nativeInstanceNonce = String(health.instanceNonce);
            }
            return valid && isolationValid;
        }
        catch {
            return false;
        }
    }
    async ensureStarted(signal) {
        (0, DesktopHelperLifetime_1.assertDesktopHelpersOpen)();
        if (signal?.aborted)
            throw new Error('Desktop action cancelled.');
        if (await this.healthy())
            return;
        if (this.isolation?.expectedDesktopName)
            throw new Error('Isolated native worker unavailable or user takeover detected; no foreground fallback.');
        let pending = nativeStarts.get(this.endpoint);
        if (!pending) {
            pending = this.start();
            nativeStarts.set(this.endpoint, pending);
        }
        try {
            await pending;
        }
        finally {
            if (nativeStarts.get(this.endpoint) === pending)
                nativeStarts.delete(this.endpoint);
        }
        // A different DesktopAgent instance may have owned the shared startup;
        // every caller must obtain the resulting helper identity for its snapshot.
        if (!await this.healthy())
            throw new Error('Desktop helper did not provide a valid instance identity after startup.');
    }
    async start() {
        await this.stopIncompatibleHelper();
        const helper = (0, DesktopHelperPath_1.resolveDesktopHelper)();
        const exe = helper?.executable, dll = helper?.dll;
        if (!exe && !dll)
            throw new Error('Desktop agent is missing. Run dotnet publish desktop-agent/Iexa.DesktopAgent.csproj.');
        const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'IEXA-WIN', 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'desktop-agent.log');
        const previousLogPath = `${logPath}.1`;
        try {
            if (fs.statSync(logPath).size >= 2 * 1024 * 1024) {
                fs.rmSync(previousLogPath, { force: true });
                fs.renameSync(logPath, previousLogPath);
            }
        }
        catch { }
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] starting ${exe || dll}\n`);
        const logFd = fs.openSync(logPath, 'a');
        let child;
        try {
            (0, DesktopHelperLifetime_1.assertDesktopHelpersOpen)();
            child = (0, child_process_1.spawn)(exe || 'dotnet', exe ? [] : [dll], { stdio: ['pipe', logFd, logFd], windowsHide: true, env: { ...process.env, IEXA_DESKTOP_PORT: new URL(this.endpoint).port || '80', IEXA_DESKTOP_OWNER_PIPE: 'stdin-v1' } });
            (0, DesktopHelperLifetime_1.trackDesktopHelper)(child);
        }
        finally {
            fs.closeSync(logFd);
        }
        child.on('error', () => { this.healthyUntil = 0; });
        for (let i = 0; i < 40; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (await this.healthy())
                return;
            if (child.exitCode !== null || child.signalCode !== null)
                break;
        }
        child.stdin?.destroy();
        throw new Error(`Desktop agent did not become ready. See ${logPath}`);
    }
    async stopIncompatibleHelper() {
        try {
            const response = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(600) });
            if (!response.ok)
                return;
            const health = await response.json();
            if (health.product !== 'IEXA Desktop Agent' || health.protocolVersion === PROTOCOL_VERSION && health.lifecycle?.version === 1)
                return;
            try {
                await fetch(`${this.endpoint}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(800) });
            }
            catch { }
            for (let index = 0; index < 15; index++) {
                await new Promise((resolve) => setTimeout(resolve, 80));
                try {
                    await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(150) });
                }
                catch {
                    return;
                }
            }
            const pid = Number(health.pid);
            if (Number.isInteger(pid) && pid > 0) {
                try {
                    process.kill(pid);
                }
                catch { }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
        catch { }
    }
    async awaitNativeIdle() {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(600) });
                const state = await response.json();
                if (response.ok && state.product === 'IEXA Desktop Agent' && state.protocolVersion === PROTOCOL_VERSION && state.action === 'idle') {
                    nativeNeedsIdleCheck.delete(this.endpoint);
                    return;
                }
            }
            catch { }
            await new Promise(resolve => setTimeout(resolve, 80));
        }
        throw new Error('Previous desktop action has not settled; control remains quarantined.');
    }
    async executeNative(args, signal) {
        if (args.backend === 'native-isolated') {
            try {
                if (args.cdpEndpoint || args.cdpTargetId)
                    throw new Error('Isolated native workspace cannot use a Chromium endpoint.');
                this.isolatedWorkspace ??= new NativeIsolatedWorkspace_1.NativeIsolatedWorkspace(this.appRoot, this.isolation?.executable);
                const info = await this.isolatedWorkspace.ensureStarted(signal);
                this.isolatedTransport ??= new DesktopAgent(this.appRoot, this.captureFramesByDefault, undefined, `http://127.0.0.1:${info.port}`, { expectedDesktopName: info.desktopName });
                const result = await this.isolatedTransport.executeNative({ ...args, backend: 'native', background: true }, signal);
                return { ...result, metadata: { ...result.metadata, backend: 'native-isolated', isolatedDesktop: info.desktopName } };
            }
            catch (error) {
                return { success: false, output: error.message, cancelled: signal?.aborted || undefined };
            }
        }
        if (args.backend && !['native', 'chromium-cdp'].includes(String(args.backend)))
            return { success: false, output: 'Unknown desktop backend; no implicit native fallback.' };
        const cdpEndpoint = typeof args.cdpEndpoint === 'string' ? args.cdpEndpoint : '';
        if (cdpEndpoint || args.backend === 'chromium-cdp') {
            if (!cdpEndpoint)
                return { output: 'Chromium CDP backend requires cdpEndpoint.', success: false };
            let adapter = this.cdpAdapters.get(cdpEndpoint);
            if (!adapter) {
                adapter = new ChromiumCdpAdapter_1.ChromiumCdpAdapter(cdpEndpoint);
                this.cdpAdapters.set(cdpEndpoint, adapter);
            }
            if (signal?.aborted)
                return { output: 'Desktop action cancelled.', success: false, cancelled: true };
            const result = await adapter.execute(args, signal);
            const cdpTargetId = String(result.metadata?.cdpTargetId || args.cdpTargetId || '');
            (0, DesktopLiveState_1.recordDesktopTransportPreview)(result, { backend: 'chromium-cdp', endpoint: cdpEndpoint, targetId: cdpTargetId });
            const attachObservationFrame = args.captureFrame === true || (args.captureFrame !== false && this.captureFramesByDefault);
            if (args.action === 'observe' && !attachObservationFrame) {
                delete result.imageData;
                delete result.imageMimeType;
            }
            return { ...result, metadata: { ...result.metadata, backend: 'chromium-cdp', cdpEndpoint, cdpTargetId } };
        }
        const started = Date.now();
        const controller = new AbortController();
        let dispatched = false;
        let cancellation;
        const abortParent = () => {
            controller.abort();
            // HttpListener actions are serialized in the native helper. Notify it
            // explicitly so a long observe/wait/type action stops instead of holding
            // the gate after the model turn has been cancelled.
            if (dispatched)
                nativeNeedsIdleCheck.add(this.endpoint);
            if (dispatched && !cancellation)
                cancellation = fetch(`${this.endpoint}/cancel`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => { });
        };
        if (signal) {
            if (signal.aborted)
                abortParent();
            else
                signal.addEventListener('abort', abortParent, { once: true });
        }
        const action = String(args.action || 'observe');
        const requestedTimeout = Number(args.timeoutMs || 0);
        const requestedWait = Number(args.waitForWindowMs || 0);
        // A launch may legitimately wait `waitForWindowMs` for a window (15s by
        // default, 60s at most). Timing the request out on the generic 10s budget
        // reported "timed out" for apps that had in fact started.
        const actionTimeout = action === 'observe'
            ? Math.max(8000, requestedTimeout || 15000)
            : action === 'launch'
                ? Math.max(20000, requestedTimeout || 0, (requestedWait || 15000) + 10000)
                : Math.max(5000, requestedTimeout || 10000);
        const timeout = setTimeout(abortParent, actionTimeout);
        try {
            const adapter = DesktopBackgroundAdapter_1.desktopAdapterRegistry.resolve({ app: String(args.app || ''), process: String(args.process || ''), windowTitle: String(args.window || ''), handle: Number(args.handle || 0) || undefined, pid: Number(args.pid || 0) || undefined });
            if (this.isolation?.expectedDesktopName && action === 'read_focused')
                throw new Error('read_focused queries the current input desktop and is unavailable in native-isolated; use observe on the bound isolated window.');
            if (this.isolation?.expectedDesktopName && !['list_windows', 'launch', 'observe', 'bind_window', 'session_state', 'find_element', 'click_element', 'type_element', 'frame', 'wait', 'wait_change'].includes(action))
                throw new Error('Isolated workspace permits bound-window semantic operations only.');
            if (args.background === true && !(this.isolation?.expectedDesktopName && ['launch', 'wait', 'wait_change'].includes(action))) {
                const preflight = adapter.preflight?.({ app: String(args.app || ''), process: String(args.process || ''), windowTitle: String(args.window || '') }, action);
                if (preflight && !preflight.allowed)
                    throw new Error(`Background action rejected by ${adapter.id}: ${preflight.reason || 'capability unavailable'}`);
            }
            await this.ensureStarted(controller.signal);
            if (args.expectedNativeInstanceNonce !== undefined && args.expectedNativeInstanceNonce !== this.nativeInstanceNonce)
                return { success: false, output: 'Desktop helper restarted before input dispatch. Fresh observe is required; the previous input was not sent.',
                    metadata: { nativeInstanceNonce: this.nativeInstanceNonce, noInputDispatched: true, helperRestarted: true } };
            if (nativeNeedsIdleCheck.has(this.endpoint))
                await this.awaitNativeIdle();
            if (action === 'frame') {
                const frame = await fetch(`${this.endpoint}/frame?full=0&observationToken=${encodeURIComponent(String(args.observationToken || ""))}`, { signal: controller.signal });
                if (!frame.ok)
                    throw new Error(`Desktop frame capture failed (${frame.status}).`);
                const bytes = Buffer.from(await frame.arrayBuffer());
                return {
                    output: JSON.stringify({ ok: true, action, bytes: bytes.length, mimeType: 'image/png' }),
                    success: true,
                    durationMs: Date.now() - started,
                    imageData: bytes,
                    imageMimeType: 'image/png',
                    metadata: { endpoint: this.endpoint, action },
                };
            }
            const payload = { ...args, action };
            delete payload.tool_title;
            delete payload.expectedNativeInstanceNonce;
            if (controller.signal.aborted)
                throw new Error('Desktop action cancelled before dispatch.');
            dispatched = true;
            const response = await fetch(`${this.endpoint}/execute`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            const body = await response.text();
            let parsed = body;
            try {
                parsed = JSON.parse(body);
            }
            catch { }
            const result = {
                output: typeof parsed === 'string' ? parsed : args.detail === 'raw' ? JSON.stringify(parsed) : formatDesktopResult(parsed),
                success: response.ok && parsed?.ok !== false && parsed?.data?.found !== false,
                durationMs: Date.now() - started,
                metadata: { endpoint: this.endpoint, action, nativeInstanceNonce: this.nativeInstanceNonce, backgroundAdapter: adapter.id, backgroundCapabilities: [...adapter.capabilities] },
            };
            const captureFrame = args.captureFrame === true || (args.captureFrame !== false && this.captureFramesByDefault);
            if (response.ok && action === 'observe' && captureFrame) {
                const token = parsed?.data?.session?.observationToken;
                if (!token)
                    throw new Error('Observation did not return a frame token.');
                const frame = await fetch(`${this.endpoint}/frame?full=0&observationToken=${encodeURIComponent(String(token))}`, { signal: controller.signal });
                if (!frame.ok || frame.headers.get('x-iexa-observation-token') !== token)
                    throw new Error('Observation frame is stale or from an incompatible helper; observe again.');
                result.imageData = Buffer.from(await frame.arrayBuffer());
                result.imageMimeType = 'image/png';
            }
            return result;
        }
        catch (error) {
            this.healthyUntil = 0;
            const message = controller.signal.aborted
                ? (signal?.aborted ? 'Desktop action cancelled.' : `Desktop action timed out after ${actionTimeout}ms.`)
                : error.message;
            return { output: message, success: false, timedOut: !signal?.aborted && controller.signal.aborted, durationMs: Date.now() - started };
        }
        finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abortParent);
            // Await the cancellation POST before another owner can acquire the queue.
            if (cancellation) {
                await cancellation;
                try {
                    await this.awaitNativeIdle();
                }
                catch { /* Quarantine persists until next idle handshake. */ }
            }
        }
    }
}
exports.DesktopAgent = DesktopAgent;
function formatDesktopResult(value) {
    if (!value || typeof value !== 'object')
        return String(value);
    if (!value.ok)
        return `桌面操作失败：${value.error || 'Unknown error'}`;
    const data = value.data || {};
    const windowState = (window) => {
        const state = Object.fromEntries(['isVisible', 'cloakedMask'].filter(key => window[key] !== undefined).map(key => [key, window[key]]));
        return Object.keys(state).length ? ` | windowState=${JSON.stringify(state)}` : '';
    };
    const lines = [`${value.action} · ${value.elapsedMs ?? 0} ms · ${data.found === false ? '未找到目标' : '已执行'}`];
    if (data.foreground)
        lines.push(`窗口：${data.foreground.title} (${data.foreground.process}) handle=${data.foreground.handle}${windowState(data.foreground)}`);
    if (data.window)
        lines.push(`目标：${data.window.title} (${data.window.process}) pid=${data.window.pid} handle=${data.window.handle}`);
    if (data.session)
        lines.push(`observationToken=${data.session.observationToken || ''}`);
    if (data.frame)
        lines.push(`画面：${data.frame.width}×${data.frame.height}，capturedAt=${data.frame.capturedAt}，hash=${data.frame.hash}，trust=${data.frame.trust || 'unknown'}`);
    if (data.frame?.diagnostic)
        lines.push(`截图诊断：${String(data.frame.diagnostic).slice(0, 1200)}`);
    if (data.frame?.trust === 'background-unverified')
        lines.push('后台画面未验证；不要把空白图当作软件状态，不要通过激活窗口或重复输入弥补截图失败。');
    if (data.relatedWindows?.length)
        lines.push('关联对话框（请显式 observe 其 handle 后再操作）：' + JSON.stringify(data.relatedWindows));
    if (data.elements)
        for (const element of data.elements.slice(0, 80)) {
            const confidence = typeof element.confidence === 'number' && Number.isFinite(element.confidence) ? element.confidence.toFixed(2) : 'unavailable';
            const component = Object.fromEntries(['capabilities', 'focused', 'checked', 'expanded', 'options', 'scroll', 'min', 'max', 'step'].filter(key => element[key] !== undefined).map(key => [key, element[key]]));
            lines.push(`${element.id} | ${element.role} | ${String(element.text || '').slice(0, 180)} | ${JSON.stringify(element.bounds)} | source=${element.source || 'unknown'} | confidence=${confidence}${element.selector ? ` | selector=${JSON.stringify({ automationId: element.selector.automationId, name: element.selector.name, controlType: element.selector.controlType })}` : ''}${Object.keys(component).length ? ` | component=${JSON.stringify(component)}` : ''}`);
        }
    if (Array.isArray(data.results))
        for (const [index, step] of data.results.entries()) {
            // Managed batches return complete {ok,action,data} envelopes. Older native
            // batches wrapped the receipt in result; retain both without dropping data.
            const receipt = step?.result !== undefined ? step.result : step;
            const action = step?.action || receipt?.action || 'input';
            lines.push(`${index + 1}. ${action}: ${JSON.stringify(receipt) ?? '回执缺失；重新观察核对，不重复输入。'}`);
        }
    if (data.windows)
        for (const window of data.windows.slice(0, 40)) {
            lines.push(`窗口：${window.title} | process=${window.process} | pid=${window.pid} | handle=${window.handle} | bounds=${JSON.stringify(window.bounds)}${windowState(window)}`);
        }
    const { elements, windows, screens, frame, foreground, session, results, ...rest } = data;
    if (Object.keys(rest).length)
        lines.push(JSON.stringify(rest));
    const readOnly = ['observe', 'list_windows', 'session_state', 'read_focused', 'wait', 'wait_change'].includes(value.action);
    lines.push(readOnly ? '本次仅观察或读取状态，没有发送输入；业务结果需独立核验。' : '仅表示工具调用结束；业务成功需核对界面文字、截图或独立回执。');
    return lines.join('\n');
}
//# sourceMappingURL=DesktopAgent.js.map