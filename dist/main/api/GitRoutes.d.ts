/**
 * Git workbench endpoints.
 *
 * One GitService instance serves every repository: the service starts a fresh
 * child process per call and keeps no state, so the repository path is the only
 * thing that varies between requests.
 */
import * as http from 'http';
import { URL } from 'url';
export interface GitRouteContext {
    getProjectRoot(): string | null;
}
export declare function handleGitRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: GitRouteContext): Promise<boolean>;
//# sourceMappingURL=GitRoutes.d.ts.map