import { ProviderError } from '../providers/ProviderError';
import { abortableSleep, throwIfAborted } from '../providers/stream-utils';

export class RetryManager {
  constructor(private readonly delays = [2000, 5000, 10000]) {}
  isRetryable(error: unknown): boolean { return ProviderError.from(error).retryable; }
  /** Legacy AgentLoop contract: wake on cancellation, then the caller checks its signal. */
  async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    try { await abortableSleep(delayMs, signal); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
  /** Pass signal into the operation's I/O as well; arbitrary promises cannot be forcibly stopped. */
  async run<T>(operation: (signal?: AbortSignal) => Promise<T>, onRetry?: (attempt: number, delayMs: number, error: Error) => void, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      try {
        const result = await operation(signal);
        throwIfAborted(signal);
        return result;
      } catch (error) {
        throwIfAborted(signal);
        const normalized = ProviderError.from(error);
        if (!normalized.retryable || attempt === this.delays.length) throw normalized;
        const delay = this.delays[attempt];
        onRetry?.(attempt + 1, delay, normalized);
        await abortableSleep(delay, signal);
      }
    }
  }
}
