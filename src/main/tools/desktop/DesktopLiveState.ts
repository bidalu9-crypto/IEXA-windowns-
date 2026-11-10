import { ToolExecutionResult } from '../../providers/types';
import { readDesktopPreview } from './DesktopPreview';

interface PreviewSource { backend: string; endpoint?: string; targetId?: string; }
interface CachedFrame { source: PreviewSource; bytes: Buffer; mimeType: string; capturedAt: number; }
const backendNames = new Set(['native', 'native-isolated', 'chromium-cdp']);
const unavailable = (status: number, error: string) => new Response(JSON.stringify({ error }), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** The live window follows the last managed operation, across all backends.
 * Reading it never captures, activates a window, or starts a desktop helper. */
export class DesktopLiveState {
  private owner?: string;
  private source?: PreviewSource;
  private frame?: CachedFrame;
  private candidate?: CachedFrame;
  private control?: Record<string, unknown>;
  private updatedAt?: number;
  private success?: boolean;

  recordTransportPreview(result: ToolExecutionResult, source: PreviewSource): void {
    if (!result.success || !result.imageData?.length || result.imageData.length > 16 * 1024 * 1024 || !backendNames.has(source.backend)) return;
    if (!['image/png', 'image/jpeg'].includes(result.imageMimeType || '')) return;
    let capturedAt = Date.now();
    try {
      const data = JSON.parse(result.output)?.data;
      const timestamp = Number(data?.frame?.capturedAt ?? data?.capturedAt);
      if (Number.isFinite(timestamp) && timestamp > 0) capturedAt = timestamp;
    } catch { /* A frame-only response has no observation body. */ }
    this.candidate = { source: { ...source }, bytes: Buffer.from(result.imageData), mimeType: result.imageMimeType!, capturedAt };
  }

  recordControlResult(result: ToolExecutionResult, owner: string): void {
    const metadata = result.metadata as any;
    const control = metadata?.desktop?.control;
    if (!control || !backendNames.has(control.backend) || !['background', 'foreground'].includes(control.mode)) return;
    const sameTarget = this.owner === owner && this.control?.backend === control.backend;
    const endpoint = control.backend === 'chromium-cdp' ? metadata.cdpEndpoint : metadata.endpoint;
    let source: PreviewSource | undefined;
    if (typeof endpoint === 'string') {
      // Transport chooses the endpoint; a model-supplied arbitrary URL is never
      // fetched here. Native preview endpoints must be loopback HTTP origins.
      if (control.backend === 'chromium-cdp') source = { backend: control.backend, endpoint, targetId: metadata.cdpTargetId };
      else {
        try {
          const url = new URL(endpoint);
          if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) source = { backend: control.backend, endpoint: url.origin };
        } catch { /* Invalid transport metadata supplies no preview source. */ }
      }
    } else if (sameTarget) source = this.source;
    if (!result.success) { source = undefined; this.candidate = undefined; }
    if (!result.success || !sameTarget || source?.endpoint !== this.source?.endpoint || source?.targetId !== this.source?.targetId) this.frame = undefined;
    this.owner = owner;
    this.source = source;
    this.control = {
      mode: control.mode, backend: control.backend, capability: String(control.capability || ''),
      focusPolicy: control.focusPolicy, physicalInput: control.physicalInput === true,
      providerMayChangeFocus: control.providerMayChangeFocus === true,
      noForegroundFallback: control.noForegroundFallback === true,
    };
    this.updatedAt = Date.now();
    this.success = result.success;
    if (source?.backend === 'chromium-cdp') {
      const candidate = this.candidate;
      if (candidate?.source.backend === source.backend && candidate.source.endpoint === source.endpoint && (!source.targetId || source.targetId === candidate.source.targetId)) {
        this.frame = candidate;
        this.candidate = undefined;
      }
    }
  }

  status() {
    return { control: this.control && { ...this.control }, updatedAt: this.updatedAt, capturedAt: this.frame?.capturedAt, success: this.success, hasFrame: !!this.frame, observed: !!this.updatedAt };
  }

  async readFrame(signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw signal.reason || new Error('Preview request cancelled.');
    if (this.source?.backend === 'chromium-cdp') {
      if (!this.frame) return unavailable(404, '当前浏览器目标尚无观察快照。');
      return new Response(new Uint8Array(this.frame.bytes), { headers: {
        'Content-Type': this.frame.mimeType, 'Cache-Control': 'no-store',
        'X-Captured-At': String(this.frame.capturedAt), 'X-IEXA-Frame-Mode': 'cached-observation',
      } });
    }
    if (!this.source?.endpoint) return unavailable(404, '等待当前目标的首次观察。');
    return readDesktopPreview(this.source.endpoint, signal);
  }
}

const liveState = new DesktopLiveState();
export const recordDesktopTransportPreview = (result: ToolExecutionResult, source: PreviewSource): void => liveState.recordTransportPreview(result, source);
export const recordDesktopControlResult = (result: ToolExecutionResult, owner: string): void => liveState.recordControlResult(result, owner);
export const readDesktopLiveStatus = () => liveState.status();
export const readActiveDesktopPreview = (signal?: AbortSignal) => liveState.readFrame(signal);
