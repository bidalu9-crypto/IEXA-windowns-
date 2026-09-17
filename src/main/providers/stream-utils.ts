import { ProviderError } from './ProviderError';
import { modelRequestHeaders } from './RequestHeaders';

export const STREAM_RETRY_DELAYS_MS = [2000, 5000, 10000];

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: string; code?: string };
  return value.name === 'AbortError' || value.code === 'ABORT_ERR' || value.code === 'PROVIDER_ABORTED';
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/** Reject on cancellation and remove the listener on every settlement path. */
export function abortableSleep(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit & { userAgent?: string },
  attempts = STREAM_RETRY_DELAYS_MS.length + 1,
): Promise<Response> {
  const signal = init.signal === undefined && typeof Request !== 'undefined' && input instanceof Request ? input.signal : init.signal;
  throwIfAborted(signal);
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive integer');
  const inheritedHeaders = init.headers === undefined && typeof Request !== 'undefined' && input instanceof Request ? input.headers : init.headers;
  const { userAgent, ...fetchInit } = init;
  const requestInit = { ...fetchInit, headers: modelRequestHeaders(inheritedHeaders, userAgent) };
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(signal);
    try {
      const response = await fetch(input, requestInit);
      if (signal?.aborted) {
        void response.body?.cancel().catch(() => {});
        throwIfAborted(signal);
      }
      if (response.ok || !isRetryableStatus(response.status) || attempt === attempts - 1) return response;
      // Do not buffer (or await draining) an arbitrarily large/erroring body.
      void response.body?.cancel().catch(() => {});
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      throwIfAborted(signal);
      if (!ProviderError.from(error).retryable || attempt === attempts - 1) throw error;
      lastError = error;
    }
    await abortableSleep(STREAM_RETRY_DELAYS_MS[Math.min(attempt, STREAM_RETRY_DELAYS_MS.length - 1)], signal);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'request failed'));
}

// Reasoning models can spend several minutes between SSE frames while doing
// hidden work. A 45s idle cutoff aborts a healthy stream and truncates the
// visible thinking block. Keep a generous transport watchdog for genuinely
// dead connections; the caller's AbortSignal still remains the hard cancel.
export const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export async function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs = STREAM_IDLE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: T }> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => {
          reject(signal?.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          void reader.cancel(signal?.reason).catch(() => {});
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`stream idle timeout after ${timeoutMs}ms`));
          void reader.cancel('stream idle timeout').catch(() => {});
        }, timeoutMs);
      }),
    ]);
    throwIfAborted(signal);
    return result;
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    if (timer) clearTimeout(timer);
  }
}

/** SSE framing independent of byte boundaries; also accepts a plain JSON error body. */
export async function* readSSEFrames(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ data: string; event: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let json = '';
  const line = (text: string): { data: string; event: string } | undefined => {
    if (!text) {
      const frame = data.length ? { data: data.join('\n'), event } : undefined;
      data = []; event = '';
      return frame;
    }
    if (text.startsWith('event:')) event = text.slice(6).trim();
    else if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
    else if (json || text.trimStart().startsWith('{')) json += text + '\n';
    return undefined;
  };
  while (true) {
    const { done, value } = await readWithTimeout(reader, STREAM_IDLE_TIMEOUT_MS, signal);
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    // Keep a trailing CR pending: it may be half of a split CRLF delimiter.
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
      const frame = line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (frame) { throwIfAborted(signal); yield frame; }
    }
    if (done) {
      if (buffer) { const frame = line(buffer.replace(/\r$/, '')); if (frame) yield frame; }
      const frame = line('');
      if (frame) yield frame;
      if (json.trim()) yield { data: json.trim(), event: '' };
      return;
    }
    if (buffer.length + json.length + data.reduce((sum, text) => sum + text.length, 0) > 8 * 1024 * 1024) {
      throw new ProviderError('INVALID_STREAM', 'Provider SSE frame exceeds size limit', false);
    }
  }
}
