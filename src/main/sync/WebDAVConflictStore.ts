import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { JsonStore, writeTextAtomic } from '../persistence/JsonStore';
import { assertLocalSyncPath, readLocalSyncText, remotePathForKey, sanitizeSyncContent } from './SyncDataProtection';

export type ConflictResolution = 'local' | 'remote' | 'merge';
export type ConflictStatus = 'pending' | 'resolved';
export interface SyncConflictRecord {
  id: string; version: 1; key: string; localPath: string; remotePath: string;
  remoteCopyPath: string; deviceId: string; createdAt: number; updatedAt: number;
  status: ConflictStatus; resolution?: ConflictResolution; resolvedAt?: number;
}
interface ConflictIndex { version: 1; deviceId: string; conflicts: SyncConflictRecord[]; }

export class WebDAVConflictStore {
  private readonly root: string;
  private readonly workspace: string;
  private readonly index: JsonStore<ConflictIndex>;
  constructor(workspaceDir: string) {
    this.workspace = path.resolve(workspaceDir);
    this.root = path.join(this.workspace, '.iexa-sync-conflicts');
    assertLocalSyncPath(path.join(this.root, 'index.json'));
    assertLocalSyncPath(path.join(this.root, 'index.json.bak'));
    this.index = new JsonStore(path.join(this.root, 'index.json'), () => ({ version: 1, deviceId: `device_${randomUUID()}`, conflicts: [] }));
  }

  private validate(record: SyncConflictRecord): void {
    if (!record || record.version !== 1 || typeof record.id !== 'string' || typeof record.key !== 'string' ||
        !['pending', 'resolved'].includes(record.status) || typeof record.localPath !== 'string' ||
        typeof record.remoteCopyPath !== 'string' || record.remotePath !== remotePathForKey(record.key)) throw new Error('Invalid conflict record.');
    const relative = path.relative(this.workspace, path.resolve(record.localPath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
        path.dirname(path.resolve(record.remoteCopyPath)) !== this.root ||
        !/^[A-Za-z0-9._-]+\.remote\.[A-Za-z0-9-]+\.json$/.test(path.basename(record.remoteCopyPath))) throw new Error('Invalid conflict destination.');
    assertLocalSyncPath(record.localPath);
    assertLocalSyncPath(`${record.localPath}.bak`);
    assertLocalSyncPath(record.remoteCopyPath);
  }

  private state(): ConflictIndex {
    const state = this.index.loadSync();
    if (state.version !== 1 || typeof state.deviceId !== 'string' || !Array.isArray(state.conflicts) || state.conflicts.length > 10_000) throw new Error('Invalid conflict index.');
    for (const record of state.conflicts) {
      this.validate(record);
      // Upgrade pre-fix conflict copies in place, without a plaintext .bak.
      for (const copy of [record.remoteCopyPath, `${record.remoteCopyPath}.bak`]) {
        if (!fs.existsSync(copy)) continue;
        const original = readLocalSyncText(copy);
        const sanitized = sanitizeSyncContent(record.key, original);
        if (sanitized !== original) writeTextAtomic(copy, sanitized, false);
      }
    }
    return state;
  }

  preserve(key: string, localPath: string, remotePath: string, content: Buffer): SyncConflictRecord {
    const sanitized = sanitizeSyncContent(key, new TextDecoder('utf-8', { fatal: true }).decode(content));
    const state = this.state();
    if (state.conflicts.length >= 10_000) throw new Error('Conflict limit reached.');
    const now = Date.now();
    const safeKey = key.replace(/[^A-Za-z0-9._-]+/g, '_');
    const remoteCopyPath = path.join(this.root, `${safeKey}.remote.${randomUUID()}.json`);
    const record: SyncConflictRecord = {
      id: `conflict_${randomUUID()}`, version: 1, key, localPath: path.resolve(localPath), remotePath,
      remoteCopyPath, deviceId: state.deviceId, createdAt: now, updatedAt: now, status: 'pending',
    };
    this.validate(record);
    fs.mkdirSync(this.root, { recursive: true });
    writeTextAtomic(remoteCopyPath, sanitized, false);
    state.conflicts.push(record);
    this.index.saveSync(state);
    return record;
  }
  list(includeResolved = false): SyncConflictRecord[] { return this.state().conflicts.filter(r => includeResolved || r.status === 'pending'); }
  get(id: string): SyncConflictRecord | null { return this.state().conflicts.find(r => r.id === id) || null; }
  resolve(id: string, resolution: ConflictResolution): SyncConflictRecord | null {
    if (!['local', 'remote', 'merge'].includes(resolution)) throw new Error('Invalid conflict resolution.');
    const state = this.state();
    const record = state.conflicts.find(r => r.id === id && r.status === 'pending');
    if (!record) return null;
    record.status = 'resolved'; record.resolution = resolution; record.resolvedAt = Date.now(); record.updatedAt = record.resolvedAt;
    this.index.saveSync(state);
    return record;
  }
}
