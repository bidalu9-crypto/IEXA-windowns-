import type { WebDAVClient } from 'webdav';
import { ProtectedSettingsStore } from './security/SecretStore';
import { ConflictResolution, SyncConflictRecord } from './sync/WebDAVConflictStore';
export { assertRemoteBasename, mergeSettingsSyncDTO, toSettingsSyncDTO } from './sync/SyncDataProtection';
export interface WebDAVConfig {
    url: string;
    username: string;
    password: string;
    enabled: boolean;
    autoSync: boolean;
    lastSync: number;
}
export interface SyncResult {
    ok: boolean;
    uploaded: number;
    downloaded: number;
    conflicts: SyncConflict[];
    error?: string;
}
export interface SyncConflict {
    id: string;
    version: 1;
    key: string;
    localPath: string;
    remotePath: string;
    remoteCopyPath: string;
    deviceId: string;
    createdAt: number;
    updatedAt: number;
}
interface SyncStamp {
    localMtime: number;
    remoteMtime: number;
}
/** Optional, explicit dependency injection; production never consults a test-mode env var. */
export interface SyncDependencies {
    settingsStore?: ProtectedSettingsStore;
    clientFactory?: (cfg: WebDAVConfig) => WebDAVClient | Promise<WebDAVClient>;
}
export declare function setConfigFile(filePath: string): void;
export declare function loadConfig(store?: ProtectedSettingsStore): WebDAVConfig;
export declare function saveConfig(cfg: WebDAVConfig, store?: ProtectedSettingsStore): void;
export declare function testConnection(cfg: WebDAVConfig, deps?: SyncDependencies): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function hasSyncConflict(previous: SyncStamp | undefined, localMtime: number, remoteMtime: number): boolean;
export declare function listSyncConflicts(workspace: string, includeResolved?: boolean): SyncConflictRecord[];
export interface SyncConflictPreview {
    conflict: SyncConflictRecord;
    mergeable: boolean;
    localContent?: string;
    remoteContent?: string;
}
export declare function previewSyncConflict(workspace: string, id: string): SyncConflictPreview | null;
export declare function resolveSyncConflict(cfg: WebDAVConfig, workspace: string, id: string, resolution: ConflictResolution, mergedContent?: string, deps?: SyncDependencies): Promise<SyncConflictRecord | null>;
export declare function syncAll(cfg: WebDAVConfig, workspace: string, sessionsDir: string, settingsFile: string, sessionsStoreFile: string, deps?: SyncDependencies): Promise<SyncResult>;
//# sourceMappingURL=webdav-sync.d.ts.map