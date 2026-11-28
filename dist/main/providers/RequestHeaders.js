"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODEX_COMPAT_USER_AGENT = void 0;
exports.normalizeCustomUserAgent = normalizeCustomUserAgent;
exports.modelRequestHeaders = modelRequestHeaders;
/** Captured from the locally installed Codex 0.153.0 against a loopback
 * Responses fixture (no external model request). This is its VS Code/exec UA,
 * not a claim that iExA is an official Codex application or desktop build.
 * Pinning avoids depending on an installed Codex binary during normal startup.
 */
exports.CODEX_COMPAT_USER_AGENT = 'codex_vscode/0.153.0 (Windows 10.0.19045; x86_64) dumb (codex_exec; 0.153.0)';
/** Empty means the Codex-compatible default; never persist credentials here. */
function normalizeCustomUserAgent(value) {
    if (value == null)
        return '';
    if (typeof value !== 'string')
        throw new Error('User-Agent 必须是文本。');
    // Check before trim: CR/LF and control characters must not enter HTTP headers.
    if (/[^\x20-\x7e]/.test(value) || value.length > 512)
        throw new Error('User-Agent 仅接受最多512个可打印ASCII字符，不含换行。');
    return value.trim();
}
/** Model API requests only; preserve auth and protocol-specific headers. */
function modelRequestHeaders(input, userAgent) {
    const headers = new Headers(input);
    headers.set('User-Agent', normalizeCustomUserAgent(userAgent) || exports.CODEX_COMPAT_USER_AGENT);
    return headers;
}
//# sourceMappingURL=RequestHeaders.js.map