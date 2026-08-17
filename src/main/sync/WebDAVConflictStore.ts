import * as fs from 'fs';
import * as path from 'path';
import { JsonStore } from '../persistence/JsonStore';

export type ConflictResolution = 'local' | 'remote' | 'merge';
export type ConflictStatus = 'pending' | 'resolved';

export interface SyncConflictRecord {
  id: string;
  version: 1;
  key: string;
  localPath: string;
  remotePath: string;
  remoteCopyPath: string;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
  status: ConflictStatus;
  resolution?: ConflictResolution;
  resolvedAt?: number;
}

interface ConflictIndex { version: 1; deviceId: string; conflicts: SyncConflictRecord[]; }

export class WebDAVConflictStore {
  private readonly root: string;
  private readonly index: JsonStore<ConflictIndex>;

  constructor(workspaceDir: string) {
    this.root = path.join(workspaceDir, '.iexa-sync-conflicts');
    this.index = new JsonStore(path.join(this.root, 'index.json'), () => ({ version: 1, deviceId: createDeviceId(), conflicts: [] }));
  }

  preserve(key: string, localPath: string, remotePath: string, content: Buffer): SyncConflictRecord {
    fs.mkdirSync(this.root, { recursive: true });
    const state = this.index.loadSync();
    const safeKey = key.replace(/[^A-Za-z0-9._-]+/g, '_');
    const now = Date.now();
    const remoteCopyPath = path.join(this.root, `${safeKey}.remote.${now}.json`);
    const record: SyncConflictRecord = {
      id: `conflict_${now.toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      version: 1, key, localPath, remotePath, remoteCopyPath, deviceId: state.deviceId,
      createdAt: now, updatedAt: now, status: 'pending',
    };
    fs.writeFileSync(remoteCopyPath, content);
    state.conflicts.push(record);
    this.index.saveSync(state);
    return record;
  }

  list(includeResolved = false): SyncConflictRecord[] {
    return this.index.loadSync().conflicts.filter((record) => includeResolved || record.status === 'pending');
  }

  get(id: string): SyncConflictRecord | null {
    return this.index.loadSync().conflicts.find((record) => record.id === id) || null;
  }

  resolve(id: string, resolution: ConflictResolution): SyncConflictRecord | null {
    const state = this.index.loadSync();
    const record = state.conflicts.find((item) => item.id === id && item.status === 'pending');
    if (!record) return null;
    record.status = 'resolved';
    record.resolution = resolution;
    record.resolvedAt = Date.now();
    record.updatedAt = record.resolvedAt;
    this.index.saveSync(state);
    return record;
  }
}

function createDeviceId(): string {
  return `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
