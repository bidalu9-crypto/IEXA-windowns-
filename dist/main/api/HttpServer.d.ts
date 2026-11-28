import * as http from 'http';
export declare class HttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare function jsonReply(res: http.ServerResponse, code: number, body: unknown): void;
export declare function readBody(req: http.IncomingMessage, maxLength?: number): Promise<string>;
export declare function readRawBody(req: http.IncomingMessage, maxLength?: number): Promise<Buffer>;
export declare function configureApiResponse(res: http.ServerResponse): void;
export declare function handleHttpError(res: http.ServerResponse, error: unknown): void;
//# sourceMappingURL=HttpServer.d.ts.map