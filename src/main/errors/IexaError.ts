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

const SECRET_FIELD = /^(?:password|passwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|authorization|cookie|session)$/i;

export function redactSecrets(value: unknown): string {
  return String(value ?? '')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|secret|authorization|cookie|session)"?\s*:\s*")([^"]*)(")/gi, '$1[REDACTED]$3')
    .replace(/((?:api[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|secret|authorization|cookie|session)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/** Redact nested objects, including JSON encoded inside string-valued tool fields. */
export function redactSecretValues(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[REDACTED:DEPTH]';
  if (Array.isArray(value)) return value.map((item) => redactSecretValues(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key, SECRET_FIELD.test(key) ? '[REDACTED]' : redactSecretValues(item, depth + 1),
    ]));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.stringify(redactSecretValues(JSON.parse(value), depth + 1)); }
      catch { /* Preserve non-JSON strings and apply textual redaction below. */ }
    }
    return redactSecrets(value);
  }
  return value;
}
