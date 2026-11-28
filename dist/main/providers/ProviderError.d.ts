import { IexaError } from '../errors/IexaError';
export declare class ProviderError extends IexaError {
    readonly status?: number | undefined;
    constructor(code: string, userMessage: string, retryable: boolean, status?: number | undefined, cause?: unknown);
    static from(error: unknown): ProviderError;
    static http(status: number, body: string, label?: string): ProviderError;
    /** A short, human sentence for a failed HTTP response. */
    private static describe;
    /** A successful HTTP transport can still carry a failed provider response. */
    static throwIfErrorFrame(frame: any, eventType?: string): void;
}
//# sourceMappingURL=ProviderError.d.ts.map