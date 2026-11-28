"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IexaError = void 0;
exports.redactSecrets = redactSecrets;
exports.redactSecretValues = redactSecretValues;
class IexaError extends Error {
    code;
    category;
    userMessage;
    retryable;
    cause;
    constructor(code, category, userMessage, retryable = false, cause) {
        super(userMessage);
        this.code = code;
        this.category = category;
        this.userMessage = userMessage;
        this.retryable = retryable;
        this.cause = cause;
        this.name = 'IexaError';
    }
}
exports.IexaError = IexaError;
const SECRET_FIELD = /^(?:password|passwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|authorization|cookie|session)$/i;
function redactSecrets(value) {
    return String(value ?? '')
        .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
        .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
        .replace(/("?(?:api[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|secret|authorization|cookie|session)"?\s*:\s*")([^"]*)(")/gi, '$1[REDACTED]$3')
        .replace(/((?:api[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|secret|authorization|cookie|session)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
/** Redact nested objects, including JSON encoded inside string-valued tool fields. */
function redactSecretValues(value, depth = 0) {
    if (depth > 12)
        return '[REDACTED:DEPTH]';
    if (Array.isArray(value))
        return value.map((item) => redactSecretValues(item, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key, SECRET_FIELD.test(key) ? '[REDACTED]' : redactSecretValues(item, depth + 1),
        ]));
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                return JSON.stringify(redactSecretValues(JSON.parse(value), depth + 1));
            }
            catch { /* Preserve non-JSON strings and apply textual redaction below. */ }
        }
        return redactSecrets(value);
    }
    return value;
}
//# sourceMappingURL=IexaError.js.map