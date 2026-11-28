import * as http from 'http';
import { URL } from 'url';
import { TerminalManager } from '../terminals/TerminalManager';
export interface TerminalRouteContext {
    terminals: TerminalManager;
    getProjectRoot: () => string | null;
    workspaceDir: string;
}
export declare function handleTerminalRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: TerminalRouteContext): Promise<boolean>;
//# sourceMappingURL=TerminalRoutes.d.ts.map