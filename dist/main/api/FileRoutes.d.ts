import * as http from 'http';
import { URL } from 'url';
export interface RegisteredArtifact {
    path: string;
    mimeType: string;
    size: number;
    created: number;
}
export interface FileRouteContext {
    workspaceDir: string;
    /** Root of the project currently open in the workbench, if any. */
    getProjectRoot(): string | null;
    /** Project roots of every stored session, for read-only artifact access. */
    sessionProjectRoots(): string[];
    artifacts: Map<string, RegisteredArtifact>;
}
export declare const MIME_TYPES: Record<string, string>;
export declare function isPrivateFile(file: string): boolean;
export declare function sanitizeFileName(name: string): string;
/** Handles /api/fs/*, /api/artifacts/* and /api/attachments/*; false means "not mine". */
export declare function handleFileRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: FileRouteContext): Promise<boolean>;
//# sourceMappingURL=FileRoutes.d.ts.map