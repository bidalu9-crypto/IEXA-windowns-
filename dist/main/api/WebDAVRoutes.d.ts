import * as http from 'http';
import { URL } from 'url';
import { WebDAVConfig } from '../webdav-sync';
export interface WebDAVRoutesContext {
    workspaceDir: string;
    sessionsDir: string;
    settingsFile: string;
    sessionsStoreFile: string;
    maskPassword(value: string): string;
    loadConfig(): WebDAVConfig;
    saveConfig(config: WebDAVConfig): void;
    testConnection(config: WebDAVConfig): Promise<{
        ok: boolean;
        error?: string;
    }>;
    syncAll(config: WebDAVConfig, workspaceDir: string, sessionsDir: string, settingsFile: string, sessionsStoreFile: string): Promise<{
        ok: boolean;
        uploaded: number;
        downloaded: number;
        conflicts: unknown[];
        error?: string;
    }>;
    listConflicts(workspaceDir: string): unknown[];
    previewConflict(workspaceDir: string, id: string): unknown | null;
    resolveConflict(config: WebDAVConfig, workspaceDir: string, id: string, resolution: 'local' | 'remote' | 'merge', content?: string): Promise<unknown | null>;
}
export declare function handleWebDAVRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: WebDAVRoutesContext): Promise<boolean>;
//# sourceMappingURL=WebDAVRoutes.d.ts.map