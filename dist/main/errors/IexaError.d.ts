export type IexaErrorCategory = 'PROVIDER' | 'TOOL' | 'SECURITY' | 'FILESYSTEM' | 'NETWORK' | 'CONTEXT' | 'SESSION' | 'CONFIG' | 'RUNTIME';
export declare class IexaError extends Error {
    readonly code: string;
    readonly category: IexaErrorCategory;
    readonly userMessage: string;
    readonly retryable: boolean;
    readonly cause?: unknown | undefined;
    constructor(code: string, category: IexaErrorCategory, userMessage: string, retryable?: boolean, cause?: unknown | undefined);
}
export declare function redactSecrets(value: unknown): string;
/** Redact nested objects, including JSON encoded inside string-valued tool fields. */
export declare function redactSecretValues(value: unknown, depth?: number): unknown;
//# sourceMappingURL=IexaError.d.ts.map