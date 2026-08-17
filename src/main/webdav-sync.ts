// =============================================================================
// IEXA PC - WebDAV Sync Module
// Syncs settings & conversations to a WebDAV server
// =============================================================================

import { createClient, WebDAVClient } from 'webdav';
import * as fs from 'fs';
import * as path from 'path';
import { JsonStore, writeTextAtomic } from './persistence/JsonStore';
import { ConflictResolution, SyncConflictRecord, WebDAVConflictStore } from './sync/WebDAVConflictStore';

// ---- Types ----
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

interface SyncStamp { localMtime: number; remoteMtime: number; }
interface SyncState { version: 1; files: Record<string, SyncStamp>; }

// ---- Config I/O ----
const CONFIG_FILE: string = (() => {
  // We'll be called from server.ts context; resolve workspace dir
  return '';
})();

let _configFile = '';

export function setConfigFile(filePath: string) {
  _configFile = filePath;
}

export function loadConfig(): WebDAVConfig {
  const empty = { url: '', username: '', password: '', enabled: false, autoSync: false, lastSync: 0 };
  if (!_configFile) return empty;
  return new JsonStore<WebDAVConfig>(_configFile, () => empty).loadSync();
}

export function saveConfig(c: WebDAVConfig): void {
  new JsonStore<WebDAVConfig>(_configFile, () => c).saveSync(c);
}

// ---- Client ----
function createWebDAVClient(cfg: WebDAVConfig): WebDAVClient {
  return createClient(cfg.url, {
    username: cfg.username,
    password: cfg.password,
  });
}

// ---- Test Connection ----
export async function testConnection(cfg: WebDAVConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = createWebDAVClient(cfg);
    await client.getDirectoryContents('/');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ---- Sync ----
const REMOTE_BASE = '/IEXA';
const SESSIONS_DIR = 'sessions';
const MEMORY_DIR = 'memory';
const SKILLS_DIR = 'skills';

function syncStatePath(workspaceDir: string): string { return path.join(workspaceDir, '.iexa-webdav-sync-state.json'); }
function loadSyncState(workspaceDir: string): SyncState {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStatePath(workspaceDir), 'utf8')) as Partial<SyncState>;
    if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') return { version: 1, files: parsed.files };
  } catch { /* first sync */ }
  return { version: 1, files: {} };
}
function saveSyncState(workspaceDir: string, state: SyncState): void { new JsonStore<SyncState>(syncStatePath(workspaceDir), () => state).saveSync(state); }
export function hasSyncConflict(previous: SyncStamp | undefined, localMtime: number, remoteMtime: number): boolean {
  return !!previous && localMtime > previous.localMtime + 1 && remoteMtime > previous.remoteMtime + 1;
}
async function preserveRemoteConflict(client: WebDAVClient, workspaceDir: string, key: string, localPath: string, remotePath: string): Promise<SyncConflict> {
  const content = await client.getFileContents(remotePath, { format: 'binary' }) as Buffer;
  return new WebDAVConflictStore(workspaceDir).preserve(key, localPath, remotePath, content);
}

export function listSyncConflicts(workspaceDir: string, includeResolved = false): SyncConflictRecord[] {
  return new WebDAVConflictStore(workspaceDir).list(includeResolved);
}

export interface SyncConflictPreview {
  conflict: SyncConflictRecord;
  mergeable: boolean;
  localContent?: string;
  remoteContent?: string;
}

/** Only session JSON is offered for manual merging; settings may contain credentials. */
export function previewSyncConflict(workspaceDir: string, id: string): SyncConflictPreview | null {
  const conflict = new WebDAVConflictStore(workspaceDir).get(id);
  if (!conflict || conflict.status !== 'pending') return null;
  const mergeable = conflict.key.startsWith('session:')
    && fs.existsSync(conflict.localPath)
    && fs.existsSync(conflict.remoteCopyPath)
    && fs.statSync(conflict.localPath).size <= 1_000_000
    && fs.statSync(conflict.remoteCopyPath).size <= 1_000_000;
  if (!mergeable) return { conflict, mergeable: false };
  return {
    conflict,
    mergeable: true,
    localContent: fs.readFileSync(conflict.localPath, 'utf8'),
    remoteContent: fs.readFileSync(conflict.remoteCopyPath, 'utf8'),
  };
}

export async function resolveSyncConflict(
  cfg: WebDAVConfig,
  workspaceDir: string,
  id: string,
  resolution: ConflictResolution,
  mergedContent?: string,
): Promise<SyncConflictRecord | null> {
  const store = new WebDAVConflictStore(workspaceDir);
  const conflict = store.get(id);
  if (!conflict || conflict.status !== 'pending') return null;
  const client = createWebDAVClient(cfg);
  if (resolution === 'remote') {
    if (!fs.existsSync(conflict.remoteCopyPath)) throw new Error('远端冲突副本不存在。');
    writeTextAtomic(conflict.localPath, fs.readFileSync(conflict.remoteCopyPath));
  } else {
    let content: string;
    if (resolution === 'merge') {
      if (typeof mergedContent !== 'string') throw new Error('合并处理需要完整内容。');
      content = mergedContent;
    } else {
      content = fs.readFileSync(conflict.localPath, 'utf8');
    }
    if (resolution === 'merge') writeTextAtomic(conflict.localPath, content);
    await client.putFileContents(conflict.remotePath, content, { overwrite: true });
  }
  return store.resolve(id, resolution);
}

export async function syncAll(
  cfg: WebDAVConfig,
  workspaceDir: string,
  sessionsDir: string,
  settingsFile: string,
  sessionsStoreFile: string,
): Promise<SyncResult> {
  const client = createWebDAVClient(cfg);
  let uploaded = 0;
  let downloaded = 0;
  const conflicts: SyncConflict[] = [];
  const state = loadSyncState(workspaceDir);

  try {
    // Ensure remote base dirs exist
    await ensureRemoteDir(client, REMOTE_BASE);
    await ensureRemoteDir(client, `${REMOTE_BASE}/${SESSIONS_DIR}`);
    await ensureRemoteDir(client, `${REMOTE_BASE}/${MEMORY_DIR}`);
    await ensureRemoteDir(client, `${REMOTE_BASE}/${SKILLS_DIR}`);

    // ---- Sync settings file ----
    const remoteSettingsPath = `${REMOTE_BASE}/settings.json`;
    if (fs.existsSync(settingsFile)) {
      const localStat = fs.statSync(settingsFile);
      const localTime = localStat.mtimeMs;
      const remoteTime = await getRemoteMtime(client, remoteSettingsPath);

      if (remoteTime > 0 && hasSyncConflict(state.files.settings, localTime, remoteTime)) {
        conflicts.push(await preserveRemoteConflict(client, workspaceDir, 'settings', settingsFile, remoteSettingsPath));
      } else if (remoteTime === 0 || localTime > remoteTime) {
        // Upload local → remote
        const content = fs.readFileSync(settingsFile, 'utf-8');
        await client.putFileContents(remoteSettingsPath, content, { overwrite: true });
        uploaded++;
        state.files.settings = { localMtime: localTime, remoteMtime: Date.now() };
      } else if (remoteTime > localTime) {
        // Download remote → local
        const content = await client.getFileContents(remoteSettingsPath, { format: 'text' }) as string;
        writeTextAtomic(settingsFile, content);
        downloaded++;
        state.files.settings = { localMtime: fs.statSync(settingsFile).mtimeMs, remoteMtime: remoteTime };
      } else {
        state.files.settings = { localMtime: localTime, remoteMtime: remoteTime };
      }
    }

    // ---- Sync sessions store file ----
    const remoteSessionsStorePath = `${REMOTE_BASE}/sessions-store.json`;
    if (fs.existsSync(sessionsStoreFile)) {
      const localStat = fs.statSync(sessionsStoreFile);
      const localTime = localStat.mtimeMs;
      const remoteTime = await getRemoteMtime(client, remoteSessionsStorePath);
      if (remoteTime > 0 && hasSyncConflict(state.files.sessions_index, localTime, remoteTime)) {
        conflicts.push(await preserveRemoteConflict(client, workspaceDir, 'sessions_index', sessionsStoreFile, remoteSessionsStorePath));
      } else if (remoteTime === 0 || localTime > remoteTime) {
        const content = fs.readFileSync(sessionsStoreFile, 'utf-8');
        await client.putFileContents(remoteSessionsStorePath, content, { overwrite: true });
        uploaded++;
        state.files.sessions_index = { localMtime: localTime, remoteMtime: Date.now() };
      } else if (remoteTime > localTime) {
        const content = await client.getFileContents(remoteSessionsStorePath, { format: 'text' }) as string;
        writeTextAtomic(sessionsStoreFile, content);
        downloaded++;
        state.files.sessions_index = { localMtime: fs.statSync(sessionsStoreFile).mtimeMs, remoteMtime: remoteTime };
      } else {
        state.files.sessions_index = { localMtime: localTime, remoteMtime: remoteTime };
      }
    }

    // ---- Sync individual session files ----
    if (fs.existsSync(sessionsDir)) {
      const localFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

      for (const f of localFiles) {
        const localPath = path.join(sessionsDir, f);
        const remotePath = `${REMOTE_BASE}/${SESSIONS_DIR}/${f}`;
        const localStat = fs.statSync(localPath);
        const localTime = localStat.mtimeMs;
        const remoteTime = await getRemoteMtime(client, remotePath);
        const key = `session:${f}`;
        if (remoteTime > 0 && hasSyncConflict(state.files[key], localTime, remoteTime)) {
          conflicts.push(await preserveRemoteConflict(client, workspaceDir, key, localPath, remotePath));
        } else if (remoteTime === 0 || localTime > remoteTime) {
          const content = fs.readFileSync(localPath, 'utf-8');
          await client.putFileContents(remotePath, content, { overwrite: true });
          uploaded++;
          state.files[key] = { localMtime: localTime, remoteMtime: Date.now() };
        } else if (remoteTime > localTime) {
          const content = await client.getFileContents(remotePath, { format: 'text' }) as string;
          writeTextAtomic(localPath, content);
          downloaded++;
          state.files[key] = { localMtime: fs.statSync(localPath).mtimeMs, remoteMtime: remoteTime };
        } else {
          state.files[key] = { localMtime: localTime, remoteMtime: remoteTime };
        }
      }

      // Also pull remote session files not present locally
      const remoteEntries = await client.getDirectoryContents(`${REMOTE_BASE}/${SESSIONS_DIR}`) as any[];
      for (const entry of remoteEntries) {
        if (entry.type === 'file' && entry.basename && entry.basename.endsWith('.json')) {
          const remotePath = `${REMOTE_BASE}/${SESSIONS_DIR}/${entry.basename}`;
          const localPath = path.join(sessionsDir, entry.basename);
          if (!fs.existsSync(localPath)) {
            try {
              const content = await client.getFileContents(remotePath, { format: 'text' }) as string;
              writeTextAtomic(localPath, content);
              downloaded++;
            } catch { /* skip unreachable files */ }
          }
        }
      }
    }

    // ---- Sync durable project memories (Markdown only) ----
    const memoryDir = path.join(workspaceDir, '.iexa-memory');
    if (fs.existsSync(memoryDir)) {
      const localMemory = fs.readdirSync(memoryDir).filter((file) => file.endsWith('.md'));
      for (const file of localMemory) {
        const result = await syncManagedFile(client, state, workspaceDir, `memory:${file}`, path.join(memoryDir, file), `${REMOTE_BASE}/${MEMORY_DIR}/${file}`);
        uploaded += result.uploaded; downloaded += result.downloaded; if (result.conflict) conflicts.push(result.conflict);
      }
      const remoteMemory = await client.getDirectoryContents(`${REMOTE_BASE}/${MEMORY_DIR}`) as any[];
      for (const entry of remoteMemory) {
        if (entry.type !== 'file' || !entry.basename?.endsWith('.md') || localMemory.includes(entry.basename)) continue;
        const localPath = path.join(memoryDir, entry.basename);
        const remotePath = `${REMOTE_BASE}/${MEMORY_DIR}/${entry.basename}`;
        writeTextAtomic(localPath, await client.getFileContents(remotePath, { format: 'text' }) as string);
        downloaded++;
        state.files[`memory:${entry.basename}`] = { localMtime: fs.statSync(localPath).mtimeMs, remoteMtime: await getRemoteMtime(client, remotePath) };
      }
    }

    // ---- Sync Skills and the metadata index, excluding transient artifacts and traces ----
    const skillsDir = path.join(workspaceDir, 'skills');
    const skillsIndex = path.join(workspaceDir, '.iexa-skills.json');
    if (fs.existsSync(skillsIndex)) {
      const result = await syncManagedFile(client, state, workspaceDir, 'skills_index', skillsIndex, `${REMOTE_BASE}/skills-index.json`);
      uploaded += result.uploaded; downloaded += result.downloaded; if (result.conflict) conflicts.push(result.conflict);
    }
    if (fs.existsSync(skillsDir)) {
      const localSkills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((item) => item.isDirectory() && fs.existsSync(path.join(skillsDir, item.name, 'SKILL.md'))).map((item) => item.name);
      for (const id of localSkills) {
        const result = await syncManagedFile(client, state, workspaceDir, `skill:${id}`, path.join(skillsDir, id, 'SKILL.md'), `${REMOTE_BASE}/${SKILLS_DIR}/${id}/SKILL.md`);
        uploaded += result.uploaded; downloaded += result.downloaded; if (result.conflict) conflicts.push(result.conflict);
      }
      const remoteSkills = await client.getDirectoryContents(`${REMOTE_BASE}/${SKILLS_DIR}`) as any[];
      for (const entry of remoteSkills) {
        if (entry.type !== 'directory' || !entry.basename || localSkills.includes(entry.basename)) continue;
        const remotePath = `${REMOTE_BASE}/${SKILLS_DIR}/${entry.basename}/SKILL.md`;
        const localPath = path.join(skillsDir, entry.basename, 'SKILL.md');
        try {
          writeTextAtomic(localPath, await client.getFileContents(remotePath, { format: 'text' }) as string);
          downloaded++;
          state.files[`skill:${entry.basename}`] = { localMtime: fs.statSync(localPath).mtimeMs, remoteMtime: await getRemoteMtime(client, remotePath) };
        } catch { /* an incomplete remote skill is ignored until it becomes valid */ }
      }
    }

    // Update last sync time
    cfg.lastSync = Date.now();
    saveConfig(cfg);

    saveSyncState(workspaceDir, state);
    return { ok: true, uploaded, downloaded, conflicts };
  } catch (err: any) {
    return { ok: false, uploaded, downloaded, conflicts, error: err.message || String(err) };
  }
}

async function syncManagedFile(
  client: WebDAVClient,
  state: SyncState,
  workspaceDir: string,
  key: string,
  localPath: string,
  remotePath: string,
): Promise<{ uploaded: number; downloaded: number; conflict?: SyncConflict }> {
  const localTime = fs.statSync(localPath).mtimeMs;
  const remoteTime = await getRemoteMtime(client, remotePath);
  if (remoteTime > 0 && hasSyncConflict(state.files[key], localTime, remoteTime)) {
    return { uploaded: 0, downloaded: 0, conflict: await preserveRemoteConflict(client, workspaceDir, key, localPath, remotePath) };
  }
  if (remoteTime === 0 || localTime > remoteTime) {
    await ensureRemoteDir(client, path.posix.dirname(remotePath));
    await client.putFileContents(remotePath, fs.readFileSync(localPath, 'utf8'), { overwrite: true });
    state.files[key] = { localMtime: localTime, remoteMtime: Date.now() };
    return { uploaded: 1, downloaded: 0 };
  }
  if (remoteTime > localTime) {
    writeTextAtomic(localPath, await client.getFileContents(remotePath, { format: 'text' }) as string);
    state.files[key] = { localMtime: fs.statSync(localPath).mtimeMs, remoteMtime: remoteTime };
    return { uploaded: 0, downloaded: 1 };
  }
  state.files[key] = { localMtime: localTime, remoteMtime: remoteTime };
  return { uploaded: 0, downloaded: 0 };
}

// ---- Helpers ----
async function ensureRemoteDir(client: WebDAVClient, dirPath: string): Promise<void> {
  try {
    const exists = await client.exists(dirPath);
    if (!exists) {
      // Create directory path piece by piece
      const parts = dirPath.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        const ex = await client.exists(current);
        if (!ex) {
          await client.createDirectory(current);
        }
      }
    }
  } catch {
    // If cannot check, try to create (might already exist)
    try { await client.createDirectory(dirPath); } catch { /* ignore */ }
  }
}

async function getRemoteMtime(client: WebDAVClient, remotePath: string): Promise<number> {
  try {
    const stat: any = await client.stat(remotePath);
    if (stat && stat.lastmod) {
      return new Date(stat.lastmod).getTime();
    }
  } catch { /* file likely doesn't exist */ }
  return 0;
}
