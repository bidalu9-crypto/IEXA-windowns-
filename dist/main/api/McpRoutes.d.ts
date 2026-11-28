import * as http from 'http';
import { URL } from 'url';
import { McpManager } from '../mcp/McpManager';
export interface McpRouteContext {
    mcp: McpManager;
}
export declare function handleMcpRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: McpRouteContext): Promise<boolean>;
//# sourceMappingURL=McpRoutes.d.ts.map