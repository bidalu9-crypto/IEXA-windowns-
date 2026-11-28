import * as http from 'http';
export declare const DESKTOP_COOKIE = "iexa_desktop_session";
export declare function isLoopback(req: http.IncomingMessage): boolean;
export declare function isTLS(req: http.IncomingMessage): boolean;
export declare function readCookie(req: http.IncomingMessage, name: string): string;
/** Per-process desktop capability. It is never served by an unauthenticated endpoint. */
export declare class LocalApiAuth {
    private readonly trustLoopback;
    readonly token: string;
    private bootstrap;
    private attempts;
    constructor(trustLoopback?: boolean);
    validateRequest(req: http.IncomingMessage, opaqueAssetRead?: boolean): void;
    authenticated(req: http.IncomingMessage): boolean;
    createBootstrap(): string;
    acceptBootstrap(req: http.IncomingMessage, token: string): boolean;
    rateLimit(req: http.IncomingMessage, operation: string): void;
    setCookie(res: http.ServerResponse, port: number): void;
}
//# sourceMappingURL=LocalApiAuth.d.ts.map