export type IexaErrorCategory = 'PROVIDER' | 'TOOL' | 'SECURITY' | 'FILESYSTEM' | 'NETWORK' | 'CONTEXT' | 'SESSION' | 'CONFIG' | 'RUNTIME';

export class IexaError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: IexaErrorCategory,
    public readonly userMessage: string,
    public readonly retryable = false,
    public override readonly cause?: unknown,
  ) {
    super(userMessage);
    this.name = 'IexaError';
  }
}

export function redactSecrets(value: unknown): string {
  return String(value ?? '')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|password)"?\s*:\s*")([^"]*)(")/gi, '$1[REDACTED]$3')
    .replace(/((?:api[_-]?key|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
