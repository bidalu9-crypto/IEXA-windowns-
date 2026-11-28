/** Captured from the locally installed Codex 0.153.0 against a loopback
 * Responses fixture (no external model request). This is its VS Code/exec UA,
 * not a claim that iExA is an official Codex application or desktop build.
 * Pinning avoids depending on an installed Codex binary during normal startup.
 */
export declare const CODEX_COMPAT_USER_AGENT = "codex_vscode/0.153.0 (Windows 10.0.19045; x86_64) dumb (codex_exec; 0.153.0)";
/** Empty means the Codex-compatible default; never persist credentials here. */
export declare function normalizeCustomUserAgent(value: unknown): string;
/** Model API requests only; preserve auth and protocol-specific headers. */
export declare function modelRequestHeaders(input?: ConstructorParameters<typeof Headers>[0], userAgent?: string): Headers;
//# sourceMappingURL=RequestHeaders.d.ts.map