import * as http from 'http';
import type { ChatMessage } from './session/ChatMessage';
/** Active project root for tools + file browser; null when none. */
export declare function getProjectRoot(): string | null;
export declare function clientFileChange<T>(change: T): T;
export declare function clientMessages(msgs: ChatMessage[]): ChatMessage[];
/** Main-process only; never exposed over HTTP or preload. */
export declare function getServerCredentials(server: http.Server): {
    token: string;
    loginCode: string;
    cookieName: string;
};
export declare function startServer(port?: number, autoOpen?: boolean, host?: string, options?: {
    trustLoopback?: boolean;
}): Promise<http.Server>;
//# sourceMappingURL=server.d.ts.map