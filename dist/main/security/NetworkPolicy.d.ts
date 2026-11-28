import * as https from 'https';
import { IncomingHttpHeaders } from 'http';
type Address = {
    address: string;
    family: number;
};
export interface NetworkHooks {
    lookup?: (hostname: string) => Promise<readonly Address[]>;
    request?: typeof https.request;
}
export interface NetworkFetchOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    headers?: Record<string, string>;
}
export interface NetworkResponse {
    url: string;
    status: number;
    statusText: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
}
export declare function normalizeIp(address: string): string;
/** Conservative global-unicast allow policy; special-purpose ranges fail closed. */
export declare function isPublicIp(address: string): boolean;
export declare class NetworkPolicy {
    private readonly hooks;
    constructor(hooks?: NetworkHooks);
    private verify;
    /** Compatibility validation only. Use fetch() to bind validation to transport. */
    assertAllowed(input: string): Promise<URL>;
    /** One DNS verification per hop, pinned lookup, normal TLS validation and no pooled sockets. */
    fetch(input: string, options?: NetworkFetchOptions): Promise<NetworkResponse>;
    private isRetryableAddressError;
    private request;
}
export {};
//# sourceMappingURL=NetworkPolicy.d.ts.map