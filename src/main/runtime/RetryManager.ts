import { ProviderError } from '../providers/ProviderError';

export class RetryManager {
  constructor(private readonly delays = [2000, 5000, 10000]) {}
  isRetryable(error: unknown): boolean { return ProviderError.from(error).retryable; }
  async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  async run<T>(operation: () => Promise<T>, onRetry?: (attempt: number, delayMs: number, error: Error) => void): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.delays.length; attempt++) {
      try { return await operation(); } catch (error) {
        last = error;
        const normalized = ProviderError.from(error);
        if (!normalized.retryable || attempt === this.delays.length) throw normalized;
        const delay = this.delays[attempt];
        onRetry?.(attempt + 1, delay, normalized);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw last;
  }
}
