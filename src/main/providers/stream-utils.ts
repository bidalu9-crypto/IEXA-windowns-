export const STREAM_RETRY_DELAYS_MS = [2000, 5000, 10000];

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit,
  attempts = STREAM_RETRY_DELAYS_MS.length + 1,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !isRetryableStatus(response.status) || attempt === attempts - 1) return response;
      // Drain the body before retrying so keep-alive connections are reusable.
      try { await response.arrayBuffer(); } catch { /* */ }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, STREAM_RETRY_DELAYS_MS[Math.min(attempt, STREAM_RETRY_DELAYS_MS.length - 1)]));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'request failed'));
}

export async function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs = 45000,
): Promise<{ done: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel('stream idle timeout').catch(() => {});
          reject(new Error(`stream idle timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
