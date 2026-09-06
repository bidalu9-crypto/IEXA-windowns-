import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutionResult } from '../providers/types';

const ENDPOINT = 'http://127.0.0.1:17891';

export class DesktopAgent {
  private startPromise: Promise<void> | null = null;
  private healthyUntil = 0;

  constructor(private readonly appRoot: string) {}

  private async healthy(): Promise<boolean> {
    if (Date.now() < this.healthyUntil) return true;
    try {
      const r = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(600) });
      if (r.ok) this.healthyUntil = Date.now() + 5000;
      return r.ok;
    } catch { return false; }
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Desktop action cancelled.');
    if (await this.healthy()) return;
    if (!this.startPromise) this.startPromise = this.start();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  private async start(): Promise<void> {
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
    const child = spawn(exe || 'dotnet', exe ? [] : [dll!], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { this.healthyUntil = 0; });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (await this.healthy()) return;
    }
    throw new Error('Desktop agent did not become ready.');
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const started = Date.now();
    const controller = new AbortController();
    const abortParent = () => {
      controller.abort();
      // HttpListener actions are serialized in the native helper. Notify it
      // explicitly so a long observe/wait/type action stops instead of holding
      // the gate after the model turn has been cancelled.
      void fetch(`${ENDPOINT}/cancel`, { method: 'POST', signal: AbortSignal.timeout(800) }).catch(() => {});
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
        await this.ensureStarted(controller.signal);
        if (action === 'frame') {
          const frame = await fetch(`${ENDPOINT}/frame?full=0`, { signal: controller.signal });
          if (!frame.ok) throw new Error(`Desktop frame capture failed (${frame.status}).`);
          const bytes = Buffer.from(await frame.arrayBuffer());
          return {
            output: JSON.stringify({ ok: true, action, bytes: bytes.length, mimeType: 'image/png' }),
            success: true,
            durationMs: Date.now() - started,
            imageData: bytes,
            imageMimeType: 'image/png',
            metadata: { endpoint: ENDPOINT, action },
          };
        }
        const payload: Record<string, unknown> = { ...args, action };
      delete payload.tool_title;
      const response = await fetch(`${ENDPOINT}/execute`, {
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
        metadata: { endpoint: ENDPOINT, action },
      };
      if (response.ok && action === 'observe' && args.captureFrame === true) {
        const frame = await fetch(`${ENDPOINT}/frame?full=0`, { signal: controller.signal });
        if (frame.ok) {
          result.imageData = Buffer.from(await frame.arrayBuffer());
          result.imageMimeType = 'image/png';
        }
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
    }
  }
}

export function formatDesktopResult(value: any): string {
  if (!value || typeof value !== 'object') return String(value);
  if (!value.ok) return `桌面操作失败：${value.error || 'Unknown error'}`;
  const data = value.data || {};
  const lines = [`${value.action} · ${value.elapsedMs ?? 0} ms · ${data.found === false ? '未找到目标' : '已执行'}`];
  if (data.foreground) lines.push(`窗口：${data.foreground.title} (${data.foreground.process}) handle=${data.foreground.handle}`);
  if (data.session) lines.push(`observationToken=${data.session.observationToken || ''}`);
  if (data.frame) lines.push(`画面：${data.frame.width}×${data.frame.height}，capturedAt=${data.frame.capturedAt}，hash=${data.frame.hash}`);
  if (data.elements) for (const element of data.elements.slice(0, 80)) {
    lines.push(`${element.id} | ${element.role} | ${String(element.text || '').slice(0, 180)} | ${JSON.stringify(element.bounds)}`);
  }
  if (data.results) for (const [index, step] of data.results.entries()) lines.push(`${index + 1}. ${step.action}: ${JSON.stringify(step.result)}`);
  const { elements, windows, screens, frame, foreground, session, results, ...rest } = data;
  if (Object.keys(rest).length) lines.push(JSON.stringify(rest));
  lines.push('仅表示输入已执行；业务成功需核对界面文字或截图。');
  return lines.join('\n');
}
