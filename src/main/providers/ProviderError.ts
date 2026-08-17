import { IexaError } from '../errors/IexaError';

export class ProviderError extends IexaError {
  constructor(code: string, userMessage: string, retryable: boolean, public readonly status?: number, cause?: unknown) {
    super(code, 'PROVIDER', userMessage, retryable, cause);
  }

  static from(error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error || 'Provider request failed');
    const status = Number(message.match(/\b(\d{3})\b/)?.[1]) || undefined;
    const retryable = status === 408 || status === 425 || status === 429 || (!!status && status >= 500) || /timeout|network|socket|econn|reset|temporar|overload|aborted|stream idle|no response body|premature|quota_exceeded|fetch failed/i.test(message);
    return new ProviderError(status ? `HTTP_${status}` : 'PROVIDER_FAILED', message, retryable, status, error);
  }
}
