import type { WebDAVClient } from 'webdav';
export declare const MAX_SYNC_BYTES: number;
export declare const MAX_REMOTE_ENTRIES = 10000;
export declare const isObject: (v: any) => v is Record<string, any>;
/** Strict on both platforms, including Windows devices, ADS and encoded separators. */
export declare function assertRemoteBasename(name: unknown): asserts name is string;
/** Reject existing symlinks/junctions in the destination, including its ancestors. */
export declare function assertLocalSyncPath(file: string): void;
export declare function parseBoundedJSON(text: string): any;
export interface SettingsSyncDTO {
    kind: 'iexa-settings';
    version: 1;
    preferences: {
        thinkingLevel?: string;
        contextCompactionLimit?: number;
    };
}
/** Intentionally excludes profiles, profile selections, endpoints, credentials and policy. */
export declare function toSettingsSyncDTO(settings: unknown): SettingsSyncDTO;
/** Pure merge: never imports a remote reference or mutates local credential fields. */
export declare function mergeSettingsSyncDTO<T extends Record<string, any>>(local: T, remote: unknown): T;
/** Schema validation applies equally to downloads, conflict copies and manual merges. */
export declare function sanitizeSyncContent(key: string, text: string): string;
export declare function readLocalSyncText(file: string): string;
/** Streams are capped even when Content-Length is absent or dishonest. */
export declare function readRemoteSyncText(client: WebDAVClient, remote: string): Promise<string>;
export declare function remoteEntries(client: WebDAVClient, remote: string): Promise<any[]>;
export declare function remotePathForKey(key: string): string;
//# sourceMappingURL=SyncDataProtection.d.ts.map