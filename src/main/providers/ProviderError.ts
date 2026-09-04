import { IexaError } from '../errors/IexaError';

export class ProviderError extends IexaError {
  constructor(code: string, userMessage: string, retryable: boolean, public readonly status?: number, cause?: unknown) {
    super(code, 'PROVIDER', userMessage, retryable, cause);
  }

  static from(error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error || 'Provider request failed');
    const status = Number(message.match(/\b(\d{3})\b/)?.[1]) || undefined;
    // Node's built-in fetch (Undici) reports an HTTP response body that was
    // closed before its terminal SSE frame as the bare message "terminated".
    const streamTerminated = /^terminated$/i.test(message.trim()) || /response body.*terminated/i.test(message);
    const retryable = status === 408 || status === 425 || status === 429 || (!!status && status >= 500) ||
      /timeout|network|socket|econn|reset|temporar|overload|aborted|stream idle|no response body|premature|quota_exceeded|fetch failed|\bterminated\b/i.test(message);
    const userMessage = streamTerminated
      ? '模型的流式连接被服务端或网络代理中途断开，自动重试后仍未恢复。请检查模型端点或网络连接后重试。'
      : message;
    return new ProviderError(status ? `HTTP_${status}` : streamTerminated ? 'STREAM_TERMINATED' : 'PROVIDER_FAILED', userMessage, retryable, status, error);
  }
}
