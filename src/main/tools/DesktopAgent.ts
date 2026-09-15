import { spawn } from 'child_process';
import { assertDesktopHelpersOpen, trackDesktopHelper } from './desktop/DesktopHelperLifetime';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DesktopControlSession, DesktopContext } from './desktop/DesktopControlSession';
import { ToolExecutionResult } from '../providers/types';
import { desktopAdapterRegistry } from './desktop/DesktopBackgroundAdapter';
import { ChromiumCdpAdapter } from './desktop/ChromiumCdpAdapter';
import { NativeIsolatedWorkspace } from './desktop/NativeIsolatedWorkspace';

const ENDPOINT = 'http://127.0.0.1:17891';
const PROTOCOL_VERSION = 6;
const nativeNeedsIdleCheck = new Set<string>();
const nativeStarts = new Map<string, Promise<void>>();

export class DesktopAgent {
  private healthyUntil = 0;
  private cdpAdapters = new Map<string, ChromiumCdpAdapter>();

  private readonly control: DesktopControlSession;
  private isolatedWorkspace?: NativeIsolatedWorkspace;
  private isolatedTransport?: DesktopAgent;
  constructor(private readonly appRoot: string, private readonly captureFramesByDefault: boolean = false, journalDir?: string, private readonly endpoint: string = ENDPOINT, private readonly isolation?: { expectedDesktopName?: string; executable?: string }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Desktop endpoint must be a loopback HTTP origin.');
    this.control = new DesktopControlSession((args, signal) => this.executeNative(args, signal), undefined, journalDir);
  }
  async execute(args: Record<string, unknown>, signal?: AbortSignal, context: DesktopContext = { owner: 'local' }): Promise<ToolExecutionResult> {
    const result = await this.control.execute(args, signal, context);
    if (result.success && args.detail !== 'raw') {
      try { result.output = formatDesktopResult(JSON.parse(result.output)); } catch {}
    }
    const trace = result.metadata?.desktop as any;
    const recovery = trace?.recovered;
    if (recovery && args.detail !== 'raw' && (recovery.unresolvedOperationCount || recovery.journalIntegrity === 'partial')) {
      const operations = (recovery.unresolvedOperations || []).slice(-8).map((op: any) => `${op.operationId} (${op.phase}, dispatched=${op.dispatchedActions})`).join('; ');
      // Place this before the verbose observation so model-context compaction retains the warning.
      result.output = `恢复警告：${recovery.unresolvedOperationCount || 0} 项历史操作可能已执行但结果未确认。先观察并核对业务状态，不要重复提交。${recovery.journalIntegrity === 'partial' ? '日志存在不完整记录，缺失记录不等于未执行。' : ''}\n${operations}\n` + result.output;
    }
    if (trace && args.detail !== 'raw') result.output += `\n控制闭环：${trace.events.map((event: any) => event.phase).join(' → ')}\n验证：${trace.verified ? '指定界面文字已核对' : '未证明业务目标完成'}；恢复策略：重新观察，不重放输入。`;
    return result;
  }

  resetControl(): void { this.control.reset(); }

  close(): void { this.isolatedTransport?.close(); this.isolatedWorkspace?.close(); this.control.reset(); for (const adapter of this.cdpAdapters.values()) adapter.close(); this.cdpAdapters.clear(); }

  private async healthy(): Promise<boolean> {
    // Idle shutdown invalidates native observation state; do not trust cached liveness.
    try {
      const r = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(600) });
      if (!r.ok) return false;
      const health = await r.json() as Record<string, unknown>;
      const valid = health.product === 'IEXA Desktop Agent'
        && health.protocolVersion === PROTOCOL_VERSION
        && (health.lifecycle as any)?.version === 1
        && health.automationEngine === 'FlaUI 5'
        && typeof health.instanceNonce === 'string'
        && health.instanceNonce.length >= 16;
      const isolationValid = !this.isolation?.expectedDesktopName || (health.isolatedDesktop as any)?.verified === true && (health.isolatedDesktop as any)?.desktopName === this.isolation.expectedDesktopName;
      if (valid && isolationValid) this.healthyUntil = Date.now() + 5000;
      return valid && isolationValid;
    } catch { return false; }
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    assertDesktopHelpersOpen();
    if (signal?.aborted) throw new Error('Desktop action cancelled.');
    if (await this.healthy()) return;
    if (this.isolation?.expectedDesktopName) throw new Error('Isolated native worker unavailable or user takeover detected; no foreground fallback.');
    let pending = nativeStarts.get(this.endpoint);
    if (!pending) { pending = this.start(); nativeStarts.set(this.endpoint, pending); }
    try { await pending; } finally { if (nativeStarts.get(this.endpoint) === pending) nativeStarts.delete(this.endpoint); }
  }

  private async start(): Promise<void> {
    await this.stopIncompatibleHelper();
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || path.dirname(process.execPath);
    const candidates = [
      path.join(this.appRoot, 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe'),
      path.join(process.cwd(), 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe'),
      path.join(resourcesPath, 'app.asar.unpacked', 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe'),
      path.join(resourcesPath, 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe'),
      path.join(path.dirname(process.execPath), 'desktop-agent', 'publish', 'Iexa.DesktopAgent.exe'),
    ];
    const exe = candidates.find((p) => fs.existsSync(p));
    const dll = candidates.map((candidate) => candidate.replace(/\.exe$/, '.dll')).find((candidate) => fs.existsSync(candidate));
    if (!exe && !dll) throw new Error('Desktop agent is missing. Run dotnet publish desktop-agent/Iexa.DesktopAgent.csproj.');
    const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'IEXA-WIN', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'desktop-agent.log');
    const previousLogPath = `${logPath}.1`;
    try {
      if (fs.statSync(logPath).size >= 2 * 1024 * 1024) {
        fs.rmSync(previousLogPath, { force: true });
        fs.renameSync(logPath, previousLogPath);
      }
    } catch {}
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] starting ${exe || dll}\n`);
    const logFd = fs.openSync(logPath, 'a');
    let child;
    try {
      assertDesktopHelpersOpen();
      child = spawn(exe || 'dotnet', exe ? [] : [dll!], { stdio: ['pipe', logFd, logFd], windowsHide: true, env: { ...process.env, IEXA_DESKTOP_PORT: new URL(this.endpoint).port || '80', IEXA_DESKTOP_OWNER_PIPE: 'stdin-v1' } });
      trackDesktopHelper(child);
    } finally {
      fs.closeSync(logFd);
    }
    child.on('error', () => { this.healthyUntil = 0; });
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (await this.healthy()) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
    }
    child.stdin?.destroy();
    throw new Error(`Desktop agent did not become ready. See ${logPath}`);
  }

  private async stopIncompatibleHelper(): Promise<void> {
    try {
      const response = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(600) });
      if (!response.ok) return;
      const health = await response.json() as Record<string, unknown>;
      if (health.product !== 'IEXA Desktop Agent' || health.protocolVersion === PROTOCOL_VERSION && (health.lifecycle as any)?.version === 1) return;
      try { await fetch(`${this.endpoint}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(800) }); } catch {}
      for (let index = 0; index < 15; index++) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        try { await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(150) }); }
        catch { return; }
      }
      const pid = Number(health.pid);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch {}
  }

  private async awaitNativeIdle(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(600) });
        const state = await response.json() as any;
        if (response.ok && state.product === 'IEXA Desktop Agent' && state.protocolVersion === PROTOCOL_VERSION && state.action === 'idle') { nativeNeedsIdleCheck.delete(this.endpoint); return; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('Previous desktop action has not settled; control remains quarantined.');
  }

  private async executeNative(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (args.backend === 'native-isolated') {
      try {
        if (args.cdpEndpoint || args.cdpTargetId) throw new Error('Isolated native workspace cannot use a Chromium endpoint.');
        this.isolatedWorkspace ??= new NativeIsolatedWorkspace(this.appRoot, this.isolation?.executable);
        const info = await this.isolatedWorkspace.ensureStarted(signal);
        this.isolatedTransport ??= new DesktopAgent(this.appRoot,this.captureFramesByDefault,undefined,`http://127.0.0.1:${info.port}`,{expectedDesktopName:info.desktopName});
        const result = await this.isolatedTransport.executeNative({...args,backend:'native',background:true},signal);
        return {...result,metadata:{...result.metadata,backend:'native-isolated',isolatedDesktop:info.desktopName}};
      } catch(error) {return {success:false,output:(error as Error).message,cancelled:signal?.aborted||undefined};}
    }
    if (args.backend && !['native','chromium-cdp'].includes(String(args.backend))) return {success:false,output:'Unknown desktop backend; no implicit native fallback.'};
    const cdpEndpoint = typeof args.cdpEndpoint === 'string' ? args.cdpEndpoint : '';
    if (cdpEndpoint || args.backend === 'chromium-cdp') {
      if (!cdpEndpoint) return { output: 'Chromium CDP backend requires cdpEndpoint.', success: false };
      let adapter = this.cdpAdapters.get(cdpEndpoint);
      if (!adapter) { adapter = new ChromiumCdpAdapter(cdpEndpoint); this.cdpAdapters.set(cdpEndpoint, adapter); }
      if (signal?.aborted) return { output: 'Desktop action cancelled.', success: false, cancelled: true };
      const result = await adapter.execute(args, signal);
      const attachObservationFrame = args.captureFrame === true || (args.captureFrame !== false && this.captureFramesByDefault);
      if (args.action === 'observe' && !attachObservationFrame) { delete result.imageData; delete result.imageMimeType; }
      return { ...result, metadata: { ...result.metadata, backend: 'chromium-cdp', cdpEndpoint: cdpEndpoint } };
    }
    const started = Date.now();
    const controller = new AbortController();
    let dispatched = false;
    let cancellation: Promise<unknown> | undefined;
    const abortParent = () => {
      controller.abort();
      // HttpListener actions are serialized in the native helper. Notify it
      // explicitly so a long observe/wait/type action stops instead of holding
      // the gate after the model turn has been cancelled.
      if (dispatched) nativeNeedsIdleCheck.add(this.endpoint);
      if (dispatched && !cancellation) cancellation = fetch(`${this.endpoint}/cancel`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) abortParent();
      else signal.addEventListener('abort', abortParent, { once: true });
    }
    const action = String(args.action || 'observe');
    const requestedTimeout = Number(args.timeoutMs || 0);
    const actionTimeout = action === 'observe' ? Math.max(8000, requestedTimeout || 15000) : Math.max(5000, requestedTimeout || 10000);
    const timeout = setTimeout(abortParent, actionTimeout);
    try {
      const adapter = desktopAdapterRegistry.resolve({ app: String(args.app || ''), process: String(args.process || ''), windowTitle: String(args.window || ''), handle: Number(args.handle || 0) || undefined, pid: Number(args.pid || 0) || undefined });
      if (this.isolation?.expectedDesktopName && !['list_windows','launch','observe','bind_window','session_state','find_element','click_element','type_element','frame','wait','wait_change'].includes(action)) throw new Error('Isolated workspace permits semantic operations only.');
      if (args.background === true && !(this.isolation?.expectedDesktopName && ['launch','wait','wait_change'].includes(action))) {
        const preflight = adapter.preflight?.({ app: String(args.app || ''), process: String(args.process || ''), windowTitle: String(args.window || '') }, action);
        if (preflight && !preflight.allowed) throw new Error(`Background action rejected by ${adapter.id}: ${preflight.reason || 'capability unavailable'}`);
      }
      await this.ensureStarted(controller.signal);
      if (nativeNeedsIdleCheck.has(this.endpoint)) await this.awaitNativeIdle();
      if (action === 'frame') {
        const frame = await fetch(`${this.endpoint}/frame?full=0&observationToken=${encodeURIComponent(String(args.observationToken || ""))}`, { signal: controller.signal });
        if (!frame.ok) throw new Error(`Desktop frame capture failed (${frame.status}).`);
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
      const payload: Record<string, unknown> = { ...args, action };
      delete payload.tool_title;
      if (controller.signal.aborted) throw new Error('Desktop action cancelled before dispatch.');
      dispatched = true;
      const response = await fetch(`${this.endpoint}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.text();
      let parsed: unknown = body;
      try { parsed = JSON.parse(body); } catch {}
      const result: ToolExecutionResult = {
        output: typeof parsed === 'string' ? parsed : args.detail === 'raw' ? JSON.stringify(parsed) : formatDesktopResult(parsed),
        success: response.ok && (parsed as any)?.ok !== false && (parsed as any)?.data?.found !== false,
        durationMs: Date.now() - started,
        metadata: { endpoint: this.endpoint, action, backgroundAdapter: adapter.id, backgroundCapabilities: [...adapter.capabilities] },
      };
      const captureFrame = args.captureFrame === true || (args.captureFrame !== false && this.captureFramesByDefault);
      if (response.ok && action === 'observe' && captureFrame) {
        const token = (parsed as any)?.data?.session?.observationToken;
        if (!token) throw new Error('Observation did not return a frame token.');
        const frame = await fetch(`${this.endpoint}/frame?full=0&observationToken=${encodeURIComponent(String(token))}`, { signal: controller.signal });
        if (!frame.ok || frame.headers.get('x-iexa-observation-token') !== token)
          throw new Error('Observation frame is stale or from an incompatible helper; observe again.');
        result.imageData = Buffer.from(await frame.arrayBuffer());
        result.imageMimeType = 'image/png';
      }
      return result;
    } catch (error) {
      this.healthyUntil = 0;
      const message = controller.signal.aborted
        ? (signal?.aborted ? 'Desktop action cancelled.' : `Desktop action timed out after ${actionTimeout}ms.`)
        : (error as Error).message;
      return { output: message, success: false, timedOut: !signal?.aborted && controller.signal.aborted, durationMs: Date.now() - started };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortParent);
      // Await the cancellation POST before another owner can acquire the queue.
      if (cancellation) { await cancellation; try { await this.awaitNativeIdle(); } catch { /* Quarantine persists until next idle handshake. */ } }
    }
  }
}

export function formatDesktopResult(value: any): string {
  if (!value || typeof value !== 'object') return String(value);
  if (!value.ok) return `桌面操作失败：${value.error || 'Unknown error'}`;
  const data = value.data || {};
  const lines = [`${value.action} · ${value.elapsedMs ?? 0} ms · ${data.found === false ? '未找到目标' : '已执行'}`];
  if (data.foreground) lines.push(`窗口：${data.foreground.title} (${data.foreground.process}) handle=${data.foreground.handle}`);
  if (data.window) lines.push(`目标：${data.window.title} (${data.window.process}) pid=${data.window.pid} handle=${data.window.handle}`);
  if (data.session) lines.push(`observationToken=${data.session.observationToken || ''}`);
  if (data.frame) lines.push(`画面：${data.frame.width}×${data.frame.height}，capturedAt=${data.frame.capturedAt}，hash=${data.frame.hash}，trust=${data.frame.trust || 'unknown'}`);
  if (data.frame?.diagnostic) lines.push(`截图诊断：${String(data.frame.diagnostic).slice(0, 1200)}`);
  if (data.frame?.trust === 'background-unverified') lines.push('后台画面未验证；不要把空白图当作软件状态，不要通过激活窗口或重复输入弥补截图失败。');
  if (data.relatedWindows?.length) lines.push('关联对话框（请显式 observe 其 handle 后再操作）：' + JSON.stringify(data.relatedWindows));
  if (data.elements) for (const element of data.elements.slice(0, 80)) {
    lines.push(`${element.id} | ${element.role} | ${String(element.text || '').slice(0, 180)} | ${JSON.stringify(element.bounds)}${element.selector ? ` | selector=${JSON.stringify({ automationId: element.selector.automationId, name: element.selector.name, controlType: element.selector.controlType })}` : ''}`);
  }
  if (data.results) for (const [index, step] of data.results.entries()) lines.push(`${index + 1}. ${step.action}: ${JSON.stringify(step.result)}`);
  if (data.windows) for (const window of data.windows.slice(0, 40)) {
    lines.push(`窗口：${window.title} | process=${window.process} | pid=${window.pid} | handle=${window.handle} | bounds=${JSON.stringify(window.bounds)}`);
  }
  const { elements, windows, screens, frame, foreground, session, results, ...rest } = data;
  if (Object.keys(rest).length) lines.push(JSON.stringify(rest));
  const readOnly = ['observe', 'list_windows', 'session_state', 'read_focused', 'wait', 'wait_change'].includes(value.action);
  lines.push(readOnly ? '本次仅观察或读取状态，没有发送输入；业务结果需独立核验。' : '仅表示工具调用结束；业务成功需核对界面文字、截图或独立回执。');
  return lines.join('\n');
}
